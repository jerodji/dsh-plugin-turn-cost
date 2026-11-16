/**
 * selection-log.js — debounce, atomic replace, corrupt-file recovery and the
 * concurrent-flush lost-update check.
 *
 * Run: node tests/selection-log.test.mjs
 *
 * The module computes its store path from os.homedir() at import time, so HOME
 * is redirected to a throwaway /tmp directory before the dynamic import.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-turn-cost-sel-'));
process.env.HOME = ROOT;
fs.mkdirSync(path.join(ROOT, '.dsh'), { recursive: true });

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'selection-log.js')).href;
const log = await import(moduleUrl);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readStore = () => JSON.parse(fs.readFileSync(log.SELECTION_FILE, 'utf8'));

await test('HOME is redirected and the store path lives under it', () => {
  assert.equal(log.SELECTION_FILE, path.join(ROOT, '.dsh', 'turn-cost-selections.json'));
  assert.equal(log.SELECTION_STORE_VERSION, 1);
});

await test('rememberSelection validates sessionId/turn/selection', () => {
  log.rememberSelection('', 1, { model: 'm' });
  log.rememberSelection('s', 0, { model: 'm' });
  log.rememberSelection('s', -1, { model: 'm' });
  log.rememberSelection('s', 1, null);
  log.rememberSelection('s', 1, {});
  assert.equal(log.lookupSelection('s', 1), undefined);
  log.rememberSelection('s', 1, { model: 'valid', step: 2 });
  assert.equal(log.lookupSelection('s', 1).model, 'valid');
});

await test('debounced write lands within ~800 ms without an explicit flush', async () => {
  log.rememberSelection('debounce', 1, { provider: 'deepseek', model: 'deepseek-v4-flash', effort: 'high' });
  assert.equal(fs.existsSync(log.SELECTION_FILE), false, 'write must be debounced, not immediate');
  await sleep(950);
  assert.equal(fs.existsSync(log.SELECTION_FILE), true);
  const stored = readStore();
  assert.equal(stored.v, 1);
  assert.equal(stored.sessions.debounce['1'].model, 'deepseek-v4-flash');
});

await test('flushSelections writes atomically (tmp renamed, no .tmp left behind)', async () => {
  log.rememberSelection('atomic', 1, { model: 'm-atomic', step: 0 });
  await log.flushSelections();
  assert.equal(fs.existsSync(log.SELECTION_FILE + '.tmp'), false);
  const stored = readStore();
  assert.equal(stored.sessions.atomic['1'].model, 'm-atomic');
});

await test('last step wins but a partial selection keeps the previous fields', () => {
  log.rememberSelection('merge', 1, { provider: 'p', model: 'm1', effort: 'high', step: 1 });
  log.rememberSelection('merge', 1, { effort: 'low', step: 2 });
  const record = log.lookupSelection('merge', 1);
  assert.equal(record.provider, 'p');
  assert.equal(record.model, 'm1');
  assert.equal(record.effort, 'low');
  assert.equal(record.step, 2);
});

await test('a flush during an in-flight write still persists the newer selection', async () => {
  log.rememberSelection('race', 1, { model: 'first', effort: 'high' });
  const first = log.flushSelections(); // snapshot may contain "first"
  log.rememberSelection('race', 1, { model: 'second', effort: 'low' }); // schedules a timer
  const second = log.flushSelections(); // must queue a fresh write
  await Promise.all([first, second]);
  await sleep(950); // give the debounce timer every chance to fire
  const stored = readStore();
  assert.equal(stored.sessions.race['1'].model, 'second');
  assert.equal(stored.sessions.race['1'].effort, 'low');
});

await test('corrupt file on disk is treated as empty (fresh process)', () => {
  const file = path.join(ROOT, '.dsh', 'turn-cost-selections.json');
  fs.writeFileSync(file, '{"v":1,"sessions":', 'utf8');
  const script = `
    import { loadSelections, lookupSelection, SELECTION_FILE } from ${JSON.stringify(moduleUrl)};
    await loadSelections();
    const hit = lookupSelection('anything', 1);
    process.stdout.write(JSON.stringify({ file: SELECTION_FILE, hit: hit ?? null }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: ROOT },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hit, null);
  assert.equal(parsed.file, file);
});

await test('a valid file is loaded once at startup (fresh process)', () => {
  const file = path.join(ROOT, '.dsh', 'turn-cost-selections.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ v: 1, sessions: { restored: { 3: { provider: 'p', model: 'm-restored', effort: 'max', step: 4, at: 1 } } } }),
    'utf8',
  );
  const script = `
    import { loadSelections, lookupSelection } from ${JSON.stringify(moduleUrl)};
    await loadSelections();
    process.stdout.write(JSON.stringify(lookupSelection('restored', 3)));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: ROOT },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { provider: 'p', model: 'm-restored', effort: 'max', step: 4, at: 1 });
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
