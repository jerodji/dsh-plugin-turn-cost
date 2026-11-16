/**
 * client.js — footer/dialog rendering with a fake React, plus the localStorage
 * mirror, settings and the XLSX writer.
 *
 * Run: node tests/client.test.mjs
 *
 * client.js is a `window.__ModuleLoader__` bundle, so the module is loaded by
 * installing a capturing loader and calling its factory with a stub `react`.
 * The returned plugin object is public API; `apply()` is used only to capture
 * the components it registers in the slots.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ */
/* fake React (just enough for the footer component)                   */
/* ------------------------------------------------------------------ */

let hookIndex = 0;
let hookState = [];
let hookRefs = [];
let effectQueue = [];
let dirty = false;

const React = {
  createElement(type, props, ...children) {
    const flat = [];
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      flat.push(child);
    }
    return { type, props: props || {}, children: flat };
  },
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hookState[index],
      (next) => {
        hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
        dirty = true;
      },
    ];
  },
  useEffect(fn) {
    effectQueue.push(fn);
  },
  useRef() {
    const index = hookIndex++;
    if (!(index in hookRefs)) hookRefs[index] = { current: null };
    return hookRefs[index];
  },
};

function resetHooks() {
  hookIndex = 0;
  hookState = [];
  hookRefs = [];
  effectQueue = [];
  dirty = false;
}

/** Render a function component, replaying state updates from effects/handlers. */
function render(Component, props) {
  let tree;
  for (let pass = 0; pass < 25; pass += 1) {
    hookIndex = 0;
    effectQueue = [];
    dirty = false;
    tree = Component(props);
    for (const fn of effectQueue) fn();
    if (!dirty) break;
  }
  return tree;
}

function findAll(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children || []) findAll(child, out);
  return out;
}

function findByAttr(tree, name, value) {
  return findAll(tree).find(
    (node) => node.props && node.props[name] !== undefined && (value === undefined || node.props[name] === value),
  );
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children || []).map(textOf).join('');
}

/* ------------------------------------------------------------------ */
/* fake DOM / module load                                              */
/* ------------------------------------------------------------------ */

function memoryStorage() {
  const rows = new Map();
  return {
    getItem: (key) => (rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => rows.set(key, String(value)),
    removeItem: (key) => rows.delete(key),
    raw: rows,
  };
}

globalThis.localStorage = memoryStorage();
globalThis.window = {
  __ModuleLoader__: { load(definition) { globalThis.__turnCostDefinition = definition; } },
  innerWidth: 1200,
  innerHeight: 800,
};

await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'client.js')).href);
const definition = globalThis.__turnCostDefinition;
assert.ok(definition && typeof definition.factory === 'function', 'client.js must register a factory');
const plugin = definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
});

const registered = {};
plugin.apply({
  locale: { register() {}, bind: () => (key) => key },
  effect(fn) {
    fn();
  },
  slots: {
    inject(_name, fn) {
      fn();
    },
    register(meta, component) {
      registered[meta.id] = component;
      return () => {};
    },
  },
});
const TurnCostBadge = registered['turn-cost'];
assert.equal(typeof TurnCostBadge, 'function', 'footer component must be registered');

/* ------------------------------------------------------------------ */
/* localization + fixtures                                             */
/* ------------------------------------------------------------------ */

const DICT = {
  badge: '本轮 {amount}',
  peakTag: '（峰）',
  offPeakTag: '（谷）',
  session: '会话 {amount}',
  sessionPartial: '会话 ≥ {amount}',
  sessionPlanQuota: '会话消耗订阅额度',
  planTurn: '本轮消耗订阅额度',
  costPlan: '订阅额度',
  costUnknown: '未知',
  panelTitleTurn: '本轮费用明细',
  panelTitleSession: '会话费用明细',
  tipModel: '模型：{model}',
  tipProvider: '提供方：{provider}',
  tipPeriod: '计费时段：{period}',
  periodPeak: '高峰时段（标准价）',
  periodOffPeak: '低谷时段（5 折）',
  periodPlan: '订阅额度（无单轮价格）',
  periodFlat: '全天同价（无峰谷）',
  periodUnknown: '价格未知',
  tipTokenSection: 'Token 统计',
  tipTokens: '本轮 tokens：{tokens}',
  tipAmountTitle: '金额明细（{currency}）',
  tipAmountTotal: '本轮金额合计：{amount}',
  tipSessionTitle: '会话金额（{currency}）',
  tipSessionTokens: '会话 tokens：{tokens}',
  tipSessionTotal: '会话合计：{amount}',
  tipSessionScope: '范围：第 1–{turn} 轮，其中 {priced} 轮计价',
  tipSessionNote: '金额按官方价目表估算。',
  tipSessionId: '会话 ID：{id}',
  tipTurnId: '轮次 ID：{id}',
};

