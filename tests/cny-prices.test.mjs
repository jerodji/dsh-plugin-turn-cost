/**
 * prices/cny-models.json + cny-prices.js — the local RMB price file.
 *
 * Run: node tests/cny-prices.test.mjs
 *
 * The real data file is exercised here, so a typo in the shipped JSON (bad
 * regex, non-numeric price, missing rates) fails the suite instead of silently
 * dropping a vendor. Prices are 元 per 1,000,000 tokens.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cnyPriceBookInfo,
  cnyPriceFor,
  setCnyPriceBook,
} from '../cny-prices.js';

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

const book = JSON.parse(fs.readFileSync(new URL('../prices/cny-models.json', import.meta.url), 'utf8'));
setCnyPriceBook(book);
const info = cnyPriceBookInfo();

/** Token buckets like the projection stores them. */
function tokens(uncachedInput, cacheRead, output, cacheWrite = 0) {
  return { uncachedInput, cacheRead, cacheWrite, output, total: uncachedInput + cacheRead + cacheWrite + output };
}

test('the shipped CNY file loads with entries for every domestic vendor', () => {
  assert.ok(info.entries > 0, 'expected at least one price entry');
  assert.notEqual(info.version, 'none');
  const vendors = new Set(book.providers.map((provider) => provider.id));
  assert.ok(vendors.has('zhipu'), 'zhipu (GLM) section');
  assert.ok(vendors.has('moonshot'), 'moonshot (Kimi) section');
  assert.ok(vendors.has('qwen'), 'qwen (Alibaba) section');
  assert.ok(vendors.has('doubao'), 'doubao (ByteDance) section');
});

test('GLM-5.3 uses the official RMB list (¥8 / ¥28 / ¥2)', () => {
  const rates = cnyPriceFor('zai-coding-cn', 'glm-5.3', tokens(1_000_000, 0, 0));
  assert.deepEqual(rates, { input: 8, output: 28, cacheRead: 2, cacheWrite: 0 });
});

test('the vendor pattern gates the table: the same id from another provider is not RMB-priced', () => {
  assert.equal(cnyPriceFor('openrouter', 'glm-5.3', tokens(1000, 0, 100)), undefined);
  assert.equal(cnyPriceFor('zai', 'glm-5.3', tokens(1000, 0, 100)).input, 8);
  assert.equal(cnyPriceFor('bigmodel', 'glm-5.3', tokens(1000, 0, 100)).input, 8);
});

test('input-length tiers switch exactly at the documented bound (32K)', () => {
  const below = cnyPriceFor('zai-coding-cn', 'glm-5.1', tokens(32767, 0, 100));
  const at = cnyPriceFor('zai-coding-cn', 'glm-5.1', tokens(32768, 0, 100));
  assert.equal(below.input, 6);
  assert.equal(below.output, 24);
  assert.equal(at.input, 8);
  assert.equal(at.output, 28);
});

test('output-length tiers apply only under the published output bound (GLM-4.7)', () => {
  // input < 32K, output < 200 -> ¥2 / ¥8
  assert.equal(cnyPriceFor('zai-coding-cn', 'glm-4.7', tokens(1000, 0, 199)).output, 8);
  // same input, output reaches 200 -> ¥3 / ¥14
  assert.equal(cnyPriceFor('zai-coding-cn', 'glm-4.7', tokens(1000, 0, 200)).output, 14);
  // input reaches 32K -> widest tier ¥4 / ¥16
  assert.equal(cnyPriceFor('zai-coding-cn', 'glm-4.7', tokens(33000, 0, 200)).output, 16);
});

test('a free model is represented as zero rates, not a missing entry', () => {
  const rates = cnyPriceFor('zai-coding-cn', 'glm-4.7-flash', tokens(1_000_000, 0, 1_000_000));
  assert.deepEqual(rates, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});


test('Qwen tiers and fixed cache-hit prices come from the file', () => {
  // qwen3.7-plus: 2/8 under 256K, 6/24 at or above it
  assert.equal(cnyPriceFor('qwen', 'qwen3.7-plus', tokens(1000, 0, 100)).input, 2);
  assert.equal(cnyPriceFor('qwen', 'qwen3.7-plus', tokens(262144, 0, 100)).input, 6);
  // qwen-max is flat and cache-hit is a fixed 0.48 (not 20% of input)
  const max = cnyPriceFor('dashscope', 'qwen-max', tokens(1000, 1000, 100));
  assert.equal(max.input, 2.4);
  assert.equal(max.cacheRead, 0.48);
  // qwen3.8-max has no published cache hit price -> 0, not invented
  assert.equal(cnyPriceFor('qwen', 'qwen3.8-max', tokens(1000, 0, 10)).cacheRead, 0);
});

test('Doubao seed 2.x prices and input-length tiers', () => {
  const pro = cnyPriceFor('doubao', 'doubao-seed-2.1-pro', tokens(1000, 0, 100));
  assert.deepEqual(pro, { input: 6, output: 30, cacheRead: 1.2, cacheWrite: 0 });
  // seed 2.0 mini: 0.2/2 below 32K, 0.4/4 from 32K
  assert.equal(cnyPriceFor('volcengine', 'doubao-seed-2.0-mini', tokens(1000, 0, 10)).input, 0.2);
  assert.equal(cnyPriceFor('volcengine', 'doubao-seed-2.0-mini', tokens(32768, 0, 10)).input, 0.4);
  // the same id resold through another provider is not on the official RMB card
  assert.equal(cnyPriceFor('openrouter', 'doubao-seed-2.1-pro', tokens(1000, 0, 10)), undefined);
});
test('Kimi k3.1-pro carries the published cache-write price', () => {
  const rates = cnyPriceFor('moonshot', 'kimi-k3.1-pro', tokens(0, 0, 0, 1000));
  assert.equal(rates.input, 13);
  assert.equal(rates.output, 68);
  assert.equal(rates.cacheRead, 1.3);
  assert.equal(rates.cacheWrite, 13);
});

test('cacheRead tokens count toward the tier boundary', () => {
  // 31K cache-hit + 2K cache-miss = 33K prompt -> wide tier of GLM-5.1
  const rates = cnyPriceFor('zai-coding-cn', 'glm-5.1', tokens(2000, 31000, 10));
  assert.equal(rates.input, 8);
});

test('an empty/invalid book falls back to "no RMB price" instead of crashing', () => {
  setCnyPriceBook({ providers: [{ id: 'bad', providerPattern: '(', entries: [{ match: '(', input: 1 }] }] });
  assert.equal(cnyPriceBookInfo().version, 'none');
  assert.equal(cnyPriceFor('zai-coding-cn', 'glm-5.3', tokens(1000, 0, 10)), undefined);
  setCnyPriceBook(book);
});

const passed = results.length - failed;
for (const row of results) {
  if (row.ok) console.log(`  ok  ${row.name}`);
  else console.log(`  FAIL ${row.name}\n    ${row.error && row.error.message}`);
}
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
