// tests/tracker-delete-safety.test.mjs — `tracker.mjs delete` refuses anything
// it does not recognize, and backs the tracker up before it removes a row.
//
// The preview was selected by an exact `--dry-run` and nothing rejected the
// rest, so `delete --num 42 --dryrun` (or `--dry_run`, `-n`, `--dry-run=true`)
// fell through to the real delete: the row, its status, report link and notes
// were gone, and unlike every other tracker writer this one left no `.bak`.
//
// Each case runs the real CLI against its own temp tracker and asserts on the
// file afterwards, because the bytes left on disk are what the user loses.
import { pass, fail, rmSync, ROOT, NODE } from './helpers.mjs';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ok = async (name, fn) => { try { await fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 41 | 2026-09-01 | Acme | Backend Engineer | 4.2/5 | Evaluated | ❌ | [41](reports/041-acme-2026-09-01.md) | keep |',
  '| 42 | 2026-09-02 | Beta | Data Analyst | 3.9/5 | Interview | ✅ | [42](reports/042-beta-2026-09-02.md) | onsite booked |',
  '',
].join('\n');

async function sandbox(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracker-delete-test-')));
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, TRACKER);
  const cli = (...args) => {
    const r = spawnSync(NODE, [join(ROOT, 'tracker.mjs'), 'delete', ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_TRACKER_DB: join(dir, 'applications.db') },
    });
    return { status: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const untouched = () => {
    assert.equal(readFileSync(tracker, 'utf-8'), TRACKER, 'the tracker was modified');
    assert.ok(!existsSync(`${tracker}.bak`), 'a .bak was written although nothing was deleted');
  };
  // await: the in-process case is async, and the directory must outlive it.
  try { return await fn({ dir, tracker, cli, untouched }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Every near miss of --dry-run a person or an agent plausibly types, plus the
// stray tokens that used to be ignored. `--num 42` is valid in all of them, so
// the only thing standing between each line and a real delete is the check.
const REJECTED = [
  ['--num', '42', '--dryrun'],
  ['--num', '42', '--dry_run'],
  ['--num', '42', '-n'],
  ['--num', '42', '--dry-run=true'],
  ['--num', '42', '--dry'],
  ['--num', '42', '--force'],
  ['--num=42', '--dryrun'],
  ['--dryrun', '--num', '42'],
  ['--num', '42', '--dry-run', '--verbose'],
  ['--num', '42', 'dry-run'],
  ['42', '--num', '42'],
];

for (const args of REJECTED) {
  await ok(`delete ${args.join(' ')} exits non-zero and deletes nothing`, () => sandbox(({ cli, untouched }) => {
    const r = cli(...args);
    assert.equal(r.status, 1, `exit ${r.status}\n${r.all}`);
    assert.match(r.all, /unrecognized flag/i);
    assert.match(r.all, /Usage: node tracker\.mjs delete/);
    untouched();
  }));
}

await ok('delete --num 42 --dry-run previews and deletes nothing', () => sandbox(({ cli, untouched }) => {
  const r = cli('--num', '42', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /Would remove application 42/);
  untouched();
}));

await ok('delete --num=42 --dry-run is the same preview', () => sandbox(({ cli, untouched }) => {
  const r = cli('--num=42', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /Would remove application 42/);
  untouched();
}));

await ok('delete --num 42 removes the row and leaves a .bak of the pre-delete tracker', () => sandbox(({ tracker, cli }) => {
  const r = cli('--num', '42');
  assert.equal(r.status, 0, r.all);
  const after = readFileSync(tracker, 'utf-8');
  assert.ok(!after.includes('| 42 |'), 'row 42 is still in the tracker');
  assert.ok(after.includes('| 41 | 2026-09-01 | Acme |'), 'row 41 was lost');
  assert.ok(existsSync(`${tracker}.bak`), 'no .bak was written');
  assert.equal(readFileSync(`${tracker}.bak`, 'utf-8'), TRACKER, 'the .bak is not the pre-delete tracker');
  assert.ok(r.all.includes(`${tracker}.bak`), 'the output does not say where the backup is');
}));

await ok('a delete that finds no such row writes no .bak', () => sandbox(({ cli, untouched }) => {
  const r = cli('--num', '99');
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /No application numbered 99/);
  untouched();
}));

await ok('delete with no --num still prints usage and deletes nothing', () => sandbox(({ cli, untouched }) => {
  const r = cli();
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /Usage: node tracker\.mjs delete/);
  untouched();
}));

// In-process callers get a status back instead of a dead process: the check
// must go through runTracker's own exit path, not process.exit().
const { runTracker } = await import(pathToFileURL(join(ROOT, 'tracker.mjs')).href);
await ok('runTracker("delete") returns 1 on an unknown flag without exiting the process', () => sandbox(async ({ tracker, dir, untouched }) => {
  let stderr = '';
  const code = await runTracker('delete', ['--num', '42', '--dryrun'], {
    mdPath: tracker,
    dbPath: join(dir, 'applications.db'),
    stdout: { write() {} },
    stderr: { write: (s) => { stderr += s; } },
  });
  assert.equal(code, 1);
  assert.match(stderr, /unrecognized flag\(s\) or argument\(s\): --dryrun/);
  untouched();
}));
