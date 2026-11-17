/**
 * cost-model.js — executable checks for pricing, folding and session totals.
 *
 * Run: node tests/cost-model.test.mjs
 *
 * Every expected value below was computed by hand from the documented table:
 *   peak CNY / 1M tokens   flash 0.04 / 2 / 8   pro 0.3 / 9 / 27   legacy 0.2 / 2 / 3
 *   peak USD / 1M tokens   flash 0.006 / .3 / 1.2   pro .044 / 1.32 / 3.96   legacy .028/.28/.42
 *   off-peak = 50% of the peak table, except retired legacy ids (flat).
 * Tokens: cacheRead 1,000,000 · uncachedInput 500,000 · cacheWrite 250,000 · output 100,000.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setCnyPriceBook } from '../cny-prices.js';
setCnyPriceBook(JSON.parse(fs.readFileSync(new URL('../prices/cny-models.json', import.meta.url), 'utf8')));

import {
  APPROX_CNY_PER_USD,
  COST_MODEL_VERSION,
  PEAK_PRICES,
  SEARCH_REQUEST_MICRO,
  USD_PEAK_PRICES,
  classifyModel,
  costMicroOf,
  createState,
  foldAll,
  foldEvent,
  isPeak,
  resolvePricing,
  setModelNames,
  setPlanProviders,
  setPriceBook,
  setSelectionLookup,
  usdCostMicroOf,
  usdMicroOfTurn,
  viewOf,
} from '../cost-model.js';

/* ------------------------------------------------------------------ */
/* tiny test runner                                                    */
/* ------------------------------------------------------------------ */

const results = [];
let failed = 0;
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    failed += 1;
    results.push({ name, ok: false, error });
  }
}

const BEIJING = 8 * 60 * 60 * 1000;
/** UTC epoch ms for a Beijing wall-clock moment (month is 0-based). */
function beijing(year, month, day, hour, minute = 0, second = 0) {
  return Date.UTC(year, month, day, hour, minute, second) - BEIJING;
}

const MONDAY_PEAK = beijing(2026, 10, 16, 10, 0); // Mon 10:00 Beijing
const MONDAY_OFFPEAK = beijing(2026, 10, 16, 12, 0); // Mon 12:00 Beijing
const SATURDAY = beijing(2026, 10, 21, 10, 0);

const TOKENS = {
  cacheRead: 1_000_000,
  uncachedInput: 500_000,
  cacheWrite: 250_000,
  output: 100_000,
};

/** Build one complete turn. `seq` starts at 1. */
function turnEvents({
  turn = 1,
  provider = 'deepseek',
  model = 'deepseek-v4-flash',
  usage = usageFor(TOKENS),
  time = MONDAY_PEAK,
  endTime = time + 60_000,
  header,
  web = [],
  step = 0,
  seq = 1,
} = {}) {
  const events = [];
  let n = seq;
  const push = (type, data, at) => events.push({ seq: n++, type, time: at, data });

  push('turn/start', { turn }, time);
  if (header !== undefined) push('request/header', { header: { config: header } }, time);
  for (const item of web) {
    if (item.kind === 'call') {
      push('tool/call', { name: item.name, callId: item.callId, arguments: item.arguments }, time);
    } else if (item.kind === 'result') {
      push('tool/result', { message: { toolCallId: item.callId, isError: item.isError === true } }, time);
    } else if (item.kind === 'messages') {
      push('web/deepseek-search-llm-request', {}, time);
    }
  }
  if (usage !== null) {
    push(
      'assistant/message',
      { turn, step, usage, source: { provider, model } },
      time + 1000,
    );
  }
  push('turn/end', { turn }, endTime);
  return events;
}

function usageFor(tokens) {
  return {
    inputTokens: tokens.uncachedInput || 0,
    cacheReadTokens: tokens.cacheRead || 0,
    cacheWriteTokens: tokens.cacheWrite || 0,
    outputTokens: tokens.output || 0,
    totalTokens:
      (tokens.uncachedInput || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0) + (tokens.output || 0),
  };
}

function oneTurn(options) {
  const state = foldAll(turnEvents(options), 'sess-1');
  assert.equal(state.turns.length, 1, 'expected exactly one folded turn');
  return state.turns[0];
}

function reset() {
  setPriceBook(undefined);
  setPlanProviders([]);
  setSelectionLookup(null);
  setModelNames({});
}

/* ------------------------------------------------------------------ */
/* pricing math: DeepSeek CNY/USD, peak/off-peak                       */
/* ------------------------------------------------------------------ */

reset();

test('CNY flash peak: 1M hit + 500k miss + 250k write + 100k output = 2,340,000 micro', () => {
  assert.equal(costMicroOf(TOKENS, 'flash', true), 2_340_000);
});

