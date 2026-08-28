import assert from "node:assert/strict";
import test from "node:test";

import {
  createNarrativeMaintenanceProductJourneys,
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  NARRATIVE_MAINTENANCE_FAULT_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_SEAM_CONTRACT,
  NARRATIVE_MAINTENANCE_SETUP_ENV,
  NARRATIVE_MAINTENANCE_TRIGGER_ENV,
  NARRATIVE_MAINTENANCE_JOURNEY_IDS,
  withLaunchEnvironmentForTest,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";

const RUN_KINDS = Object.freeze(["backfill", "dependency-verify"]);

function completedRun(id, runKind) {
  return {
    id,
    projectId: "phase1-project",
    runKind,
    workKey: `${runKind}:phase1-project`,
    status: "completed",
    semanticEpochId: "phase1-epoch",
    consumerId: null,
    createdAt: `2026-08-23T00:00:0${id.slice(-1)}.000Z`,
    startedAt: `2026-08-23T00:00:0${id.slice(-1)}.000Z`,
    completedAt: `2026-08-23T00:00:0${id.slice(-1)}.123Z`,
    terminalReasonCode: null,
    outcomeSummaryJson: JSON.stringify({ status: "completed" }),
    specDigest: "phase1-spec",
    catalogDigest: "phase1-catalog",
    registryDigest: "phase1-registry",
    attemptCount: 1,
    maxAttemptNumber: 1,
  };
}

function createObservationHarness({ ledgerRows = [] } = {}) {
  const calls = [];
  const timeline = [];
  const harness = {
    calls,
    timeline,
    workspacePath(name) {
      return `/tmp/c2-5b-product-journey/${name}`;
    },
    async launch(phase) {
      calls.push({
        command: "launch",
        phase,
        seamEnv: {
          ownerToken: process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
          setup: process.env[NARRATIVE_MAINTENANCE_SETUP_ENV],
          fault: process.env[NARRATIVE_MAINTENANCE_FAULT_ENV],
          trigger: process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV],
          freshness: process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
        },
      });
      return { app: { phase }, page: { phase } };
    },
    async close(app, page, phase) {
      calls.push({ command: "close", app, page, phase });
    },
    async invokeOk(page, command, args = {}) {
      calls.push({ command, page, args });
      if (command !== "db_execute") return null;
      if (args.sql.includes("PRAGMA user_version")) {
        return { rows: [{ user_version: 32 }] };
      }
      if (args.sql.includes("FROM projects")) {
        return { rows: [{ id: "phase1-project" }] };
      }
      if (args.sql.includes("schema_data_migrations")) {
        return {
          rows: [
            { migration_id: "narrative-c2-finding-identity-v31" },
            { migration_id: "narrative-c2-application-rekey-v32" },
          ],
        };
      }
      if (args.sql.includes("FROM narrative_extraction_runs")) {
        return { rows: ledgerRows.map((row) => ({ ...row })) };
      }
      return { rows: [] };
    },
    async waitUntil(fn, label) {
      calls.push({ command: "waitUntil", label });
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const value = await fn();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(
        `${label}: fake observation ledger never reached the required state${
          lastError ? ` (${lastError.message ?? lastError})` : ""
        }`,
      );
    },
    recordTimeline(event, details) {
      timeline.push({ event, details });
    },
  };
  return harness;
}

function createJourneys() {
  return createNarrativeMaintenanceProductJourneys({
    configureWorkspace: async (harness, workspace) => {
      harness.calls.push({
        command: "configureWorkspace",
        workspace,
        seamEnv: {
          ownerToken: process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
          setup: process.env[NARRATIVE_MAINTENANCE_SETUP_ENV],
          freshness: process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
        },
      });
    },
    prepareSchemaMarker: async () => 30,
    readRunSnapshotFn: async () => [],
  });
}

test("C2-5B catalog exposes the eleven stable acceptance journey IDs", () => {
  const journeys = createJourneys();
  assert.deepEqual(
    journeys.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_JOURNEY_IDS,
  );
  assert.ok(journeys.every((journey) => typeof journey.run === "function"));
});

