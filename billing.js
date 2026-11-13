/**
 * Turn cost — Host half: billing snapshot.
 *
 * Produces the data the Settings page needs and that no Client-only plugin can
 * obtain on its own:
 *
 *  - every Session's cost, folded from its durable log with the same
 *    `cost-model.js` fold and the same price list the footer uses;
 *  - every Session's display title (the fold already records `session/title`,
 *    so a rename is reflected without extra reads);
 *  - the Workspace each Session belongs to (`workspaceRegistry.list()`), with a
 *    `cwd` fallback for Sessions the registry does not own;
 *  - the DeepSeek account wallets (recharge + bonus, each with a currency) so
 *    the Client can compare a user-set CNY / USD threshold.
 *
 * Everything here is pure aggregation over Host Services passed in by the
 * caller, so it can be exercised from a plain Node test with fakes.
 */
import { foldAll, viewOf } from './cost-model.js';

const SESSION_CACHE_TTL_MS = 30_000;
const ACCOUNT_CACHE_TTL_MS = 30_000;

/** Per-Session fold cache: the fold is deterministic, so a short TTL is safe. */
const sessionCache = new Map();
let stateCache = { at: 0, data: undefined, busy: undefined };

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Fold one Session log; cached by Session id for a short while. */
async function sessionSummary(sessionQuery, sessionId) {
  const hit = sessionCache.get(sessionId);
  if (hit !== undefined && Date.now() - hit.at < SESSION_CACHE_TTL_MS) return hit.value;

  const snapshot = await sessionQuery.readSession(sessionId);
  const inherited = toNumber(snapshot.inheritedEventCount);
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const view = viewOf(foldAll(events, sessionId, inherited));
  const value = {
    sessionId,
    title: typeof view.title === 'string' && view.title.length > 0 ? view.title : '',
    costMicro: toNumber(view.session && view.session.costMicro),
    costUsdMicro: toNumber(view.session && view.session.costUsdMicro),
    turns: toNumber(view.session && view.session.turns),
    pricedTurns: toNumber(view.session && view.session.pricedTurns),
    freeTurns: toNumber(view.session && view.session.freeTurns),
    missingTurns: Array.isArray(view.session && view.session.missingTurns)
      ? view.session.missingTurns.slice()
      : [],
    tokens: toNumber(view.session && view.session.tokens),
    updatedAt: toNumber(view.updatedAt),
    header: snapshot.session || null,
  };
  sessionCache.set(sessionId, { at: Date.now(), value });
  return value;
}

/** Recharge and bonus balances grouped by currency code. */
function walletSums(balance) {
  const recharge = {};
  const bonus = {};
  const add = (target, wallets) => {
    if (!Array.isArray(wallets)) return;
    for (const wallet of wallets) {
      const currency = typeof wallet?.currency === 'string' ? wallet.currency : '';
      if (currency === '') continue;
      const amount = Math.max(0, toNumber(wallet.balance));
      target[currency] = (target[currency] || 0) + amount;
    }
  };
  add(recharge, balance && balance.value);
  add(bonus, balance && balance.bonusWallets);
  const currencies = Array.from(new Set([...Object.keys(recharge), ...Object.keys(bonus)]));
  return {
    status: balance && balance.status === 'ready' ? 'ready' : 'unavailable',
    wallets: currencies.map((currency) => {
      const rechargeBalance = recharge[currency] || 0;
      const bonusBalance = bonus[currency] || 0;
      return {
        currency,
        recharge: rechargeBalance,
        bonus: bonusBalance,
        total: rechargeBalance + bonusBalance,
      };
    }),
  };
}