test('CNY flash off-peak is exactly 50% = 1,170,000 micro', () => {
  assert.equal(costMicroOf(TOKENS, 'flash', false), 1_170_000);
});

test('CNY pro peak = 300,000 + 6,750,000 + 2,700,000 = 9,750,000 micro', () => {
  assert.equal(costMicroOf(TOKENS, 'pro', true), 9_750_000);
});

test('legacy ids are flat: peak === off-peak = 2,000,000 micro', () => {
  assert.equal(costMicroOf(TOKENS, 'legacy', true), 2_000_000);
  assert.equal(costMicroOf(TOKENS, 'legacy', false), 2_000_000);
});

test('USD flash peak = 351,000 micro, off-peak = 175,500 micro (not CNY/7.1)', () => {
  assert.equal(usdCostMicroOf(TOKENS, 'flash', true), 351_000);
  assert.equal(usdCostMicroOf(TOKENS, 'flash', false), 175_500);
});

test('USD pro peak = 44,000 + 990,000 + 396,000 = 1,430,000 micro', () => {
  assert.equal(usdCostMicroOf(TOKENS, 'pro', true), 1_430_000);
});

test('classifyModel family matching (flash/pro/legacy)', () => {
  assert.equal(classifyModel('deepseek-v4-flash'), 'flash');
  assert.equal(classifyModel('DeepSeek-V4-Pro-0813'), 'pro');
  assert.equal(classifyModel('deepseek-chat'), 'legacy');
  assert.equal(classifyModel('deepseek-reasoner'), 'legacy');
  assert.equal(classifyModel('gpt-5'), undefined);
  assert.equal(classifyModel(undefined), undefined);
});

/* ------------------------------------------------------------------ */
/* peak/off-peak boundaries (Beijing Mon-Fri 09:00-12:00, 14:00-18:00) */
/* ------------------------------------------------------------------ */

test('peak boundaries 08:59/09:00/11:59/12:00/13:59/14:00/17:59/18:00', () => {
  const cases = [
    [beijing(2026, 10, 16, 8, 59), false],
    [beijing(2026, 10, 16, 9, 0), true],
    [beijing(2026, 10, 16, 11, 59, 59), true],
    [beijing(2026, 10, 16, 12, 0), false],
    [beijing(2026, 10, 16, 13, 59), false],
    [beijing(2026, 10, 16, 14, 0), true],
    [beijing(2026, 10, 16, 17, 59), true],
    [beijing(2026, 10, 16, 18, 0), false],
  ];
  for (const [time, expected] of cases) {
    assert.equal(isPeak(time), expected, `isPeak(${new Date(time).toISOString()})`);
  }
});

test('Saturday and Sunday are off-peak all day', () => {
  assert.equal(isPeak(SATURDAY), false);
  assert.equal(isPeak(beijing(2026, 10, 22, 10, 0)), false);
  assert.equal(isPeak(beijing(2026, 10, 22, 15, 0)), false);
});

test('isPeak accepts epoch seconds as well as milliseconds', () => {
  assert.equal(isPeak(Math.floor(MONDAY_PEAK / 1000)), true);
  assert.equal(isPeak(Math.floor(MONDAY_OFFPEAK / 1000)), false);
});

test('isPeak(0)/NaN are unknown (null), never the current clock', () => {
  // 0 and NaN cannot describe a real turn; the answer must not depend on when
  // the page is viewed, so it is explicitly unknown.
  assert.equal(isPeak(0), null);
  assert.equal(isPeak(Number.NaN), null);
  assert.equal(isPeak(-5), null);
});

test('a turn without an end time bills the list price and labels period flat', () => {
  const turn = oneTurn({ endTime: 0 });
  assert.equal(turn.peak, true);
  assert.equal(turn.period, 'flat');
  assert.equal(turn.costMicro, 2_340_000);
  assert.equal(turn.costUsdMicro, 351_000);
});

/* ------------------------------------------------------------------ */
/* fold: exact turn amounts, period, session totals                    */
/* ------------------------------------------------------------------ */

test('peak turn folds exact CNY+USD amounts and period=peak', () => {
  const turn = oneTurn({ time: MONDAY_PEAK });
  assert.equal(turn.costMicro, 2_340_000);
  assert.equal(turn.costUsdMicro, 351_000);
  assert.equal(turn.period, 'peak');
  assert.equal(turn.pricing, 'deepseek');
  assert.equal(turn.peak, true);
  assert.deepEqual(turn.rates.cny, { hit: 0.04, miss: 2, output: 8 });
  assert.deepEqual(turn.tokens, { ...TOKENS, total: 1_850_000 });
  assert.equal(turn.model, 'deepseek-v4-flash');
  assert.equal(turn.provider, 'deepseek');
});