function t(key, params) {
  const template = DICT[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (params && params[name] !== undefined ? String(params[name]) : ''));
}

const TOKENS = { uncachedInput: 500_000, cacheRead: 1_000_000, cacheWrite: 250_000, output: 100_000, total: 1_850_000 };

function entry(turn, overrides = {}) {
  return {
    id: `s1:${turn}`,
    turn,
    startedAt: 0,
    endedAt: 0,
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    modelName: 'DeepSeek V4 Flash',
    effort: 'high',
    pricing: 'deepseek',
    plan: false,
    approxCny: false,
    peak: true,
    period: 'peak',
    tokens: TOKENS,
    costMicro: 2_340_000,
    costUsdMicro: 351_000,
    empty: false,
    webSearchRequests: 0,
    webFetchRequests: 0,
    webMessagesRequests: 0,
    webSearchFeeMicro: 0,
    webFetchFeeMicro: 0,
    webFeeMicro: 0,
    ...overrides,
  };
}

function viewWith(turns) {
  return {
    v: 11,
    sessionId: 's1',
    title: 'T',
    priceVersion: 'deepseek-cny-2026-11-11',
    updatedAt: 1,
    turns,
    session: { costMicro: 0, costUsdMicro: 0, turns: turns.length, pricedTurns: 0, freeTurns: 0, planTurns: 0, missingTurns: [], tokens: TOKENS, web: {} },
  };
}

function propsFor(view, ownTurn, tailTokens = TOKENS.total) {
  return {
    t,
    sessionId: 's1',
    turn: {
      turn: ownTurn,
      header: { id: 's1' },
      data: {
        get: (key) =>
          key === 'turn-tail' ? { turn: ownTurn, tokenUsage: { totalTokens: tailTokens } } : undefined,
      },
    },
    useProjection: () => view,
    useChat: () => undefined,
  };
}

function ui(view, ownTurn) {
  resetHooks();
  return render(TurnCostBadge, propsFor(view, ownTurn));
}

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

/* ------------------------------------------------------------------ */
/* footer: order, amounts, plan/free/unknown wording                   */
/* ------------------------------------------------------------------ */

test('footer order: model + effort + （峰）, then 本轮, then 会话', () => {
  const tree = ui(viewWith([entry(1)]), 1);
  const row = findByAttr(tree, 'data-dsh-turn-cost-row');
  assert.ok(row);
  const model = findByAttr(tree, 'data-dsh-turn-model');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-model-name')), 'DeepSeek V4 Flash');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-effort')), ' High');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-period')), ' （峰）');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 ¥2.34');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话 ¥2.34');
  // DOM order: model span, turn button, session button.
  const order = findAll(row)
    .map((node) => node.props && (node.props['data-dsh-turn-model'] ? 'model' : node.props['data-dsh-cost-toggle']))
    .filter(Boolean);
  assert.deepEqual(order, ['model', 'turn', 'session']);
  const turnButton = findByAttr(tree, 'data-dsh-cost-toggle', 'turn');
  assert.equal(turnButton.props['data-dsh-turn-cost'], '1');
});

test('session total sums the displayed amounts of every turn up to this one', () => {
  const tree = ui(
    viewWith([
      entry(1),
      entry(2, { peak: false, period: 'offpeak', costMicro: 1_170_000, costUsdMicro: 175_500 }),
      entry(3, { peak: false, period: 'offpeak', costMicro: 1_170_000, costUsdMicro: 175_500 }),
    ]),
    2,
  );
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 ¥1.17');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话 ¥3.51');
  assert.equal(findByAttr(tree, 'data-dsh-session-cost').props['data-dsh-session-partial'], 'false');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-period')), ' （谷）');
});

