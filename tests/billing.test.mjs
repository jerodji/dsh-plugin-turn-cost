/**
 * billing.js — Host aggregation: session summary, workspace rollup, the
 * /api/turn-cost/state guard, and the `tokens` regression.
 *
 * Run: node tests/billing.test.mjs
 */
import assert from 'node:assert/strict';
import {
  STATE_ROUTE,
  handleStateRequest,
  readBillingState,
  resetBillingCache,
} from '../billing.js';

const results = [];
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    failed += 1;
    results.push({ name, ok: false, error });
  }
}

const MONDAY_PEAK = Date.UTC(2026, 10, 16, 2, 0); // 10:00 Beijing
const MONDAY_OFFPEAK = Date.UTC(2026, 10, 16, 4, 0); // 12:00 Beijing

const USAGE = {
  inputTokens: 500_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 250_000,
  outputTokens: 100_000,
  totalTokens: 1_850_000,
};

function eventsFor(turn, { time = MONDAY_PEAK, model = 'deepseek-v4-flash', provider = 'deepseek' } = {}) {
  return [
    { seq: turn * 10, type: 'turn/start', time, data: { turn } },
    {
      seq: turn * 10 + 1,
      type: 'assistant/message',
      time: time + 1000,
      data: { turn, step: 0, usage: USAGE, source: { provider, model } },
    },
    { seq: turn * 10 + 2, type: 'turn/end', time: time + 2000, data: { turn } },
  ];
}

function fakeCtx({ sessions, workspaces = [], balance = null, failSessions = [] } = {}) {
  const reads = new Map();
  const listCalls = { value: 0 };
  const query = {
    async listSessions() {
      listCalls.value += 1;
      return sessions.map((session) => ({ header: session.header, live: session.live === true }));
    },
    async readSession(id) {
      reads.set(id, (reads.get(id) || 0) + 1);
      if (failSessions.includes(id)) throw new Error(`cannot read ${id}`);
      const session = sessions.find((item) => item.header.id === id);
      return { inheritedEventCount: 0, events: session ? session.events : [], session: session ? session.header : undefined };
    },
  };
  const services = {
    sessionQuery: query,
    workspaceRegistry: { list: () => workspaces },
    deepseekAccount: {
      async getBalance() {
        return balance;
      },
    },
  };
  return {
    ctx: { get: (name) => services[name], logger: { warn() {} } },
    listCalls,
    reads,
  };
}

const SESSION_A = {
  header: { id: 'sess-a', cwd: '/work/project-a', createdAt: 1000 },
  events: [...eventsFor(1), ...eventsFor(2, { time: MONDAY_OFFPEAK })],
};
const SESSION_B = {
  header: { id: 'sess-b', cwd: '/work/project-a/sub/dir', createdAt: 2000 },
  events: eventsFor(1, { model: 'deepseek-v4-pro' }),
};
const SESSION_C = {
  header: { id: 'sess-c', cwd: '/elsewhere', createdAt: 3000 },
  events: eventsFor(1, { provider: 'acme', model: 'mystery' }),
};

await test('full state: per-session costs, workspace grouping, totals', async () => {
  resetBillingCache();
  const { ctx } = fakeCtx({
    sessions: [SESSION_A, SESSION_B, SESSION_C],
    workspaces: [{ id: 'ws-a', title: 'Project A', path: '/work/project-a', sessionIds: [] }],
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: 88.5 }], bonusWallets: [] },
  });
  const data = await readBillingState(ctx, 'full');
  assert.equal(data.v, 1);
  assert.equal(data.priceVersion, 'deepseek-cny-2026-11-11');
  assert.equal(data.account.status, 'ready');
  assert.equal(data.account.wallets[0].currency, 'CNY');
  assert.equal(data.account.wallets[0].recharge, 88.5);

  const a = data.sessions.find((s) => s.sessionId === 'sess-a');
  const b = data.sessions.find((s) => s.sessionId === 'sess-b');
  const c = data.sessions.find((s) => s.sessionId === 'sess-c');
  assert.equal(a.costMicro, 2_340_000 + 1_170_000);
  assert.equal(a.turns, 2);
  assert.equal(a.pricedTurns, 2);
  assert.equal(b.costMicro, 9_750_000);
  assert.equal(c.costMicro, 0);
  assert.deepEqual(c.missingTurns, [1]);

  // sess-b lives in a subdirectory: it must roll up to the deepest workspace.
  assert.equal(b.workspace.id, 'ws-a');
  assert.equal(a.workspace.id, 'ws-a');
  assert.equal(c.workspace, null);
  const wsA = data.workspaces.find((w) => w.id === 'ws-a');
  assert.equal(wsA.sessions, 2);
  assert.equal(wsA.costMicro, 13_260_000);
  const cwdGroup = data.workspaces.find((w) => w.id === 'cwd:/elsewhere');
  assert.equal(cwdGroup.sessions, 1);
  assert.equal(data.totals.sessions, 3);
  assert.equal(data.totals.costMicro, 13_260_000);
  assert.equal(data.degraded, null);
});

