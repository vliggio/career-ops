// The web's two core-lock adapters (tracker-lock.ts, followups-lock.ts) load
// their lock from an engine module at runtime. Under the #524 split layout the
// data root is a data-only directory, so that module has to come from the code
// root, the same checkout rootScript() spawns scripts from (#4015).
//
// Loaded from the data root, the two adapters fail in different ways:
//   - tracker-lock: the import throws ERR_MODULE_NOT_FOUND, so every caller
//     fails instead of taking the lock.
//   - followups-lock: `existsSync` is false, so it takes the "no core, no
//     seeder" branch and runs the write with NO cross-process lock. But the
//     seeder still runs: the web's own POST /api/followups/seed spawns
//     followup-seed.mjs from the code root, and it locks the same follow-ups
//     file. Nothing errors, so a lost update is the only visible symptom.
//
// Each case holds the real core lock on the data-root file, then calls the web
// adapter with a short timeout. Taking the lock means the adapter reports
// "busy". Before the fix, the tracker case threw ERR_MODULE_NOT_FOUND, and the
// follow-ups case ran `fn` while the lock was held.
//
// Run:  node --experimental-strip-types --test tests/lib/core-lock-code-root.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Same import guard as followups-lock.test.mjs: a web-only install has the core
// files but not their dependencies, which is a skip, not a failure.
async function importCore(name) {
  const file = path.join(CHECKOUT, name);
  try {
    return { mod: await import(pathToFileURL(file).href), skip: false };
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    if (!fs.existsSync(file)) return { mod: null, skip: `no core checkout at ${CHECKOUT}` };
    if (err.url == null && !fs.existsSync(path.join(CHECKOUT, "node_modules"))) {
      return { mod: null, skip: `core dependencies are not installed at ${CHECKOUT} (web-only checkout)` };
    }
    throw err;
  }
}

const trackerCore = await importCore("tracker-utils.mjs");
const seedCore = await importCore("followup-seed.mjs");

const ENV_KEYS = [
  "CAREER_OPS_ROOT",
  "CAREER_OPS_DATA_DIR",
  "CAREER_OPS_CODE_ROOT",
  "CAREER_OPS_TRACKER_LOCK",
  "CAREER_OPS_FOLLOWUPS_LOCK",
  "CAREER_OPS_WEB_LOCK_TIMEOUT_MS",
  "CAREER_OPS_WEB_FOLLOWUPS_LOCK_TIMEOUT_MS",
];

/** A data-only root (no engine files) selected by CAREER_OPS_ROOT, with the
 *  code root set explicitly so the result does not depend on the test's cwd. */
function splitLayout(t) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lock-code-root-")));
  fs.mkdirSync(path.join(dataRoot, "data"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CAREER_OPS_ROOT = dataRoot;
  process.env.CAREER_OPS_CODE_ROOT = CHECKOUT;
  process.env.CAREER_OPS_WEB_LOCK_TIMEOUT_MS = "300";
  process.env.CAREER_OPS_WEB_FOLLOWUPS_LOCK_TIMEOUT_MS = "300";
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  assert.equal(fs.existsSync(path.join(dataRoot, "tracker-utils.mjs")), false, "fixture must be data-only");
  return dataRoot;
}

test("split layout: withTrackerLock loads the core lock from the code root", { skip: trackerCore.skip }, async (t) => {
  const dataRoot = splitLayout(t);
  const { careerOpsRoot } = await import("../../src/lib/career-ops.ts");
  assert.equal(careerOpsRoot(), dataRoot, "precondition: careerOpsRoot() is the data-only root");

  const { withTrackerLock, TrackerBusyError } = await import("../../src/lib/core/tracker-lock.ts");
  const trackerFile = path.join(dataRoot, "data", "applications.md");
  fs.writeFileSync(trackerFile, "# Applications Tracker\n");

  const { acquireTrackerLock, trackerLockDirFor } = trackerCore.mod;
  const held = await acquireTrackerLock(trackerLockDirFor(trackerFile), { timeoutMs: 2_000 });
  try {
    let ran = false;
    await assert.rejects(
      () => withTrackerLock(trackerFile, () => { ran = true; }),
      (err) => {
        assert.ok(err instanceof TrackerBusyError, `expected TrackerBusyError, got ${err?.code ?? ""} ${err?.message}`);
        return true;
      },
    );
    assert.equal(ran, false, "fn must not run while another process holds the tracker lock");
  } finally {
    await held.release();
  }

  // Released: the same call now takes the lock and runs.
  assert.equal(await withTrackerLock(trackerFile, () => "ran"), "ran");
});

test("split layout: withFollowupsLock still excludes the seeder", { skip: seedCore.skip }, async (t) => {
  const dataRoot = splitLayout(t);
  const { withFollowupsLock, FollowupsBusyError } = await import("../../src/lib/core/followups-lock.ts");
  const followupsFile = path.join(dataRoot, "data", "follow-ups.md");
  fs.writeFileSync(followupsFile, "# Follow-ups\n\n");

  // The seeder's side of the race: the core's own withFollowupsLock, held open.
  let releaseSeeder;
  const seederDone = new Promise((r) => { releaseSeeder = r; });
  let seederHolds;
  const seederHolding = new Promise((r) => { seederHolds = r; });
  const seeder = seedCore.mod.withFollowupsLock(followupsFile, async () => {
    seederHolds();
    await seederDone;
  });
  await seederHolding;

  try {
    let ran = false;
    await assert.rejects(
      () => withFollowupsLock(followupsFile, () => { ran = true; }),
      (err) => {
        assert.ok(err instanceof FollowupsBusyError, `expected FollowupsBusyError, got ${err?.name}: ${err?.message}`);
        return true;
      },
    );
    assert.equal(ran, false, "the web write ran while the seeder held the follow-ups lock: no cross-process exclusion");
  } finally {
    releaseSeeder();
    await seeder;
  }

  assert.equal(await withFollowupsLock(followupsFile, () => "ran"), "ran");
});
