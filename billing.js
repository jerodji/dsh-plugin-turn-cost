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
/** Bounded fold cache; every Session loaded by the dashboard is one entry. */
const SESSION_CACHE_LIMIT = 200;

/** Per-Session fold cache: the fold is deterministic, so a short TTL is safe. */
const sessionCache = new Map();
/** Independent snapshots: the reminder's balance and the dashboard's full list. */
const stateCaches = {
  balance: { at: 0, data: undefined, busy: undefined },
  full: { at: 0, data: undefined, busy: undefined },
};

/** Per-parent-Session cache of the `subagents` scope snapshot. */
const SUBAGENT_CACHE_TTL_MS = 30_000;
const SUBAGENT_CACHE_LIMIT = 50;
const subagentCaches = new Map();

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Fold one Session log; cached by Session id for a short while. */
async function sessionSummary(sessionQuery, sessionId, withTurns = false) {
  const hit = sessionCache.get(sessionId);
  if (
    hit !== undefined &&
    Date.now() - hit.at < SESSION_CACHE_TTL_MS &&
    (!withTurns || Array.isArray(hit.value.turnList))
  ) {
    return hit.value;
  }

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
    planTurns: toNumber(view.session && view.session.planTurns),
    missingTurns: Array.isArray(view.session && view.session.missingTurns)
      ? view.session.missingTurns.slice()
      : [],
    // `session.tokens` is the bucket object from the fold; the dashboard needs
    // the total, so unwrap it instead of coercing the object (which gave NaN/0).
    tokens: toNumber(view.session && view.session.tokens && view.session.tokens.total),
    updatedAt: toNumber(view.updatedAt),
    header: snapshot.session || null,
  };
  if (withTurns) {
    // Compact per-turn rows for subagent attribution. Only ended turns can be
    // attributed to a parent turn window; the Client decides the window.
    value.turnList = (Array.isArray(view.turns) ? view.turns : [])
      .map((turn) => ({
        turn: toNumber(turn && turn.turn),
        startedAt: toNumber(turn && turn.startedAt),
        endedAt: toNumber(turn && turn.endedAt),
        costMicro:
          turn && turn.costMicro !== null && turn.costMicro !== undefined ? toNumber(turn.costMicro) : null,
        plan: Boolean(turn && turn.plan === true),
      }))
      .filter((turn) => turn.endedAt > 0);
  }
  // Refresh the insertion order on every write, then bound the cache.
  sessionCache.delete(sessionId);
  sessionCache.set(sessionId, { at: Date.now(), value });
  if (sessionCache.size > SESSION_CACHE_LIMIT) {
    sessionCache.delete(sessionCache.keys().next().value);
  }
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
        parentSession: header && typeof header.parentSession === 'string' ? header.parentSession : '',
        subagent: header !== undefined && header.origin === 'subagent',
        title: summary.title,
        cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: toNumber(header && header.createdAt),
        live: record.live === true,
        costMicro: summary.costMicro,
        costUsdMicro: summary.costUsdMicro,
        subagentCostMicro: 0,
        subagentCostUsdMicro: 0,
        subagentSessions: 0,
        totalCostMicro: summary.costMicro,
        totalCostUsdMicro: summary.costUsdMicro,
        turns: summary.turns,
        pricedTurns: summary.pricedTurns,
        freeTurns: summary.freeTurns,
        planTurns: summary.planTurns,
        missingTurns: summary.missingTurns,
        tokens: summary.tokens,
        updatedAt: summary.updatedAt,
        lastActivityAt: Math.max(toNumber(header && header.createdAt), toNumber(summary.updatedAt)),
        error: null,
        workspace: workspaceOf(workspaceIndex, summary) ?? null,
      });
    } catch (error) {
      sessions.push({
        sessionId,
        parentSession: header && typeof header.parentSession === 'string' ? header.parentSession : '',
        subagent: header !== undefined && header.origin === 'subagent',
        title: '',
        cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: toNumber(header && header.createdAt),
        live: record.live === true,
        costMicro: 0,
        costUsdMicro: 0,
        subagentCostMicro: 0,
        subagentCostUsdMicro: 0,
        subagentSessions: 0,
        totalCostMicro: 0,
        totalCostUsdMicro: 0,
        turns: 0,
        pricedTurns: 0,
        freeTurns: 0,
        planTurns: 0,
        missingTurns: [],
        tokens: 0,
        updatedAt: 0,
        lastActivityAt: toNumber(header && header.createdAt),
        error: error instanceof Error ? error.message : String(error),
        workspace: null,
      });
    }
  }

  // Fold subagent Sessions into their ancestors. Only headers already read
  // above are used, so this adds no log reads. A record whose parentSession
  // does not resolve to another row of this list stays at the top level, as
  // does a session whose ancestry is a cycle or exceeds the depth cap (both
  // are treated as dirty data and not aggregated into anyone).
  const MAX_ANCESTOR_DEPTH = 256;
  const byId = new Map();
  for (const session of sessions) byId.set(session.sessionId, session);
  const ancestryOf = (session) => {
    const ancestors = [];
    const seen = new Set([session.sessionId]);
    let current = session;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      if (current.parentSession === '') return { ancestors, terminates: true };
      const parent = byId.get(current.parentSession);
      if (parent === undefined) return { ancestors, terminates: true };
      if (seen.has(parent.sessionId)) return { ancestors, terminates: false };
      seen.add(parent.sessionId);
      ancestors.push(parent);
      current = parent;
    }
    return { ancestors, terminates: false };
  };

  // Two-phase visibility. Phase one picks the rows that can be shown: every
  // plain Session/fork, plus a real subagent whose parent chain is broken,
  // missing, cyclic or too deep (dirty data is never hidden).
  const visible = new Set();
  for (const session of sessions) {
    if (session.subagent !== true) {
      visible.add(session.sessionId);
      continue;
    }
    if (session.parentSession === '' || !byId.has(session.parentSession)) {
      visible.add(session.sessionId);
      continue;
    }
    if (ancestryOf(session).terminates === false) visible.add(session.sessionId);
  }

  // Phase two folds each hidden subagent into its nearest *visible* ancestor,
  // not into every ancestor: a fork in the middle of the chain is visible, so
  // money is counted once (its own row), never again on the fork's ancestors.
  // Parents are processed before children (shorter ancestor chain first) so a
  // promoted row can collect its own descendants in the same pass.
  const hidden = sessions
    .filter((session) => !visible.has(session.sessionId))
    .map((session) => ({ session, ancestors: ancestryOf(session).ancestors }))
    .sort((a, b) => a.ancestors.length - b.ancestors.length);
  for (const entry of hidden) {
    const session = entry.session;
    const ancestor = entry.ancestors.find((candidate) => visible.has(candidate.sessionId));
    if (ancestor === undefined) {
      visible.add(session.sessionId);
      continue;
    }
    if (ancestor.error !== null) {
      // That row renders 「—」 (its own log failed to load); absorbing child
      // money would hide it. Promote the child instead, so it stays visible.
      visible.add(session.sessionId);
      continue;
    }
    ancestor.subagentCostMicro += session.costMicro;
    ancestor.subagentCostUsdMicro += session.costUsdMicro;
    ancestor.subagentSessions += 1;
    ancestor.lastActivityAt = Math.max(ancestor.lastActivityAt, session.lastActivityAt);
  }
  for (const session of sessions) {
    session.totalCostMicro = session.costMicro + session.subagentCostMicro;
    session.totalCostUsdMicro = session.costUsdMicro + session.subagentCostUsdMicro;
  }
  // Only the visible rows are listed; every hidden descendant's own cost is
  // represented exactly once in its nearest visible ancestor's total.
  const topLevel = sessions.filter((session) => visible.has(session.sessionId));

  const workspaces = [];
  const seen = new Set();
  for (const session of topLevel) {
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
    for (const session of topLevel) {
      if (session.workspace !== null && String(session.workspace.id) === workspace.id) {
        workspace.costMicro += session.totalCostMicro;
        workspace.costUsdMicro += session.totalCostUsdMicro;
        workspace.sessions += 1;
      }
    }
  }
  // Sessions that no Workspace owns still group under their own directory.
  const extra = new Map();
  for (const session of topLevel) {
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
    group.costMicro += session.totalCostMicro;
    group.costUsdMicro += session.totalCostUsdMicro;
    group.sessions += 1;
  }
  workspaces.push(...extra.values());

  const totals = { costMicro: 0, costUsdMicro: 0, sessions: topLevel.length };
  for (const session of topLevel) {
    totals.costMicro += session.totalCostMicro;
    totals.costUsdMicro += session.totalCostUsdMicro;
  }
  return { sessions: topLevel, workspaces, totals, degraded: null };
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
 * Every descendant Session of `sessionId` (subagents, any depth) with compact
 * per-turn costs. Costs are folded per child with the same model/price list the
 * footer uses; names are intentionally not resolved here (the Client owns the
 * `team/member` display-name mapping).
 */