/** Query the account balances; failures stay inside the snapshot. */
async function accountSummary(ctx) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined;
  if (account === undefined) return { status: 'unavailable', wallets: [], error: 'account service unavailable' };
  try {
    const balance = await account.getBalance({
      version: '0.3.0',
      locale: 'zh',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    });
    if (balance === null) return { status: 'signed-out', wallets: [] };
    const sums = walletSums(balance);
    return sums;
  } catch (error) {
    return {
      status: 'unavailable',
      wallets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Register each Session under its Workspace (registry first, cwd second). */
function buildWorkspaceIndex(workspaces) {
  const bySession = new Map();
  const byPath = new Map();
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== 'object') continue;
    const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
    for (const sessionId of ids) bySession.set(String(sessionId), workspace);
    if (typeof workspace.path === 'string' && workspace.path !== '') {
      byPath.set(workspace.path.replace(/[\\/]+$/, ''), workspace);
    }
  }
  // Deepest path first, so a Session started in a subdirectory of a Workspace
  // still lands in the nearest enclosing Workspace.
  const paths = [...byPath.keys()].sort((a, b) => b.length - a.length);
  return { bySession, byPath, paths };
}

function workspaceOf(index, summary) {
  const direct = index.bySession.get(summary.sessionId);
  if (direct !== undefined) return direct;
  const cwd = summary.header && typeof summary.header.cwd === 'string' ? summary.header.cwd : '';
  if (cwd === '') return undefined;
  const normalized = cwd.replace(/[\\/]+$/, '');
  const exact = index.byPath.get(normalized);
  if (exact !== undefined) return exact;
  for (const path of index.paths || []) {
    if (normalized === path || normalized.startsWith(path + '/') || normalized.startsWith(path + '\\')) {
      return index.byPath.get(path);
    }
  }
  return undefined;
}

function displayPath(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? String(path || '') : parts[parts.length - 1];
}

/** Build the full snapshot (expensive: reads every Session once per TTL). */
async function buildFullState(ctx) {
  const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;

  if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') {
    return { sessions: [], workspaces: [], totals: { costMicro: 0, costUsdMicro: 0, sessions: 0 }, degraded: 'session service unavailable' };
  }

  const records = await sessionQuery.listSessions();
  const workspaceIndex = buildWorkspaceIndexSafe(registry);
  const sessions = [];
  for (const record of Array.isArray(records) ? records : []) {
    const header = record && record.header ? record.header : undefined;
    const sessionId = header && header.id !== undefined ? String(header.id) : '';
    if (sessionId === '') continue;
    try {
      const summary = await sessionSummary(sessionQuery, sessionId);
      sessions.push({
        sessionId,
        title: summary.title,
        cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: toNumber(header && header.createdAt),
        live: record.live === true,
        costMicro: summary.costMicro,
        costUsdMicro: summary.costUsdMicro,
        turns: summary.turns,
        pricedTurns: summary.pricedTurns,
        freeTurns: summary.freeTurns,
        missingTurns: summary.missingTurns,
        tokens: summary.tokens,
        updatedAt: summary.updatedAt,
        error: null,
        workspace: workspaceOf(workspaceIndex, summary) ?? null,
      });
    } catch (error) {
      sessions.push({
        sessionId,
        title: '',
        cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: toNumber(header && header.createdAt),
        live: record.live === true,
        costMicro: 0,
        costUsdMicro: 0,
        turns: 0,
        pricedTurns: 0,
        missingTurns: [],
        tokens: 0,
        updatedAt: 0,
        error: error instanceof Error ? error.message : String(error),
        workspace: null,
      });
    }
  }

  const workspaces = [];
  const seen = new Set();
  for (const session of sessions) {
    const workspace = session.workspace;
    if (workspace === null || workspace === undefined) continue;
    const id = String(workspace.id);
    if (seen.has(id)) continue;
    seen.add(id);
    workspaces.push({
      id,
      title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : displayPath(workspace.path),
      path: typeof workspace.path === 'string' ? workspace.path : '',
      costMicro: 0,
      costUsdMicro: 0,
      sessions: 0,
    });
  }
  for (const workspace of workspaces) {
    for (const session of sessions) {
      if (session.workspace !== null && String(session.workspace.id) === workspace.id) {
        workspace.costMicro += session.costMicro;
        workspace.costUsdMicro += session.costUsdMicro;
        workspace.sessions += 1;
      }
    }
  }
  // Sessions that no Workspace owns still group under their own directory.
  const extra = new Map();
  for (const session of sessions) {
    if (session.workspace !== null) continue;
    const cwd = session.cwd || '';
    if (!extra.has(cwd)) {
      extra.set(cwd, {
        id: 'cwd:' + cwd,
        title: cwd === '' ? '' : displayPath(cwd),
        path: cwd,
        costMicro: 0,
        costUsdMicro: 0,
        sessions: 0,
      });
    }
    const group = extra.get(cwd);
    group.costMicro += session.costMicro;
    group.costUsdMicro += session.costUsdMicro;
    group.sessions += 1;
  }
  workspaces.push(...extra.values());

  const totals = { costMicro: 0, costUsdMicro: 0, sessions: sessions.length };
  for (const session of sessions) {
    totals.costMicro += session.costMicro;
    totals.costUsdMicro += session.costUsdMicro;
  }
  return { sessions, workspaces, totals, degraded: null };
}