test('plan turn shows 订阅额度 wording instead of an amount', () => {
  const plan = entry(1, { pricing: 'plan', plan: true, costMicro: null, costUsdMicro: null, period: 'flat', modelName: 'GPT-5' });
  const tree = ui(viewWith([plan]), 1);
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮消耗订阅额度');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话消耗订阅额度');
});

test('unknown model shows ¥?? and never a fabricated amount', () => {
  const unknown = entry(1, { pricing: 'unknown', costMicro: null, costUsdMicro: null, period: 'flat', provider: 'acme', model: 'mystery' });
  const tree = ui(viewWith([unknown]), 1);
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 ¥??');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话 ¥??');
});

test('free model shows ¥0', () => {
  const free = entry(1, { pricing: 'free', costMicro: 0, costUsdMicro: 0, period: 'flat' });
  const tree = ui(viewWith([free]), 1);
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 ¥0');
  assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话 ¥0');
});

test('mixed plan+priced session is a lower bound (≥) and plan turns are skipped in the sum', () => {
  const plan = entry(1, { pricing: 'plan', plan: true, costMicro: null, costUsdMicro: null, period: 'flat' });
  const tree = ui(viewWith([plan, entry(2)]), 2);
  const session = findByAttr(tree, 'data-dsh-session-cost');
  assert.equal(textOf(session), '会话 ≥ ¥2.34');
  assert.equal(session.props['data-dsh-session-partial'], 'true');
});

test('session token count includes plan-turn tokens', () => {
  const plan = entry(1, { pricing: 'plan', plan: true, costMicro: null, costUsdMicro: null, period: 'flat' });
  const tree = ui(viewWith([plan, entry(2)]), 2);
  const session = findByAttr(tree, 'data-dsh-session-cost');
  // Both turns consumed 1,850,000 tokens; subscription turns still count.
  assert.equal(Number(session.props['data-dsh-session-cost']), TOKENS.total * 2);
});

test('catalog CNY amount carries the ≈ marker', () => {
  const catalog = entry(1, {
    provider: 'openai',
    model: 'gpt-5',
    pricing: 'catalog',
    approxCny: true,
    costMicro: 11_182_500,
    costUsdMicro: 1_575_000,
    period: 'flat',
  });
  const tree = ui(viewWith([catalog]), 1);
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 ≈¥11.182');
});

test('GLM offical RMB amount is exact (no ≈); USD uses the catalog USD list', () => {
  const glm = entry(1, {
    provider: 'zai-coding-cn',
    model: 'glm-5.3-flash',
    modelName: 'GLM-5.3-Flash',
    pricing: 'cny',
    approxCny: false,
    costMicro: 910_000,
    costUsdMicro: 155_000,
    period: 'flat',
  });
  const tree = ui(viewWith([glm]), 1);
  assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 ¥0.91');
  plugin.settings.write({ ...plugin.settings.read(), currency: 'USD' });
  try {
    const usdTree = ui(viewWith([glm]), 1);
    assert.equal(textOf(findByAttr(usdTree, 'data-dsh-turn-cost')), '本轮 $0.155');
  } finally {
    plugin.settings.write({ ...plugin.settings.read(), currency: 'CNY' });
  }
});

test('USD mode uses the official US$ amount, not CNY/7.1', () => {
  plugin.settings.write({ ...plugin.settings.read(), currency: 'USD' });
  try {
    const tree = ui(viewWith([entry(1)]), 1);
    assert.equal(textOf(findByAttr(tree, 'data-dsh-turn-cost')), '本轮 $0.351');
    assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话 $0.351');
  } finally {
    plugin.settings.write({ ...plugin.settings.read(), currency: 'CNY' });
  }
});

test('display toggles hide the turn amount but keep the session amount', () => {
  plugin.settings.write({ ...plugin.settings.read(), showTurn: false, showSession: true });
  try {
    const tree = ui(viewWith([entry(1)]), 1);
    assert.equal(findByAttr(tree, 'data-dsh-cost-toggle', 'turn'), undefined);
    assert.equal(textOf(findByAttr(tree, 'data-dsh-session-cost')), '会话 ¥2.34');
  } finally {
    plugin.settings.write({ ...plugin.settings.read(), showTurn: true, showSession: true });
  }
});

