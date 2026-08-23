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
const runtimeSourcePromise = readFile(
  new URL(
    "../src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
    import.meta.url,
  ),
  "utf8",
);
const schedulerSourcePromise = readFile(
  new URL("../electron/main/narrativeMaintenance.ts", import.meta.url),
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

test("process interruption returns a strict ACK for the main-only delayed exit owner", async () => {
  const nativeSource = await nativeSourcePromise;
  assert.match(
    nativeSource,
    /NarrativeMaintenanceCiFault::ProcessInterruption/,
    "only the closed typed fault may select process interruption",
  );
  assert.doesNotMatch(
    nativeSource,
    /std::process::exit\(/,
    "the N-API worker must not race the product poll by terminating the process",
  );
  assert.match(
    nativeSource,
    /ci-process-interruption-pending/,
    "the N-API worker must return a strict internal interruption ACK",
  );
  assert.match(
    nativeSource,
    /is_packaged|isPackaged/,
    "the native path must retain the unpackaged CI gate",
  );
  const schedulerSource = await schedulerSourcePromise;
  assert.match(
    schedulerSource,
    /onCiProcessInterruption/,
    "main scheduler must own the typed interruption callback",
  );
  assert.match(
    schedulerSource,
    /scheduleNarrativeMaintenanceProcessInterruption[\s\S]*process\.exit\(/,
    "only the validated main callback may schedule the delayed process exit",
  );
});

test("fault preflight runs before claim/injection and terminal faults ACK without retry", async () => {
  const [nativeSource, runtimeSource, schedulerSource] = await Promise.all([
    nativeSourcePromise,
    runtimeSourcePromise,
    schedulerSourcePromise,
  ]);
  const preflightAt = nativeSource.indexOf(
    "preflight_maintenance_cycle_request(&request)",
  );
  const claimAt = nativeSource.indexOf("claim_fault_for_binding");
  assert.ok(preflightAt >= 0 && claimAt > preflightAt);
  assert.match(
    runtimeSource,
    /pub fn preflight_maintenance_cycle_request[\s\S]*validate_dispatch_contract\(item\)/,
    "shared preflight must enforce the complete dispatch contract, not an N-API allowlist",
  );
  assert.match(
    nativeSource,
    /ci-terminal-fault-handled/,
    "terminal contract failure must be a durable handled ACK",
  );
  assert.match(
    schedulerSource,
    /ci-terminal-fault-handled/,
    "main must clear a terminal fault without entering the generic retry path",
  );
});

test("fault injection is gated by the current native planner identity", async () => {
  const nativeSource = await nativeSourcePromise;
  const plannerAt = nativeSource.indexOf(
    "discover_durable_maintenance_work_with_config",
  );
  const claimAt = nativeSource.indexOf("claim_fault_for_binding");
  assert.ok(
    plannerAt >= 0 && claimAt > plannerAt,
    "stale/epoch-bound Backfill requests must be planner-rejected before any claim or DB write",
  );
  assert.match(
    nativeSource,
    /normalized_work\.len\(\)\s*==\s*1[\s\S]*run_kind\.as_str\(\)\s*==\s*"backfill"/,
    "fault injection must only consume a planner-valid single Backfill item, never a mixed batch",
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