function buildWorkspaceIndexSafe(registry) {
  if (registry === undefined || typeof registry.list !== 'function') return { bySession: new Map(), byPath: new Map() };
  try {
    return buildWorkspaceIndex(registry.list());
  } catch {
    return { bySession: new Map(), byPath: new Map() };
  }
}

/**
 * Read the snapshot the Client polls. `scope` is 'balance' for the reminder
 * only (one account call) and 'full' for the Settings page.
 */
export async function readBillingState(ctx, scope) {
  const wantFull = scope === 'full';
  const now = Date.now();
  const cached = stateCache.data;
  if (
    cached !== undefined &&
    now - stateCache.at < SESSION_CACHE_TTL_MS &&
    (!wantFull || Array.isArray(cached.sessions))
  ) {
    return cached;
  }
  if (stateCache.busy !== undefined) {
    // A cheaper balance read may be in flight; wait for it, then re-evaluate
    // whether the fuller snapshot is still needed.
    try {
      await stateCache.busy;
    } catch {
      // fall through and retry ourselves
    }
    return readBillingState(ctx, scope);
  }

  stateCache.busy = (async () => {
    const account = await accountSummary(ctx);
    const full = wantFull ? await buildFullState(ctx) : undefined;
    const data = {
      v: 1,
      priceVersion: 'deepseek-cny-2026-11-11',
      updatedAt: Date.now(),
      account,
      ...(full === undefined
        ? {}
        : { sessions: full.sessions, workspaces: full.workspaces, totals: full.totals, degraded: full.degraded }),
    };
    stateCache = { at: Date.now(), data, busy: undefined };
    return data;
  })();

  try {
    return await stateCache.busy;
  } finally {
    stateCache.busy = undefined;
  }
}

/** Force the next read to rebuild (used by tests and manual refreshes). */
export function resetBillingCache() {
  sessionCache.clear();
  stateCache = { at: 0, data: undefined, busy: undefined };
}

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  const name = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0];
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  // The desktop renders the Web UI from a custom scheme (dsh-app://app), whose
  // forwarded requests carry a single-label authority rather than a loopback IP.
  // Single-label names cannot be reached by DNS rebinding, so accepting them is
  // safe; a dotted name that is not a loopback address stays rejected.
  return name !== '' && !name.includes('.');
}

/** GET /api/turn-cost/state — the only Host→Client channel this plugin has. */
export async function handleStateRequest(ctx, request) {
  const url = new URL(request.url, 'http://localhost');
  const host = request.headers.get('host');
  if (host !== null && host !== '' && !isLoopbackHost(host)) {
    return new Response('forbidden', { status: 403 });
  }
  // Same-origin fetches attach this header; a plain <img>/<script> probe cannot.
  if (request.headers.get('x-dsh-turn-cost') !== '1') {
    return new Response('forbidden', { status: 403 });
  }
  const scope = url.searchParams.get('scope') === 'full' ? 'full' : 'balance';
  try {
    const data = await readBillingState(ctx, scope);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(new Error(`turn-cost: state failed: ${message}`));
    return new Response(JSON.stringify({ v: 1, error: message }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

export const STATE_ROUTE = '/api/turn-cost/state';