async function buildSubagentsState(ctx, sessionId) {
  const priceVersion = 'deepseek-cny-2026-11-11';
  const snapshot = (sessions, degraded) => ({
    v: 1,
    scope: 'subagents',
    sessionId,
    priceVersion,
    updatedAt: Date.now(),
    sessions,
    degraded,
  });

  const sessionQuery = ctx.get('sessionQuery');
  if (
    sessionQuery === undefined ||
    sessionQuery === null ||
    typeof sessionQuery.listSessions !== 'function' ||
    typeof sessionQuery.readSession !== 'function'
  ) {
    return snapshot([], 'session service unavailable');
  }

  let records = [];
  try {
    const listed = await sessionQuery.listSessions();
    records = Array.isArray(listed) ? listed : [];
  } catch {
    return snapshot([], 'session list unavailable');
  }

  // The header index is all that is needed to discover the child Sessions; the
  // per-child `readSession` below reuses the Session fold cache.
  const headerById = new Map();
  const childrenByParent = new Map();
  for (const record of records) {
    const header = record && record.header;
    const id = header && typeof header.id === 'string' ? header.id : '';
    if (id === '') continue;
    headerById.set(id, header);
    const parentId = typeof header.parentSession === 'string' ? header.parentSession : '';
    if (parentId === '') continue;
    // A plain fork may also keep its source in `parentSession`; only real
    // subagent Sessions belong in the parent's subagent tree.
    if (header.origin !== 'subagent') continue;
    const known = childrenByParent.get(parentId);
    if (known === undefined) childrenByParent.set(parentId, [id]);
    else known.push(id);
  }

  const descendants = [];
  const seen = new Set([sessionId]);
  const queue = [sessionId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    const childIds = childrenByParent.get(parentId);
    if (!Array.isArray(childIds)) continue;
    for (const childId of childIds) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      descendants.push(childId);
      queue.push(childId);
    }
  }
  const createdAtOf = (id) => toNumber(headerById.get(id) && headerById.get(id).createdAt);
  descendants.sort((a, b) => createdAtOf(a) - createdAtOf(b) || String(a).localeCompare(String(b)));

  const sessions = [];
  for (const id of descendants) {
    const header = headerById.get(id) || {};
    let summary;
    try {
      summary = await sessionSummary(sessionQuery, id, true);
    } catch {
      // One unreadable child log must not hide the other subagents.
      summary = undefined;
    }
    sessions.push({
      id,
      title:
        summary !== undefined && typeof summary.title === 'string' && summary.title !== ''
          ? summary.title
          : typeof header.title === 'string'
            ? header.title
            : '',
      origin: typeof header.origin === 'string' ? header.origin : '',
      delegationDepth: toNumber(header.delegationDepth),
      createdAt: toNumber(header.createdAt),
      costMicro: summary !== undefined ? summary.costMicro : 0,
      costUsdMicro: summary !== undefined ? summary.costUsdMicro : 0,
      planOnly: summary !== undefined && summary.pricedTurns === 0 && summary.planTurns > 0,
      turns: summary !== undefined && Array.isArray(summary.turnList) ? summary.turnList : [],
    });
  }
  return snapshot(sessions, false);
}

