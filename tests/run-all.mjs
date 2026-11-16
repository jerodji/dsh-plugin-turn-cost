/**
 * Run every turn-cost test suite and print a compact summary.
 *
 * Run: node tests/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

let failedFiles = 0;
let passed = 0;
let failed = 0;

for (const file of files) {
  const run = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const match = output.match(/(\d+)\/(\d+) passed, (\d+) failed/);
  const line = match ? match[0] : `exit ${run.status}`;
  if (match) {
    passed += Number(match[1]);
    failed += Number(match[3]);
  }
  const ok = run.status === 0 && (!match || Number(match[3]) === 0);
  if (!ok) failedFiles += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${file.padEnd(26)} ${line}`);
  if (!ok) console.log(output.split('\n').filter((row) => row.startsWith('FAIL')).join('\n'));
}

console.log(`\n${files.length - failedFiles}/${files.length} suites, ${passed} passed, ${failed} failed`);
process.exit(failedFiles === 0 ? 0 : 1);
