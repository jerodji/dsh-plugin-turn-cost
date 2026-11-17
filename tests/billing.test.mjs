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
import { setPlanProviders } from '../cost-model.js';

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

/* ------------------------------------------------------------------ */
/* subagents scope                                                     */
/* ------------------------------------------------------------------ */

const SUB_PARENT = {
  header: { id: 'parent', cwd: '/work', createdAt: 100 },
  events: eventsFor(1),
};
const SUB_CHILD = {
  header: {
    id: 'child-1',
    parentSession: 'parent',
    origin: 'subagent',
    delegationDepth: 1,
    title: 'fix the bug',
    createdAt: 200,
  },
  events: [...eventsFor(1), ...eventsFor(2, { time: MONDAY_OFFPEAK })],
};
const SUB_CHILD_PLAN = {
  header: {
    id: 'child-2',
    parentSession: 'parent',
    origin: 'subagent',
    delegationDepth: 1,
    createdAt: 250,
  },
  events: eventsFor(1, { provider: 'chatgpt', model: 'gpt-5' }),
};
const SUB_GRANDCHILD = {
  header: {
    id: 'grand-1',
    parentSession: 'child-1',
    origin: 'subagent',
    delegationDepth: 2,
    createdAt: 300,
  },
  events: eventsFor(1),
};
const SUB_RUNNING = {
  header: { id: 'child-3', parentSession: 'parent', origin: 'subagent', delegationDepth: 1, createdAt: 400 },
  // Turn started but not ended yet.
  events: [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: MONDAY_PEAK + 1000,
      data: { turn: 1, step: 0, usage: USAGE, source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
  ],
};
const SUB_UNRELATED = {
  header: { id: 'other', createdAt: 500 },
  events: eventsFor(1),
};

await test('subagents scope lists descendants with compact ended turns', async () => {
  resetBillingCache();
  setPlanProviders(['chatgpt']);
  try {
    const fake = fakeCtx({
      sessions: [SUB_PARENT, SUB_CHILD, SUB_CHILD_PLAN, SUB_GRANDCHILD, SUB_RUNNING, SUB_UNRELATED],
    });
    const data = await readBillingState(fake.ctx, 'subagents', 'parent');
    assert.equal(data.v, 1);
    assert.equal(data.scope, 'subagents');
    assert.equal(data.sessionId, 'parent');
    assert.equal(data.priceVersion, 'deepseek-cny-2026-11-11');
    assert.equal(data.degraded, false);
    // Descendants at any depth, ordered by creation time; unrelated excluded.
    assert.deepEqual(
      data.sessions.map((session) => session.id),
      ['child-1', 'child-2', 'grand-1', 'child-3'],
    );

    const child = data.sessions[0];
    assert.equal(child.title, 'fix the bug');
    assert.equal(child.origin, 'subagent');
    assert.equal(child.delegationDepth, 1);
    assert.equal(child.createdAt, 200);
    assert.equal(child.costMicro, 2_340_000 + 1_170_000);
    assert.equal(child.costUsdMicro, 351_000 + 175_500);
    assert.equal(child.planOnly, false);
    assert.deepEqual(child.turns, [
      { turn: 1, startedAt: MONDAY_PEAK, endedAt: MONDAY_PEAK + 2000, costMicro: 2_340_000, plan: false },
      { turn: 2, startedAt: MONDAY_OFFPEAK, endedAt: MONDAY_OFFPEAK + 2000, costMicro: 1_170_000, plan: false },
    ]);

    const planChild = data.sessions[1];
    assert.equal(planChild.costMicro, 0);
    assert.equal(planChild.planOnly, true);
    assert.equal(planChild.turns.length, 1);
    assert.equal(planChild.turns[0].plan, true);
    assert.equal(planChild.turns[0].costMicro, null);

    const grandchild = data.sessions[2];
    assert.equal(grandchild.delegationDepth, 2);
    assert.equal(grandchild.costMicro, 2_340_000);

    // A still-running child turn has no end time yet, so it is not attributed.
    const running = data.sessions[3];
    assert.deepEqual(running.turns, []);
    assert.equal(running.costMicro, 0);

    // The 30s cache serves the second read without another session list.
    const again = await readBillingState(fake.ctx, 'subagents', 'parent');
    assert.strictEqual(again, data);
    assert.equal(fake.listCalls.value, 1);
  } finally {
    setPlanProviders([]);
  }
});

await test('subagents scope returns no rows for a Session without children', async () => {
  resetBillingCache();
  const fake = fakeCtx({ sessions: [SUB_PARENT, SUB_UNRELATED] });
  const data = await readBillingState(fake.ctx, 'subagents', 'parent');
  assert.deepEqual(data.sessions, []);
  assert.equal(data.degraded, false);
});

await test('subagents scope validates and requires sessionId', async () => {
  resetBillingCache();
  const fake = fakeCtx({ sessions: [] });
  const base = 'http://127.0.0.1:1' + STATE_ROUTE + '?scope=subagents';
  const headers = { 'x-dsh-turn-cost': '1' };
  for (const suffix of ['', '&sessionId=', '&sessionId=%20%20', '&sessionId=a%01b', `&sessionId=${'x'.repeat(201)}`]) {
    const response = await handleStateRequest(fake.ctx, request(base + suffix, headers));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { v: 1, error: 'invalid sessionId' });
  }
  await assert.rejects(() => readBillingState(fake.ctx, 'subagents', ''), /sessionId is required/);
});

await test('subagents scope degrades without a Session service', async () => {
  resetBillingCache();
  const ctx = { get: () => undefined, logger: { warn() {} } };
  const data = await readBillingState(ctx, 'subagents', 'parent');
  assert.deepEqual(data.sessions, []);
  assert.equal(typeof data.degraded, 'string');
});

await test('subagents scope answers over HTTP with no-store', async () => {
  resetBillingCache();
  const fake = fakeCtx({ sessions: [SUB_PARENT, SUB_CHILD] });
  const response = await handleStateRequest(
    fake.ctx,
    request('http://127.0.0.1:1' + STATE_ROUTE + '?scope=subagents&sessionId=parent', { 'x-dsh-turn-cost': '1' }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.scope, 'subagents');
  assert.deepEqual(
    body.sessions.map((session) => session.id),
    ['child-1'],
  );
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