test('both toggles off renders nothing', () => {
  plugin.settings.write({ ...plugin.settings.read(), showTurn: false, showSession: false });
  try {
    assert.equal(ui(viewWith([entry(1)]), 1), null);
  } finally {
    plugin.settings.write({ ...plugin.settings.read(), showTurn: true, showSession: true });
  }
});

test('empty/aborted own turn renders no footer at all', () => {
  const empty = entry(1, { empty: true, costMicro: 0, costUsdMicro: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } });
  resetHooks();
  assert.equal(render(TurnCostBadge, propsFor(viewWith([empty]), 1, 0)), null);
});

test('clicking 本轮 opens the turn dialog with model and amount lines', () => {
  let tree = ui(viewWith([entry(1)]), 1);
  const button = findByAttr(tree, 'data-dsh-cost-toggle', 'turn');
  const currentTarget = {
    getBoundingClientRect: () => ({ top: 600, right: 1000, bottom: 628, left: 900, width: 100, height: 28 }),
    parentElement: null,
    style: undefined,
  };
  button.props.onClick({ stopPropagation() {}, currentTarget });
  // state update happened outside render: re-render with the same hook state
  hookIndex = 0;
  effectQueue = [];
  tree = TurnCostBadge(propsFor(viewWith([entry(1)]), 1));
  const panel = findByAttr(tree, 'data-dsh-cost-panel', 'turn');
  assert.ok(panel, 'turn dialog must open');
  const text = textOf(panel);
  assert.match(text, /本轮费用明细/);
  assert.match(text, /DeepSeek V4 Flash/);
  assert.match(text, /2\.34/);
  assert.equal(findByAttr(tree, 'data-dsh-cost-backdrop') !== undefined, true);
});

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

test('store upserts a projection view and preserves null costs for unknown turns', () => {
  const storage = memoryStorage();
  const store = plugin.store.create({ storage });
  const unknown = entry(2, { pricing: 'unknown', costMicro: null, costUsdMicro: null });
  store.upsertSession(viewWith([entry(1), unknown]));
  const record = store.getSession('s1');
  assert.equal(record.turns['s1:1'].costMicro, 2_340_000);
  assert.equal(record.turns['s1:1'].costUsdMicro, 351_000);
  assert.equal(record.turns['s1:2'].costMicro, null);
  assert.equal(record.turns['s1:1'].period, 'peak');
  assert.equal(record.session.usdPriceVersion, 'deepseek-usd-2026-11-11');
  assert.equal(record.session.turns, 2);
});

test('store rejects a wrong version / corrupt JSON and starts blank', () => {
  const storage = memoryStorage();
  storage.setItem(plugin.store.key, JSON.stringify({ v: 99, sessions: { x: {} } }));
  const store = plugin.store.create({ storage });
  assert.equal(store.getSession('x'), undefined);
  storage.setItem(plugin.store.key, '{not json');
  assert.equal(store.getSession('x'), undefined);
  store.upsertSession(viewWith([entry(1)]));
  assert.equal(store.getSession('s1').turns['s1:1'].costMicro, 2_340_000);
});

test('store notifies subscribers and supports title/remove/list', () => {
  const storage = memoryStorage();
  const store = plugin.store.create({ storage });
  let calls = 0;
  const off = store.subscribe(() => {
    calls += 1;
  });
  store.upsertSession(viewWith([entry(1)]));
  store.setSessionTitle('s1', '新标题');
  assert.equal(store.getSession('s1').title, '新标题');
  assert.equal(store.sessionList().length, 1);
  store.removeSession('s1');
  assert.equal(store.getSession('s1'), undefined);
  assert.ok(calls >= 3);
  off();
});

test('a throwing storage keeps the record readable from the in-memory copy', () => {
  const failing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {},
  };
  const store = plugin.store.create({ storage: failing });
  store.upsertSession(viewWith([entry(1)]));
  const kept = store.getSession('s1');
  assert.ok(kept, 'record survives a rejected localStorage write');
  assert.equal(kept.sessionId, 's1');
  assert.equal(kept.turns['s1:1'].costMicro, 2_340_000);
});

/* ------------------------------------------------------------------ */
/* settings + currency                                                 */
/* ------------------------------------------------------------------ */

