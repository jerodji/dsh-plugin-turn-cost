/**
 * price-catalog.js — offline catalog parsing, credential-based plan detection.
 *
 * Run: node tests/price-catalog.test.mjs
 *
 * The desktop asar is not readable by plain Node on this machine and its
 * unpacked directory has no pi-ai data, so every case below uses fixtures in a
 * temp dir pointed at by DSH_PI_AI_DATA / DSH_PI_AI_PROVIDERS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectPlanProviders,
  loadPriceCatalog,
  planProvidersFromRecords,
} from '../price-catalog.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-turn-cost-cat-'));
const DATA = path.join(ROOT, 'data');
const PROVIDERS = path.join(ROOT, 'providers');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PROVIDERS, { recursive: true });

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

const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text, 'utf8');

/* provider definitions: only the auth shape is read by readProviderAuth */
write(
  PROVIDERS,
  'chatgpt.js',
  'export const p = createProvider({ id: "chatgpt", auth: { oauth: lazyOAuth({ isSubscription: true }) } });',
);
write(
  PROVIDERS,
  'openai.js',
  'export const p = createProvider({ id: "openai", auth: { oauth: lazyOAuth({ isSubscription: true }), apiKey: envKey("OPENAI_API_KEY") } });',
);
write(
  PROVIDERS,
  'zai.js',
  'export const p = createProvider({ id: "zai-coding-cn", auth: { apiKey: envKey("ZAI_API_KEY") } });',
);
write(
  PROVIDERS,
  'openrouter.js',
  'export const p = createProvider({ id: "openrouter", auth: { oauth: lazyOAuth({}) } });',
);
write(PROVIDERS, 'chatgpt.models.js', 'createProvider({ id: "should-be-ignored", auth: {} });');
write(PROVIDERS, 'not-a-provider.js', 'export const x = 1;');