/**
 * Read the snapshot the Client polls. `scope` is 'balance' for the reminder
 * only (one account call), 'full' for the Settings page, and 'subagents' for
 * one Session's descendant Sessions (needs `sessionId`).
 */
export async function readBillingState(ctx, scope, sessionId, force = false) {
  if (scope === 'subagents') {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (id === '') throw new Error('sessionId is required for the subagents scope');
    const cached = subagentCaches.get(id);
    const now = Date.now();
    if (cached !== undefined && cached.data !== undefined && now - cached.at < SUBAGENT_CACHE_TTL_MS) {
      // LRU: a hit refreshes the insertion order.
      subagentCaches.delete(id);
      subagentCaches.set(id, { at: cached.at, data: cached.data, busy: undefined });
      return cached.data;
    }
    if (cached !== undefined && cached.busy !== undefined) {
      try {
        await cached.busy;
      } catch {
        // fall through and retry ourselves
      }
      return readBillingState(ctx, scope, id);
    }
    const slot = { at: cached !== undefined ? cached.at : 0, data: cached !== undefined ? cached.data : undefined, busy: undefined };
    slot.busy = (async () => {
      try {
        const data = await buildSubagentsState(ctx, id);
        slot.at = Date.now();
        slot.data = data;
        return data;
      } finally {
        slot.busy = undefined;
      }
    })();
    subagentCaches.delete(id);
    subagentCaches.set(id, slot);
    // Evict the oldest entry when the cache grows too large (the slot just read
    // was re-inserted last, so the oldest key is a different Session).
    if (subagentCaches.size > SUBAGENT_CACHE_LIMIT) {
      const oldest = subagentCaches.keys().next();
      if (!oldest.done && oldest.value !== id) subagentCaches.delete(oldest.value);
    }
    try {
      return await slot.busy;
    } finally {
      if (slot.busy !== undefined) slot.busy = undefined;
    }
  }

  const wantFull = scope === 'full';
  // Independent cache slots: a balance poll must not evict the dashboard's
  // full list (and vice versa).
  const cache = wantFull ? stateCaches.full : stateCaches.balance;
  const fresh = () => {
    if (force) return false; // explicit refresh: rebuild from the live services
    if (cache.data === undefined) return false;
    if (Date.now() - cache.at >= SESSION_CACHE_TTL_MS) return false;
    return !wantFull || Array.isArray(cache.data.sessions);
  };
  if (fresh()) return cache.data;
  if (cache.busy !== undefined) {
    // A forced refresh joins the in-flight read (it just started) instead of
    // stacking a duplicate account call on top of it.
    if (force) return cache.busy;
    // Wait for the in-flight read of this same scope, then decide again.
    try {
      await cache.busy;
    } catch {
      // fall through and retry ourselves
    }
    if (fresh()) return cache.data;
  }

  const build = (async () => {
    const account = await accountSummary(ctx);
    const full = wantFull ? await buildFullState(ctx) : undefined;
    return {
      v: 1,
      priceVersion: 'deepseek-cny-2026-11-11',
      updatedAt: Date.now(),
      account,
      ...(full === undefined
        ? {}
        : { sessions: full.sessions, workspaces: full.workspaces, totals: full.totals, degraded: full.degraded }),
    };
  })();
  cache.busy = build;

  try {
    const data = await build;
    cache.at = Date.now();
    cache.data = data;
    return data;
  } finally {
    if (cache.busy === build) cache.busy = undefined;
  }
}

/** Force the next read to rebuild (used by tests and manual refreshes). */
export function resetBillingCache() {
  sessionCache.clear();
  subagentCaches.clear();
  stateCaches.balance = { at: 0, data: undefined, busy: undefined };
  stateCaches.full = { at: 0, data: undefined, busy: undefined };
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
  const scopeParam = url.searchParams.get('scope');
  const scope = scopeParam === 'full' || scopeParam === 'subagents' ? scopeParam : 'balance';
  const sessionId = scope === 'subagents' ? String(url.searchParams.get('sessionId') || '').trim() : '';
  const fresh = url.searchParams.get('fresh') === '1';
  if (scope === 'subagents' && (sessionId === '' || sessionId.length > 200 || /[\u0000-\u001f]/.test(sessionId))) {
    return new Response(JSON.stringify({ v: 1, error: 'invalid sessionId' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  try {
    const data = await readBillingState(ctx, scope, sessionId, fresh);
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