test('off-peak turn folds half price and period=offpeak', () => {
  const turn = oneTurn({ time: MONDAY_OFFPEAK });
  assert.equal(turn.costMicro, 1_170_000);
  assert.equal(turn.costUsdMicro, 175_500);
  assert.equal(turn.period, 'offpeak');
  assert.deepEqual(turn.rates.cny, { hit: 0.02, miss: 1, output: 4 });
});

test('legacy deepseek-chat is flat all day (period=flat, price unchanged)', () => {
  for (const time of [MONDAY_PEAK, MONDAY_OFFPEAK]) {
    const turn = oneTurn({ model: 'deepseek-chat', time });
    assert.equal(turn.costMicro, 2_000_000);
    assert.equal(turn.period, 'flat');
    assert.equal(turn.rates.flat, true);
  }
});

test('session totals accumulate only priced turns and carry per-turn snapshots', () => {
  const events = [
    ...turnEvents({ turn: 1, time: MONDAY_PEAK }),
    ...turnEvents({ turn: 2, time: MONDAY_OFFPEAK, seq: 20 }),
  ];
  const state = foldAll(events, 'sess-1');
  assert.equal(state.turns.length, 2);
  assert.equal(state.sessionCostMicro, 3_510_000);
  assert.equal(state.sessionCostUsdMicro, 526_500);
  assert.equal(state.turns[0].sessionCostMicro, 2_340_000);
  assert.equal(state.turns[1].sessionCostMicro, 3_510_000);
  assert.equal(state.sessionTokens.total, 3_700_000);
  const view = viewOf(state);
  assert.equal(view.v, COST_MODEL_VERSION);
  assert.equal(view.session.turns, 2);
  assert.equal(view.session.pricedTurns, 2);
  assert.deepEqual(view.session.missingTurns, []);
});

test('title event updates the session title and view', () => {
  const state = foldAll(
    [{ seq: 1, type: 'session/title', time: 1, data: { title: '账单测试' } }],
    'sess-1',
  );
  assert.equal(state.title, '账单测试');
  assert.equal(viewOf(state).title, '账单测试');
});

/* ------------------------------------------------------------------ */
/* catalog / free / unknown / plan                                     */
/* ------------------------------------------------------------------ */