/* catalog files: { <api>: { <modelKey>: { id?, provider?, name?, cost } } } */
write(
  DATA,
  'openai.json',
  JSON.stringify({
    responses: {
      'gpt-5': { provider: 'openai', name: 'GPT-5', cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
      'gpt-5-mini': { provider: 'openai', cost: { input: 0.25, output: 2 } },
    },
    chat: {
      'chat:gpt-4o': { provider: 'openai', id: 'gpt-4o', cost: { input: 2.5, output: 10, cacheWrite: 3 } },
    },
  }),
);
write(
  DATA,
  'local.json',
  JSON.stringify({
    api: {
      'free-model': { provider: 'local', name: 'Free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      'bad-cost': { provider: 'local', cost: { output: 1 } },
      'nan-cost': { provider: 'local', cost: { input: 'x', output: 1 } },
    },
  }),
);
/* duplicate id inside one provider: the first parsed record wins */
write(
  DATA,
  'dupe.json',
  JSON.stringify({
    api: {
      first: { provider: 'dupe', id: 'same', cost: { input: 1, output: 1 } },
      second: { provider: 'dupe', id: 'same', cost: { input: 9, output: 9 } },
    },
  }),
);

test('provider auth scan separates subscription-only, both-route and api-key providers', () => {
  process.env.DSH_PI_AI_DATA = DATA;
  process.env.DSH_PI_AI_PROVIDERS = PROVIDERS;
  const book = loadPriceCatalog();
  assert.deepEqual(book.plans, ['chatgpt']);
  assert.deepEqual(book.oauthSubscriptions.sort(), ['chatgpt', 'openai']);
  assert.deepEqual(book.apiKeyProviders.sort(), ['openai', 'zai-coding-cn']);
  delete process.env.DSH_PI_AI_DATA;
  delete process.env.DSH_PI_AI_PROVIDERS;
});

test('a missing providers directory yields empty auth sets (no throw)', () => {
  process.env.DSH_PI_AI_DATA = DATA;
  process.env.DSH_PI_AI_PROVIDERS = path.join(ROOT, 'nope');
  const book = loadPriceCatalog();
  assert.ok(book);
  assert.deepEqual(book.plans, []);
  assert.deepEqual(book.oauthSubscriptions, []);
  delete process.env.DSH_PI_AI_DATA;
  delete process.env.DSH_PI_AI_PROVIDERS;
});

test('planProvidersFromRecords: OAuth grant on a subscription provider is a plan', () => {
  const plans = planProvidersFromRecords(
    [{ key: 'llm-pi-ai/chatgpt', kind: 'grant' }],
    ['chatgpt', 'openai'],
  );
  assert.deepEqual(plans, ['chatgpt']);
});

test('planProvidersFromRecords: API key is metered even for a subscription provider', () => {
  const plans = planProvidersFromRecords(
    [{ key: 'llm-pi-ai/openai', kind: 'api-key' }],
    ['openai'],
  );
  assert.deepEqual(plans, []);
});

test('planProvidersFromRecords: grant on a non-subscription OAuth provider is metered', () => {
  const plans = planProvidersFromRecords(
    [{ key: 'llm-pi-ai/openrouter', kind: 'grant' }],
    ['chatgpt', 'openai'],
  );
  assert.deepEqual(plans, []);
});

test('planProvidersFromRecords: ignores non-pi-ai keys and provider ids are lowercased', () => {
  const plans = planProvidersFromRecords(
    [
      { key: 'deepseek/account', kind: 'grant' },
      { key: 'llm-pi-ai/CHATGPT', kind: 'grant' },
      { key: 'llm-pi-ai/chatgpt/sub-2', kind: 'grant' },
    ],
    ['chatgpt'],
  );
  assert.deepEqual(plans, ['chatgpt']);
});

test('detectPlanProviders unions credential grants with subscription display names', () => {
  const plans = detectPlanProviders(
    { oauthSubscriptions: ['chatgpt', 'openai'] },
    [{ key: 'llm-pi-ai/chatgpt', kind: 'grant' }],
    [
      { id: 'claude', name: 'Claude Subscription' },
      { id: 'codex', name: 'ChatGPT' },
      { id: 'copilot', name: 'GitHub Copilot' },
      { id: 'antigravity', name: 'Antigravity' },
      { id: 'kimi', name: 'Kimi 订阅' },
      { id: 'zai', name: 'Z.AI' },
      { id: 'no-name' },
      { id: '', name: 'ChatGPT' },
    ],
  ).sort();
  assert.deepEqual(plans, ['antigravity', 'chatgpt', 'claude', 'codex', 'copilot', 'kimi']);
});

test('detectPlanProviders: a metered API key on the same id does not become a plan by name', () => {
  const plans = detectPlanProviders(
    { plans: [], oauthSubscriptions: ['openai'] },
    [{ key: 'llm-pi-ai/openai', kind: 'api-key' }],
    [{ id: 'openai', name: 'OpenAI' }],
  );
  assert.deepEqual(plans, []);
});

test('loadPriceCatalog reads nested api tables, defaults cache rates, resolves ids', () => {
  process.env.DSH_PI_AI_DATA = DATA;
  process.env.DSH_PI_AI_PROVIDERS = PROVIDERS;
  const book = loadPriceCatalog();
  assert.ok(book, 'expected a catalog');
  assert.equal(book.version, 'pi-ai-catalog');
  assert.equal(book.providers.openai['gpt-5'].input, 1.25);
  assert.equal(book.providers.openai['gpt-5'].output, 10);
  assert.equal(book.providers.openai['gpt-5'].cacheRead, 0.125);
  assert.equal(book.providers.openai['gpt-5'].cacheWrite, 0);
  assert.equal(book.providers.openai['gpt-5-mini'].cacheRead, 0);
  assert.equal(book.providers.openai['gpt-4o'].cacheWrite, 3, 'chat: prefix stripped');
  assert.deepEqual(book.plans, ['chatgpt']);
  assert.deepEqual(book.oauthSubscriptions.sort(), ['chatgpt', 'openai']);
  delete process.env.DSH_PI_AI_DATA;
  delete process.env.DSH_PI_AI_PROVIDERS;
});

test('loadPriceCatalog skips records without a finite input/output cost', () => {
  process.env.DSH_PI_AI_DATA = DATA;
  const book = loadPriceCatalog();
  assert.equal(book.providers.local['bad-cost'], undefined);
  assert.equal(book.providers.local['nan-cost'], undefined);
  delete process.env.DSH_PI_AI_DATA;
});

test('duplicate provider/model id keeps the first record and counts it once', () => {
  process.env.DSH_PI_AI_DATA = DATA;
  const book = loadPriceCatalog();
  assert.equal(book.providers.dupe.same.input, 1);
  // openai 3 + local free 1 + dupe 1 = 5
  assert.equal(book.models, 5);
  delete process.env.DSH_PI_AI_DATA;
});

test('loadPriceCatalog returns undefined when no catalog directory is readable', () => {
  delete process.env.DSH_PI_AI_DATA;
  delete process.env.DSH_PI_AI_PROVIDERS;
  // Plain Node has no process.resourcesPath, so candidateDirs() is empty here.
  assert.equal(loadPriceCatalog(), undefined);
});

for (const result of results) {
  if (result.ok) console.log(`PASS  ${result.name}`);
  else {
    console.log(`FAIL  ${result.name}`);
    console.log(`      ${String(result.error && result.error.message).split('\n').join('\n      ')}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* best effort */
}
process.exit(failed === 0 ? 0 : 1);
