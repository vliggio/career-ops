// tests/status-aliases-from-states.test.mjs — dedup-tracker, analyze-patterns
// and tracker-sync-check resolve statuses through templates/states.yml.
//
// All three used to carry a hand-copied alias table. The copies had drifted
// from states.yml (no Turkish alias in any of them) and from each other, and
// the cost was not cosmetic: dedup-tracker ranked `Mülakat` (states.yml's alias
// for Interview) as an unknown status, so its advanced-status guard did not
// protect the row and a higher-scored `Evaluated` duplicate deleted it.
//
// Every assertion below iterates states.yml itself, so an alias added there is
// covered here without touching this file.
import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ok = (name, fn) => { try { fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };
const load = (file) => import(pathToFileURL(join(ROOT, file)).href);

const { loadCanonicalStates, resolveCanonicalStateId } = await load('tracker-utils.mjs');
const states = loadCanonicalStates(join(ROOT, 'templates', 'states.yml'));
// Every spelling states.yml accepts for a state: its id, label and aliases.
const spellings = (s) => [s.id, s.label, ...s.aliases];

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEP = '|---|---|---|---|---|---|---|---|---|';

function dedup(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'status-aliases-test-'));
  const tracker = join(dir, 'applications.md');
  try {
    writeFileSync(tracker, ['# Applications Tracker', '', HEADER, SEP, ...rows, ''].join('\n'));
    execFileSync(process.execPath, [join(ROOT, 'dedup-tracker.mjs')], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, CAREER_OPS_TRACKER: tracker },
    });
    return readFileSync(tracker, 'utf-8').split('\n')
      .filter(l => /^\|\s*\d+\s*\|/.test(l))
      .map(l => l.split('|').map(c => c.trim()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

ok('resolveCanonicalStateId maps every states.yml spelling to its id', () => {
  for (const s of states) {
    for (const text of spellings(s)) {
      assert.equal(resolveCanonicalStateId(text, states), s.id, `"${text}"`);
    }
  }
  assert.equal(resolveCanonicalStateId('**Mülakat** 2026-06-01', states), 'interview', 'bold and a trailing date are stripped');
  assert.equal(resolveCanonicalStateId('TEKLİF', states), 'offer', 'Turkish dotted capital I folds');
  assert.equal(resolveCanonicalStateId('not a status', states), null);
  assert.equal(resolveCanonicalStateId('', states), null);
});

ok('none of the three scripts carries its own alias table', () => {
  for (const file of ['dedup-tracker.mjs', 'analyze-patterns.mjs', 'tracker-sync-check.mjs']) {
    const src = readFileSync(join(ROOT, file), 'utf-8');
    assert.match(src, /resolveCanonicalStateId\(/, `${file} resolves through states.yml`);
    assert.match(src, /loadCanonicalStates\(/, `${file} loads states.yml`);
    // An alias is by definition not an id; a quoted one outside the self-test
    // fixtures is a table growing back.
    const body = src.split(/\n(?:async )?function runSelfTest\b/)[0];
    for (const s of states) {
      for (const alias of s.aliases.filter(a => !states.some(o => o.id === a))) {
        assert.ok(!body.includes(`'${alias}':`), `${file} hardcodes the alias '${alias}'`);
      }
    }
  }
});

ok('dedup-tracker: a `Mülakat` row is not deleted in favour of a higher-scored Evaluated row', () => {
  const rows = dedup([
    '| 12 | 2026-09-01 | Acme | Backend Engineer | 4.5/5 | Evaluated | ❌ | [12](reports/012-acme-2026-09-01.md) | rescored |',
    '| 31 | 2026-09-10 | Acme | Backend Engineer | 4.0/5 | Mülakat | ✅ | [31](reports/031-acme-2026-09-10.md) | onsite booked |',
  ]);
  const interview = rows.find(r => r[1] === '31');
  assert.ok(interview, 'the interview-stage row survives');
  assert.equal(interview[6], 'Mülakat');
});

ok('dedup-tracker: every states.yml spelling of an in-flight state protects its row', () => {
  const inFlight = ['applied', 'responded', 'assessment', 'interview', 'offer', 'hired'];
  const cases = states.filter(s => inFlight.includes(s.id)).flatMap(spellings);
  assert.ok(cases.length > inFlight.length, 'states.yml supplies aliases to test');
  const input = cases.flatMap((status, i) => [
    `| ${i * 2 + 1} | 2026-09-01 | Co${i} | Data Analyst | 4.5/5 | Evaluated | ❌ | — | repost |`,
    `| ${i * 2 + 2} | 2026-09-02 | Co${i} | Data Analyst | 3.0/5 | ${status} | ❌ | — | in flight |`,
  ]);
  const survivors = new Set(dedup(input).map(r => r[1]));
  const deleted = cases.filter((_, i) => !survivors.has(String(i * 2 + 2)));
  assert.deepEqual(deleted, [], 'in-flight rows deleted');
});

ok('dedup-tracker: a pre-application alias still merges, and the more advanced one wins the status', () => {
  // `verificar` and `evaluada` both mean Evaluated, so the pair is a real
  // duplicate; `rechazado` (Rejected) ranks below it and must not be promoted.
  const merged = dedup([
    '| 1 | 2026-09-01 | Acme | Backend Engineer | 4.5/5 | rechazado | ❌ | — | first |',
    '| 2 | 2026-09-02 | Acme | Backend Engineer | 4.0/5 | verificar | ❌ | — | second |',
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0][1], '1', 'the higher score is kept');
  assert.equal(merged[0][6], 'verificar', 'Evaluated outranks Rejected');
});

ok('dedup-tracker ranks every state id states.yml defines', () => {
  const src = readFileSync(join(ROOT, 'dedup-tracker.mjs'), 'utf-8');
  const table = src.match(/const STATUS_RANK = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'STATUS_RANK table found');
  const ranked = new Set([...table[1].matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]));
  // A state added to states.yml with no rank would fall to 0 and lose every
  // dedup contest, the same failure an unlisted alias used to cause.
  assert.deepEqual(states.map(s => s.id).filter(id => !ranked.has(id)), []);
  assert.deepEqual([...ranked].filter(id => !states.some(s => s.id === id)), [], 'no rank for a state that does not exist');
});

const { classifyOutcome } = await load('analyze-patterns.mjs');
ok('analyze-patterns buckets every states.yml spelling like its canonical label', () => {
  for (const s of states) {
    for (const text of spellings(s)) {
      assert.equal(classifyOutcome(text), classifyOutcome(s.label), `"${text}" vs "${s.label}"`);
    }
  }
  assert.equal(classifyOutcome('Mülakat'), 'positive');
  assert.equal(classifyOutcome('işe alındı'), 'positive');
  assert.equal(classifyOutcome('reddedildi'), 'negative');
  assert.equal(classifyOutcome('başvuruldu 2026-06-01'), 'awaiting');
});

const sync = await load('tracker-sync-check.mjs');
ok('tracker-sync-check normalizes every states.yml spelling to its id', () => {
  for (const s of states) {
    for (const text of spellings(s)) {
      assert.equal(sync.normalizeStatus(text), s.id, `"${text}"`);
    }
  }
  // The hired aliases were missing from this script's copy even though
  // analyze-patterns had them.
  assert.equal(sync.normalizeStatus('contratado'), 'hired');
  assert.equal(sync.compareLifecycle(sync.normalizeStatus('Mülakat'), sync.normalizeStatus('Evaluated')).cmp, 1);
  assert.equal(sync.normalizeStatus('Some Unknown'), 'some unknown', 'an unknown status keeps its own text');
});