await test('sessionSummary exposes the folded session token total', async () => {
  resetBillingCache();
  const { ctx } = fakeCtx({ sessions: [SESSION_A], balance: null });
  const data = await readBillingState(ctx, 'full');
  // The fold produced 3,700,000 session tokens (1.85M per turn); the summary
  // must unwrap `session.tokens.total` instead of coercing the bucket object.
  assert.equal(data.sessions[0].tokens, 3_700_000);
});

await test('balance scope omits sessions and is cached for 30 s', async () => {
  resetBillingCache();
  const { ctx, listCalls } = fakeCtx({ sessions: [SESSION_A], balance: { status: 'ready', value: [], bonusWallets: [] } });
  const first = await readBillingState(ctx, 'balance');
  assert.equal(first.sessions, undefined);
  assert.ok(first.account);
  const second = await readBillingState(ctx, 'balance');
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(listCalls.value, 0, 'balance scope must not list sessions');
});

await test('a balance snapshot is upgraded by a later full request within the TTL', async () => {
  resetBillingCache();
  const { ctx, listCalls } = fakeCtx({ sessions: [SESSION_A], balance: null });
  await readBillingState(ctx, 'balance');
  const full = await readBillingState(ctx, 'full');
  assert.ok(Array.isArray(full.sessions));
  assert.equal(full.sessions.length, 1);
  assert.equal(listCalls.value, 1);
});

await test('a failing session is reported with error and zero amounts', async () => {
  resetBillingCache();
  const { ctx } = fakeCtx({ sessions: [SESSION_A, SESSION_B], failSessions: ['sess-b'] });
  const data = await readBillingState(ctx, 'full');
  const b = data.sessions.find((s) => s.sessionId === 'sess-b');
  assert.equal(b.costMicro, 0);
  assert.equal(b.error, 'cannot read sess-b');
  assert.equal(data.totals.sessions, 2);
});

await test('degraded when the session service is unavailable', async () => {
  resetBillingCache();
  const ctx = { get: () => undefined };
  const data = await readBillingState(ctx, 'full');
  assert.equal(data.degraded, 'session service unavailable');
  assert.deepEqual(data.sessions, []);
  assert.equal(data.totals.sessions, 0);
});

/* ------------------------------------------------------------------ */
/* HTTP guard                                                          */
/* ------------------------------------------------------------------ */

function request(url, headers) {
  return new Request(url, { headers });
}

await test('state route requires the same-origin marker header', async () => {
  resetBillingCache();
  const { ctx } = fakeCtx({ sessions: [], balance: null });
  const missing = await handleStateRequest(ctx, request('http://127.0.0.1:1' + STATE_ROUTE, {}));
  assert.equal(missing.status, 403);
  const wrong = await handleStateRequest(
    ctx,
    request('http://127.0.0.1:1' + STATE_ROUTE, { 'x-dsh-turn-cost': '0' }),
  );
  assert.equal(wrong.status, 403);
  const ok = await handleStateRequest(
    ctx,
    request('http://127.0.0.1:1' + STATE_ROUTE + '?scope=full', { 'x-dsh-turn-cost': '1' }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = await ok.json();
  assert.equal(body.v, 1);
  assert.ok(Array.isArray(body.sessions));
});

await test('state route rejects a non-loopback Host header', async () => {
  resetBillingCache();
  const { ctx } = fakeCtx({ sessions: [], balance: null });
  const blocked = await handleStateRequest(
    ctx,
    request('http://evil.example' + STATE_ROUTE, { host: 'evil.example', 'x-dsh-turn-cost': '1' }),
  );
  assert.equal(blocked.status, 403);
  const allowed = await handleStateRequest(
    ctx,
    request('http://127.0.0.1:1' + STATE_ROUTE, { host: '127.0.0.1:1', 'x-dsh-turn-cost': '1' }),
  );
  assert.equal(allowed.status, 200);
});

await test('an internal failure returns JSON 500 with the error text', async () => {
  resetBillingCache();
  const ctx = {
    get(name) {
      if (name === 'deepseekAccount') return { async getBalance() { throw new Error('account down'); } };
      if (name === 'sessionQuery') {
        return {
          async listSessions() { throw new Error('session store down'); },
          async readSession() { return { events: [] }; },
        };
      }
      return undefined;
    },
    logger: { warn() {} },
  };
  const response = await handleStateRequest(
    ctx,
    request('http://127.0.0.1:1' + STATE_ROUTE + '?scope=full', { 'x-dsh-turn-cost': '1' }),
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'session store down');
});

for (const result of results) {
  if (result.ok) console.log(`PASS  ${result.name}`);
  else {
    console.log(`FAIL  ${result.name}`);
    console.log(`      ${String(result.error && result.error.message).split('\n').join('\n      ')}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
