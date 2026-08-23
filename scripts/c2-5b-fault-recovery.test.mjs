import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
  NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
  NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";

const stateSourcePromise = readFile(
  new URL(
    "../electron/native/grimodex-node/src/state.rs",
    import.meta.url,
  ),
  "utf8",
);
const nativeSourcePromise = readFile(
  new URL("../electron/native/grimodex-node/src/lib.rs", import.meta.url),
  "utf8",
);
const journeySourcePromise = readFile(
  new URL(
    "../electron/scripts/narrative-maintenance-product-journeys.mjs",
    import.meta.url,
  ),
  "utf8",
);

test("production fault seam consumes an exact AppState-bound identity", async () => {
  const [stateSource, nativeSource] = await Promise.all([
    stateSourcePromise,
    nativeSourcePromise,
  ]);

  assert.match(
    stateSource,
    /NarrativeMaintenanceFaultIdentity/,
    "AppState must retain the immutable fault identity, including the Run id",
  );
  assert.match(
    stateSource,
    /claim_fault_for_binding/,
    "fault consumption must validate authority, generation, project, epoch, and work",
  );
  assert.match(
    stateSource,
    /commit_fault_for_run/,
    "fault consumption must bind its one-shot claim to the created Run",
  );
  assert.match(
    nativeSource,
    /claim_fault_for_binding/,
    "the production cycle must consume the typed seam through AppState",
  );
  assert.match(
    nativeSource,
    /inject_legacy_backfill_fault/,
    "faults must run through the native Backfill lifecycle owner",
  );
});

test("process interruption is guarded as a native-only typed CI exit", async () => {
  const nativeSource = await nativeSourcePromise;
  assert.match(
    nativeSource,
    /NarrativeMaintenanceCiFault::ProcessInterruption/,
    "only the closed typed fault may select process interruption",
  );
  assert.match(
    nativeSource,
    /std::process::exit\(/,
    "the interruption journey must terminate the main process after durable Run creation",
  );
  assert.match(
    nativeSource,
    /is_packaged|isPackaged/,
    "the native path must retain the unpackaged CI gate",
  );
});

test("fault journey production assertions cover durable triplets and no-recovery boundary", async () => {
  const journeySource = await journeySourcePromise;
  assert.match(
    journeySource,
    /assertForegroundLifecycle\(\s*failed/,
    "terminal fault evidence must validate Run, Task, and Attempt together",
  );
  assert.match(
    journeySource,
    /assertForegroundLifecycle\(\s*interruptedRun/,
    "interruption must assert the exact running triplet before exit",
  );
  assert.match(
    journeySource,
    /postExitRuns/,
    "interruption must inspect the database directly before reopen",
  );
  assert.match(
    journeySource,
    /recoveryAtExit\.length\s*>\s*0/,
    "interruption must reject recovery before the process is reopened",
  );
  assert.ok(NARRATIVE_MAINTENANCE_TRANSIENT_CODE);
  assert.ok(NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE);
  assert.ok(NARRATIVE_MAINTENANCE_INTERRUPTED_CODE);
});