test('catalog model: USD from pi-ai table, CNY = round(USD × 7.1), ≈ marker', () => {
  setPriceBook({
    providers: {
      openai: {
        'gpt-5': { name: 'GPT-5', input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
      },
    },
    models: 1,
    version: 'fixture',
  });
  const turn = oneTurn({ provider: 'openai', model: 'gpt-5' });
  // 500k*1 + 250k*1.5 + 1M*0.5 + 100k*2 = 1,575,000 micro-USD
  assert.equal(turn.costUsdMicro, 1_575_000);
  assert.equal(turn.costMicro, Math.round(1_575_000 * APPROX_CNY_PER_USD));
  assert.equal(turn.costMicro, 11_182_500);
  assert.equal(turn.pricing, 'catalog');
  assert.equal(turn.approxCny, true);
  assert.equal(turn.period, 'flat');
  assert.equal(turn.modelName, 'GPT-5');
  reset();
});

test('catalog model with all-zero rates is free (¥0), never unknown', () => {
  setPriceBook({
    providers: { local: { 'free-1': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    models: 1,
  });
  const turn = oneTurn({ provider: 'local', model: 'free-1' });
  assert.equal(turn.pricing, 'free');
  assert.equal(turn.costMicro, 0);
  assert.equal(turn.costUsdMicro, 0);
  assert.equal(turn.period, 'flat');
  reset();
});

/* Official Zhipu BigModel RMB list vs the catalog USD list. */
test('GLM CNY uses the BigModel RMB price list, never USD × 7.1', () => {
  setPriceBook({
    providers: {
      'zai-coding-cn': {
        'glm-5.3-flash': { name: 'GLM-5.3-Flash', input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      },
    },
    models: 1,
    version: 'fixture',
  });
  const turn = oneTurn({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' });
  // CNY: 0.5M×0.8 + 1M×0.23 + 0.1M×2.8 = 910,000 micro (¥0.91)
  assert.equal(turn.pricing, 'cny');
  assert.equal(turn.costMicro, 910_000);
  assert.equal(turn.approxCny, false);
  // USD keeps the catalog list: 0.5M×0.15 + 1M×0.03 + 0.1M×0.5 = 155,000 micro
  assert.equal(turn.costUsdMicro, 155_000);
  assert.equal(turn.period, 'flat');
  assert.equal(turn.modelName, 'GLM-5.3-Flash');
  reset();
});

test('GLM-5.3 CNY table: ¥8 input / ¥28 output / ¥2 cache read', () => {
  setPriceBook({
    providers: {
      'zai-coding-cn': {
        'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      },
    },
    models: 1,
  });
  const turn = oneTurn({ provider: 'zai-coding-cn', model: 'glm-5.3' });
  // 0.5M×8 + 1M×2 + 0.1M×28 = 8,800,000 micro
  assert.equal(turn.costMicro, 8_800_000);
  // 0.5M×1.4 + 1M×0.26 + 0.1M×4.4 = 1,400,000 micro
  assert.equal(turn.costUsdMicro, 1_400_000);
  reset();
});

test('a subscription-plan provider stays quota-priced even when the vendor has an RMB card', () => {
  setPlanProviders(['moonshot']);
  const turn = oneTurn({ provider: 'moonshot', model: 'kimi-k3.1-pro' });
  assert.equal(turn.pricing, 'plan');
  assert.equal(turn.costMicro, null);
  reset();
});

test('GLM tiered price: GLM-4.7 uses output and input-length tiers', () => {
  const small = oneTurn({
    provider: 'zai-coding-cn',
    model: 'glm-4.7',
    usage: usageFor({ uncachedInput: 1_000, output: 100 }),
  });
  // input <32K, output <200 → 2 / 8: 1,000×2 + 100×8 = 2,800 micro
  assert.equal(small.costMicro, 2_800);

  reset();
  const longOutput = oneTurn({
    provider: 'zai-coding-cn',
    model: 'glm-4.7',
    usage: usageFor({ uncachedInput: 1_000, output: 1_000 }),
  });
  // input <32K, output ≥200 → 3 / 14: 1,000×3 + 1,000×14 = 17,000 micro
  assert.equal(longOutput.costMicro, 17_000);

  reset();
  const longInput = oneTurn({
    provider: 'zai-coding-cn',
    model: 'glm-4.7',
    usage: usageFor({ uncachedInput: 40_000, output: 0 }),
  });
  // input ≥32K → 4 / 16: 40,000×4 = 160,000 micro
  assert.equal(longInput.costMicro, 160_000);
  reset();
});

test('GLM free and non-BigModel providers are unaffected', () => {
  const free = oneTurn({ provider: 'zai-coding-cn', model: 'glm-4.7-flash' });
  assert.equal(free.pricing, 'free');
  assert.equal(free.costMicro, 0);

  reset();
  // Same model id through an unrelated provider stays on the catalog path.
  setPriceBook({
    providers: { openrouter: { 'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 } } },
    models: 1,
  });
  const resold = oneTurn({ provider: 'openrouter', model: 'glm-5.3-flash' });
  assert.equal(resold.pricing, 'catalog');
  assert.equal(resold.approxCny, true);
  reset();
});

test('unknown provider/model: null amounts, missingTurns, never invented price', () => {
  const state = foldAll(turnEvents({ provider: 'acme', model: 'mystery-1' }), 'sess-1');
  const turn = state.turns[0];
  assert.equal(turn.pricing, 'unknown');
  assert.equal(turn.costMicro, null);
  assert.equal(turn.costUsdMicro, null);
  assert.equal(turn.period, 'flat');
  assert.deepEqual(state.missingTurns, [1]);
  assert.equal(state.sessionCostMicro, 0);
  assert.equal(viewOf(state).session.pricedTurns, 0);
  assert.equal(viewOf(state).session.missingTurns.length, 1);
});

test('plan provider: plan wording data, null amounts, excluded from sums', () => {
  setPlanProviders(['chatgpt']);
  const state = foldAll(turnEvents({ provider: 'chatgpt', model: 'gpt-5' }), 'sess-1');
  const turn = state.turns[0];
  assert.equal(turn.pricing, 'plan');
  assert.equal(turn.plan, true);
  assert.equal(turn.costMicro, null);
  assert.equal(turn.costUsdMicro, null);
  assert.equal(state.sessionPlanTurns, 1);
  assert.equal(state.sessionCostMicro, 0);
  assert.equal(state.missingTurns.length, 0);
  const view = viewOf(state);
  assert.equal(view.session.planTurns, 1);
  assert.equal(view.session.pricedTurns, 0);
  reset();
});

test('plan detection is exact-id, not shape-based (zai-coding-cn stays metered)', () => {
  setPlanProviders(['chatgpt']);
  setPriceBook({
    providers: { 'zai-coding-cn': { glm: { input: 1, output: 2 } } },
    models: 1,
  });
  const turn = oneTurn({ provider: 'zai-coding-cn', model: 'glm' });
  assert.equal(turn.pricing, 'catalog');
  assert.notEqual(turn.pricing, 'plan');
  reset();
});

/* ------------------------------------------------------------------ */
/* web search / fetch fees                                             */
/* ------------------------------------------------------------------ */

test('api-mode web_search adds ¥0.005 per call ($0.00075) to both totals', () => {
  const turn = oneTurn({
    web: [
      { kind: 'call', name: 'web_search', callId: 'c1', arguments: { queries: ['a', 'a', 'b'] } },
      { kind: 'result', callId: 'c1' },
    ],
  });
  assert.equal(turn.webSearchRequests, 2); // de-duplicated queries
  assert.equal(turn.webSearchBilled, true);
  assert.equal(turn.costMicro, 2_340_000 + 2 * SEARCH_REQUEST_MICRO);
  assert.equal(turn.costUsdMicro, 351_000 + 2 * 750);
  assert.equal(turn.webFeeMicro, 2 * SEARCH_REQUEST_MICRO);
});

test('failed web_search result is not billed', () => {
  const turn = oneTurn({
    web: [
      { kind: 'call', name: 'web_search', callId: 'c1', arguments: { queries: ['a'] } },
      { kind: 'result', callId: 'c1', isError: true },
    ],
  });
  assert.equal(turn.webSearchRequests, 0);
  assert.equal(turn.costMicro, 2_340_000);
});

test('Messages-mode search bills no per-call fee (tokens only)', () => {
  const turn = oneTurn({
    web: [
      { kind: 'call', name: 'web_search', callId: 'c1', arguments: { queries: ['a'] } },
      { kind: 'result', callId: 'c1' },
      { kind: 'messages' },
    ],
  });
  assert.equal(turn.webSearchRequests, 1);
  assert.equal(turn.webMessagesRequests, 1);
  assert.equal(turn.webSearchBilled, false);
  assert.equal(turn.costMicro, 2_340_000);
});

test('web_fetch in an api-mode turn is billed ¥0.005', () => {
  const turn = oneTurn({
    web: [
      { kind: 'call', name: 'web_search', callId: 'c1', arguments: { queries: ['a'] } },
      { kind: 'result', callId: 'c1' },
      { kind: 'call', name: 'web_fetch', callId: 'c2', arguments: { url: 'https://example.com' } },
      { kind: 'result', callId: 'c2' },
    ],
  });
  assert.equal(turn.costMicro, 2_340_000 + 2 * SEARCH_REQUEST_MICRO);
});

test('fetch-only turn before any search is not billed (webMode still null)', () => {
  const turn = oneTurn({
    web: [
      { kind: 'call', name: 'web_fetch', callId: 'c2', arguments: { url: 'https://example.com' } },
      { kind: 'result', callId: 'c2' },
    ],
  });
  // Documented/observed behaviour: the fetch fee needs an API-mode search first.
  assert.equal(turn.webFetchRequests, 1);
  assert.equal(turn.costMicro, 2_340_000);
});

test('a later api-mode turn bills the fetch fee for its own fetches', () => {
  const events = [
    ...turnEvents({ turn: 1, seq: 1 }),
    ...turnEvents({
      turn: 2,
      seq: 20,
      web: [
        { kind: 'call', name: 'web_search', callId: 'c1', arguments: { queries: ['q'] } },
        { kind: 'result', callId: 'c1' },
        { kind: 'call', name: 'web_fetch', callId: 'c2', arguments: { url: 'u' } },
        { kind: 'result', callId: 'c2' },
      ],
    }),
  ];
  const state = foldAll(events, 'sess-1');
  assert.equal(state.turns[1].costMicro, 2_340_000 + 2 * SEARCH_REQUEST_MICRO);
});

/* ------------------------------------------------------------------ */
/* per-turn model name / effort / carry-forward                        */
/* ------------------------------------------------------------------ */

test('request/header supplies model, effort and modelName', () => {
  setModelNames({ '*\u0000deepseek-v4-pro': 'DeepSeek V4 Pro' });
  const turn = oneTurn({
    model: 'deepseek-v4-pro',
    header: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  });
  assert.equal(turn.model, 'deepseek-v4-pro');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.modelName, 'DeepSeek V4 Pro');
  assert.equal(turn.costMicro, 9_750_000);
  reset();
});

test('selection log overrides a missing header effort (agent/pre-step path)', () => {
  setSelectionLookup((sessionId, turnNumber, step) => {
    assert.equal(sessionId, 'sess-1');
    assert.equal(turnNumber, 1);
    assert.equal(step, 0);
    return { effort: 'max' };
  });
  const turn = oneTurn({ model: 'deepseek-v4-flash' });
  assert.equal(turn.effort, 'max');
  reset();
});

test('effort is carried forward when a turn has no request/header (header once per process)', () => {
  const events = [
    ...turnEvents({
      turn: 1,
      seq: 1,
      header: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    }),
    ...turnEvents({ turn: 2, seq: 20 }),
  ];
  const state = foldAll(events, 'sess-1');
  assert.equal(state.turns[0].effort, 'high');
  assert.equal(state.turns[1].effort, 'high');
});

test('last step wins for modelName/effort; first route wins for pricing attribution', () => {
  setModelNames({
    '*\u0000deepseek-v4-flash': 'DeepSeek Flash',
    '*\u0000deepseek-v4-pro': 'DeepSeek Pro',
  });
  const usage = usageFor(TOKENS);
  const events = [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    { seq: 2, type: 'request/header', time: MONDAY_PEAK, data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'low' } } } },
    {
      seq: 3,
      type: 'assistant/message',
      time: MONDAY_PEAK + 1,
      data: { turn: 1, step: 1, usage, source: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
    },
    {
      seq: 4,
      type: 'assistant/message',
      time: MONDAY_PEAK + 2,
      data: { turn: 1, step: 0, usage, source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
    { seq: 5, type: 'turn/end', time: MONDAY_PEAK + 3, data: { turn: 1 } },
  ];
  const state = foldAll(events, 'sess-1');
  const turn = state.turns[0];
  // model/provider come from the first step inserted (step 1, pro); display name
  // from the highest step number (step 1 too).
  assert.equal(turn.modelName, 'DeepSeek Pro');
  assert.equal(turn.effort, 'low');
  // Both steps carry the same token buckets, and numeric keys iterate 0,1, so
  // the first route (flash) prices the sum of both steps.
  assert.equal(turn.costMicro, 4_680_000);
  reset();
});

test('retried step: last settled attempt replaces the earlier usage', () => {
  const small = usageFor({ uncachedInput: 1_000_000 });
  const big = usageFor({ uncachedInput: 2_000_000 });
  const events = [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    {
      seq: 2,
      type: 'assistant/attempt',
      time: MONDAY_PEAK + 1,
      data: { turn: 1, step: 0, usage: small, source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
    {
      seq: 3,
      type: 'assistant/message',
      time: MONDAY_PEAK + 2,
      data: { turn: 1, step: 0, usage: big, source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
    { seq: 4, type: 'turn/end', time: MONDAY_PEAK + 3, data: { turn: 1 } },
  ];
  const turn = foldAll(events, 'sess-1').turns[0];
  assert.equal(turn.tokens.uncachedInput, 2_000_000);
  assert.equal(turn.costMicro, 4_000_000);
});

test('multi-step turn sums every step once', () => {
  const usage = usageFor({ uncachedInput: 500_000 });
  const events = [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: MONDAY_PEAK + 1,
      data: { turn: 1, step: 0, usage, source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
    {
      seq: 3,
      type: 'assistant/message',
      time: MONDAY_PEAK + 2,
      data: { turn: 1, step: 1, usage, source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
    { seq: 4, type: 'turn/end', time: MONDAY_PEAK + 3, data: { turn: 1 } },
  ];
  const turn = foldAll(events, 'sess-1').turns[0];
  assert.equal(turn.tokens.uncachedInput, 1_000_000);
  assert.equal(turn.costMicro, 2_000_000);
});

/* ------------------------------------------------------------------ */
/* empty / aborted / inherited / versioning                            */
/* ------------------------------------------------------------------ */

test('aborted turn (no usage) is empty, costs 0 and shows no amounts', () => {
  const state = foldAll(turnEvents({ usage: null }), 'sess-1');
  const turn = state.turns[0];
  assert.equal(turn.empty, true);
  assert.equal(turn.costMicro, 0);
  assert.equal(state.sessionCostMicro, 0);
  assert.equal(turn.period, null);
});

test('viewOf pricedTurns ignores empty turns', () => {
  const state = foldAll(turnEvents({ usage: null }), 'sess-1');
  // Session has 1 turn, 0 priced, 0 plan, 0 missing -> pricedTurns should be 0.
  assert.equal(viewOf(state).session.turns, 1);
  assert.equal(viewOf(state).session.missingTurns.length, 0);
  assert.equal(viewOf(state).session.planTurns, 0);
  assert.equal(viewOf(state).session.pricedTurns, 0);
});

test('events below inheritedEventCount are skipped', () => {
  const events = turnEvents({ turn: 1, seq: 10 });
  assert.deepEqual(events.map((event) => event.seq), [10, 11, 12]);
  // With the cut at 11 the turn/start is gone, so the remaining assistant/end
  // events have no open turn and produce nothing.
  assert.equal(foldAll(events, 'sess-1', 11).turns.length, 0);
  // With the cut at 10 the whole turn is folded.
  assert.equal(foldAll(events, 'sess-1', 10).turns.length, 1);
});

test('state/view carry model/version 12', () => {
  const state = createState('s', 0);
  assert.equal(state.priceVersion, 'deepseek-cny-2026-11-11');
  assert.equal(viewOf(state).v, COST_MODEL_VERSION);
  assert.equal(COST_MODEL_VERSION, 12);
});

/* ------------------------------------------------------------------ */
/* 子代理（team/member）                                                */
/* ------------------------------------------------------------------ */

function memberEvent(seq, time, member) {
  return { seq, type: 'team/member', time, data: { member } };
}

function assistantEvent(seq, time, turn, tokens = TOKENS, model = 'deepseek-v4-flash', provider = 'deepseek') {
  return {
    seq,
    type: 'assistant/message',
    time,
    data: { turn, step: 0, usage: usageFor(tokens), source: { provider, model } },
  };
}

test('team/member records subagents on the open turn and the Session view', () => {
  const events = [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    memberEvent(2, MONDAY_PEAK + 500, { id: 'child-a', name: 'bug-fixer', phase: 'active' }),
    memberEvent(3, MONDAY_PEAK + 600, { id: 'child-b', name: 'host-reviewer', phase: 'provisioning' }),
    // The same member is announced again (create -> active): one entry, one name.
    memberEvent(4, MONDAY_PEAK + 700, { id: 'child-a', name: 'bug-fixer', phase: 'active' }),
    assistantEvent(5, MONDAY_PEAK + 1000, 1),
    { seq: 6, type: 'turn/end', time: MONDAY_PEAK + 60_000, data: { turn: 1 } },
  ];
  const state = foldAll(events, 'sess-1');
  assert.equal(state.turns.length, 1);
  assert.deepEqual(state.turns[0].agents, [
    { id: 'child-a', name: 'bug-fixer' },
    { id: 'child-b', name: 'host-reviewer' },
  ]);
  // team/member must never move tokens, price or cost.
  assert.equal(state.turns[0].costMicro, 2_340_000);
  assert.equal(state.turns[0].tokens.total, 1_850_000);
  assert.equal(state.sessionCostMicro, 2_340_000);
  assert.deepEqual(viewOf(state).agents, [
    { id: 'child-a', name: 'bug-fixer' },
    { id: 'child-b', name: 'host-reviewer' },
  ]);
});

test('open turn keeps its ordered subagent map before the turn ends', () => {
  const state = foldAll(
    [
      { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
      memberEvent(2, MONDAY_PEAK + 500, { id: 'child-a', name: 'bug-fixer' }),
      memberEvent(3, MONDAY_PEAK + 600, { id: 'child-b', name: '' }),
    ],
    'sess-1',
  );
  assert.deepEqual(state.open.agents, {
    'child-a': { id: 'child-a', name: 'bug-fixer' },
    'child-b': { id: 'child-b', name: '' },
  });
});

test('Session-level subagent names survive a continued run without team/member', () => {
  const turn1 = turnEvents({ turn: 1 });
  turn1.splice(1, 0, memberEvent(90, MONDAY_PEAK + 500, { id: 'child-a', name: 'old-name' }));
  turn1.splice(2, 0, memberEvent(91, MONDAY_PEAK + 600, { id: 'child-a', name: 'bug-fixer' }));
  // A continued run (send_message) emits no team/member: turn 2 keeps no agents.
  const turn2 = turnEvents({ turn: 2, seq: 10 });
  const state = foldAll(turn1.concat(turn2), 'sess-1');
  assert.deepEqual(state.turns[0].agents, [{ id: 'child-a', name: 'bug-fixer' }]);
  assert.deepEqual(state.turns[1].agents, []);
  // ... but the Session-wide map still resolves the display name.
  assert.deepEqual(viewOf(state).agents, [{ id: 'child-a', name: 'bug-fixer' }]);
});

test('team/member tolerates malformed events and an empty view has no agents', () => {
  let state = createState('s');
  for (const event of [
    null,
    {},
    { type: 'team/member' },
    { type: 'team/member', data: {} },
    { type: 'team/member', data: { member: {} } },
    { type: 'team/member', data: { member: { id: 42, name: 'x' } } },
    { type: 'team/member', data: { member: { id: '', name: 'x' } } },
    { type: 'team/member', data: { member: 'nope' } },
  ]) {
    state = foldEvent(state, event);
  }
  assert.deepEqual(state.agents, {});
  assert.deepEqual(viewOf(state).agents, []);
  const emptyTurn = turnEvents({ usage: null });
  assert.deepEqual(foldAll(emptyTurn, 'sess-1').turns[0].agents, []);
});

test('foldEvent tolerates malformed events without throwing', () => {
  let state = createState('s');
  for (const event of [null, {}, { type: 'turn/start' }, { type: 'assistant/message', data: null }, { type: 'nope' }]) {
    state = foldEvent(state, event);
  }
  assert.equal(state.turns.length, 0);
});

/* ------------------------------------------------------------------ */
/* legacy USD derivation                                               */
/* ------------------------------------------------------------------ */

test('usdMicroOfTurn derives USD for a legacy CNY-only record', () => {
  const micro = usdMicroOfTurn({
    model: 'deepseek-v4-flash',
    tokens: TOKENS,
    costMicro: 2_340_000,
    peak: true,
    webSearchFeeMicro: 5000,
  });
  assert.equal(micro, 351_000 + 750);
});

test('rounding happens once on the summed micro amount (10.04 -> 10)', () => {
  const tokens = { cacheRead: 1, uncachedInput: 1, cacheWrite: 0, output: 1 };
  assert.equal(costMicroOf(tokens, 'flash', true), 10);
  assert.equal(usdCostMicroOf(tokens, 'flash', true), 2); // 0.006 + 0.3 + 1.2 = 1.506 -> 2
});

test('a usage record with no route attribution stays unknown (no guessed price)', () => {
  const events = [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: MONDAY_PEAK + 1000,
      data: { turn: 1, step: 0, usage: usageFor(TOKENS) },
    },
    { seq: 3, type: 'turn/end', time: MONDAY_PEAK + 2000, data: { turn: 1 } },
  ];
  const turn = foldAll(events, 'sess-1').turns[0];
  assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.provider, null);
  assert.equal(turn.pricing, 'unknown');
  assert.equal(turn.costMicro, null);
});

test('header/route mismatch: route wins for pricing, header effort is not inherited by the step', () => {
  setPriceBook({
    providers: { openai: { 'gpt-5': { input: 2, output: 8 } } },
    models: 1,
  });
  const events = [
    { seq: 1, type: 'turn/start', time: MONDAY_PEAK, data: { turn: 1 } },
    {
      seq: 2,
      type: 'request/header',
      time: MONDAY_PEAK,
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } },
    },
    {
      seq: 3,
      type: 'assistant/message',
      time: MONDAY_PEAK + 1000,
      data: { turn: 1, step: 0, usage: usageFor({ uncachedInput: 1_000_000 }), source: { provider: 'openai', model: 'gpt-5' } },
    },
    { seq: 4, type: 'turn/end', time: MONDAY_PEAK + 2000, data: { turn: 1 } },
  ];
  const turn = foldAll(events, 'sess-1').turns[0];
  assert.equal(turn.provider, 'openai');
  assert.equal(turn.model, 'gpt-5');
  assert.equal(turn.pricing, 'catalog');
  assert.equal(turn.costUsdMicro, 2_000_000); // 1M * $2
  assert.equal(turn.costMicro, 14_200_000); // round(2,000,000 * 7.1)
  reset();
});

test('a repeated turn/end is ignored (one turn, billed once)', () => {
  const events = turnEvents({});
  events.push({ seq: 99, type: 'turn/end', time: MONDAY_PEAK + 120_000, data: { turn: 1 } });
  const state = foldAll(events, 'sess-1');
  assert.equal(state.turns.length, 1);
  assert.equal(state.sessionCostMicro, 2_340_000);
});

test('already settled turns keep their frozen amount when the price book changes', () => {
  let state = createState('sess-1', 0);
  for (const event of turnEvents({ turn: 1 })) state = foldEvent(state, event);
  const first = state.turns[0];
  assert.equal(first.costMicro, 2_340_000);
  // Later the provider becomes a plan: turn 1 must not be rewritten.
  setPlanProviders(['deepseek']);
  for (const event of turnEvents({ turn: 2, seq: 10 })) state = foldEvent(state, event);
  assert.equal(state.turns[0].costMicro, 2_340_000);
  assert.equal(state.turns[0].pricing, 'deepseek');
  assert.equal(state.turns[1].pricing, 'plan');
  assert.equal(state.turns[1].costMicro, null);
  assert.equal(state.sessionCostMicro, 2_340_000);
  reset();
});

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

for (const result of results) {
  if (result.ok) {
    console.log(`PASS  ${result.name}`);
  } else {
    console.log(`FAIL  ${result.name}`);
    console.log(`      ${String(result.error && result.error.message).split('\n').join('\n      ')}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
