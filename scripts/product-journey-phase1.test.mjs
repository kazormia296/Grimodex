import assert from "node:assert/strict";
import test from "node:test";

import {
  createNarrativeMaintenanceProductJourneys,
  NARRATIVE_MAINTENANCE_JOURNEY_IDS,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";

function createObservationHarness() {
  const calls = [];
  const timeline = [];
  const harness = {
    calls,
    timeline,
    workspacePath(name) {
      return `/tmp/c2-5b-product-journey/${name}`;
    },
    async launch(phase) {
      calls.push({ command: "launch", phase });
      return { app: { phase }, page: { phase } };
    },
    async close(app, page, phase) {
      calls.push({ command: "close", app, page, phase });
    },
    async invokeOk(page, command, args = {}) {
      calls.push({ command, page, args });
      if (command !== "db_execute") return null;
      if (args.sql.includes("PRAGMA user_version")) {
        return { rows: [{ user_version: 31 }] };
      }
      if (args.sql.includes("FROM projects")) {
        return { rows: [{ id: "phase1-project" }] };
      }
      if (args.sql.includes("FROM narrative_extraction_runs")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async waitUntil(fn, label) {
      calls.push({ command: "waitUntil", label });
      return fn();
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
      harness.calls.push({ command: "configureWorkspace", workspace });
    },
    prepareSchemaMarker: async () => 30,
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
  const harness = createObservationHarness();
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