test('settings read/write round-trips toggles, currency and range', () => {
  localStorage.raw.clear();
  const defaults = plugin.settings.read();
  assert.equal(defaults.showTurn, true);
  assert.equal(defaults.showSession, true);
  plugin.settings.write({ cny: 10, usd: 2, currency: 'USD', showTurn: false, showSession: true, showBudget: true, range: '7d' });
  const stored = plugin.settings.read();
  assert.equal(stored.cny, 10);
  assert.equal(stored.usd, 2);
  assert.equal(stored.currency, 'USD');
  assert.equal(stored.showTurn, false);
  assert.equal(stored.range, '7d');
  assert.equal(plugin.currency.active(), 'USD');
  plugin.currency.set('CNY');
  assert.equal(plugin.currency.active(), 'CNY');
});

/* ------------------------------------------------------------------ */
/* Excel export                                                        */
/* ------------------------------------------------------------------ */

/** Read a stored-only ZIP produced by the plugin (method 0). */
function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, decoder.decode(bytes.subarray(start, start + size)));
    offset = start + size;
  }
  return files;
}

test('Excel export: headers, group/session rows, total, XML escaping', () => {
  const labels = {
    group: '分组',
    session: '会话',
    id: 'ID',
    time: '时间',
    amount: '金额（人民币）',
    turns: '轮次',
    total: '合计',
    sheet: '计费明细',
  };
  const bytes = plugin.excel.buildWorkbook(
    [
      { kind: 'group', title: '项目 & <A>', amountMicro: 13_260_000 },
      { kind: 'session', title: '会话 1', sessionId: 's1', time: '2026-11-16 10:00', amountMicro: 3_510_000, turns: 2 },
      { kind: 'session', title: '会话 2', sessionId: 's2', time: '2026-11-16 11:00', amountMicro: 9_750_000, turns: 1 },
    ],
    labels,
  );
  assert.ok(bytes instanceof Uint8Array);
  const files = unzipStored(bytes);
  assert.deepEqual(
    [...files.keys()].sort(),
    ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'],
  );
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /分组/);
  assert.match(files.get('xl/workbook.xml'), /计费明细/);
  assert.match(sheet, /项目 &amp; &lt;A&gt;/);
  assert.match(sheet, /<v>13\.26<\/v>/);
  assert.match(sheet, /<v>3\.51<\/v>/);
  assert.match(sheet, /<v>9\.75<\/v>/);
  // Total = sum of session rows only (13.26), not group + sessions (26.52).
  assert.match(sheet, /<v>13\.26<\/v>/);
  assert.equal((sheet.match(/<v>26\.52<\/v>/g) || []).length, 0);
  assert.match(sheet, /t="inlineStr"/);
  assert.match(sheet, /合计/);
});

test('Excel date stamp and file name are local-time YYYYMMDD-HHmm', () => {
  const date = new Date(2026, 10, 16, 9, 5);
  assert.equal(plugin.excel.dateStamp(date), '20261116-0905');
  assert.equal(plugin.excel.fileName(date), '计费明细-20261116-0905.xlsx');
});

test('flat-priced turns show no （峰）/（谷） tag even when peak=true', () => {
  const legacy = entry(1, { period: 'flat', modelName: 'DeepSeek Chat' });
  const tree = ui(viewWith([legacy]), 1);
  assert.equal(findByAttr(tree, 'data-dsh-turn-period'), undefined);
});

test('clicking 会话 opens the session dialog with a ≥ bound for a mixed session', () => {
  const plan = entry(1, { pricing: 'plan', plan: true, costMicro: null, costUsdMicro: null, period: 'flat' });
  const view = viewWith([plan, entry(2)]);
  let tree = ui(view, 2);
  const button = findByAttr(tree, 'data-dsh-cost-toggle', 'session');
  const currentTarget = {
    getBoundingClientRect: () => ({ top: 580, right: 1000, bottom: 608, left: 900, width: 100, height: 28 }),
    parentElement: null,
    style: undefined,
  };
  button.props.onClick({ stopPropagation() {}, currentTarget });
  hookIndex = 0;
  effectQueue = [];
  tree = TurnCostBadge(propsFor(view, 2));
  const panel = findByAttr(tree, 'data-dsh-cost-panel', 'session');
  assert.ok(panel, 'session dialog must open');
  const text = textOf(panel);
  assert.match(text, /会话费用明细/);
  assert.match(text, /≥/);
  assert.match(text, /2\.34/);
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