test("schema marker journey executes live observations and requires automatic Backfill then Verify", async () => {
  const ledgerRows = RUN_KINDS.map((runKind, index) =>
    completedRun(`phase1-run-${index + 1}`, runKind),
  );
  const harness = createObservationHarness({ ledgerRows });
  const [journey] = createJourneys();

  await assert.doesNotReject(() => journey.run(harness));
  assert.ok(
    harness.calls.some(
      (call) =>
        call.command === "db_execute" &&
        call.args.sql.includes("narrative_extraction_runs"),
    ),
    "the journey must inspect the durable Run ledger",
  );
  assert.deepEqual(
    harness.timeline.map((entry) => entry.event),
    ["schema-marker-observed", "schema-marker-backfill-verify-complete"],
  );
});

test("schema marker journey rejects an empty durable Run ledger", async () => {
  const harness = createObservationHarness({ ledgerRows: [] });
  const [journey] = createJourneys();

  await assert.rejects(
    () => journey.run(harness),
    /schema-marker\/open durable Run sequence.*never reached|required state/i,
  );
});

test("maintenance journeys never use a renderer maintenance command to make the evidence pass", async () => {
  const harness = createObservationHarness();
  const [journey] = createJourneys();

  await assert.rejects(() => journey.run(harness));
  assert.equal(
    harness.calls.some((call) =>
      [
        "verify_narrative_dependency_graph",
        "rebuild_narrative_derived_state",
        "retry_narrative_legacy_backfill",
        "repair_narrative_dependency_declarations",
      ].includes(call.command),
    ),
    false,
  );
});

test("maintenance fault and setup seams require the exact owner contract", async () => {
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.ownerToken,
    NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.ownerTokenEnv,
    NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.setupDisabledValue,
    "disabled",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.freshnessDisableEnv,
    NARRATIVE_FRESHNESS_DISABLE_ENV,
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.freshnessDisabledValue,
    "disabled",
  );

  const ledgerRows = RUN_KINDS.map((runKind, index) =>
    completedRun(`phase1-seam-run-${index + 1}`, runKind),
  );
  const harness = createObservationHarness({ ledgerRows });
  const [journey] = createJourneys();
  await journey.run(harness);

  const configure = harness.calls.find(
    (call) => call.command === "configureWorkspace",
  );
  const launch = harness.calls.find((call) => call.command === "launch");
  assert.deepEqual(configure?.seamEnv, {
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    setup: "disabled",
    freshness: undefined,
  });
  assert.deepEqual(launch?.seamEnv, {
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    setup: undefined,
    fault: undefined,
    trigger: undefined,
    freshness: undefined,
  });
});

test("withLaunchEnvironment restores pre-existing freshness after success", async () => {
  const previousFreshness = process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
  process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = "pre-existing";
  try {
    const result = await withLaunchEnvironmentForTest(
      { freshness: "disabled" },
      () => {
        assert.equal(
          process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
          "disabled",
        );
        return "callback-result";
      },
    );
    assert.equal(result, "callback-result");
    assert.equal(
      process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
      "pre-existing",
    );
  } finally {
    if (previousFreshness === undefined) {
      delete process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
    } else {
      process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = previousFreshness;
    }
  }
});

test("withLaunchEnvironment restores pre-existing freshness after callback throws", async () => {
  const previousFreshness = process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
  process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = "pre-existing";
  try {
    await assert.rejects(
      () =>
        withLaunchEnvironmentForTest(
          { freshness: "disabled" },
          () => {
            assert.equal(
              process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
              "disabled",
            );
            throw new Error("callback failure");
          },
        ),
      /callback failure/,
    );
    assert.equal(
      process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
      "pre-existing",
    );
  } finally {
    if (previousFreshness === undefined) {
      delete process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
    } else {
      process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = previousFreshness;
    }
  }
});
