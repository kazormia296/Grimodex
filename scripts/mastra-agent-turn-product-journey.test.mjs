import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { selectProductJourneys } from "../electron/scripts/product-journey-impact.mjs";
import { PRODUCT_JOURNEYS } from "../electron/scripts/product-journeys.mjs";
import { FIXED_PRODUCT_JOURNEY_SHARDS } from "../electron/scripts/product-journey-shards.mjs";
import {
  CANCEL_COMMAND,
  MASTRA_AGENT_TURN_JOURNEY_ID as ID,
  MASTRA_GATE_NONCE_ENV,
  MASTRA_GATE_OWNER_TOKEN,
  MASTRA_GATE_OWNER_TOKEN_ENV,
  START_COMMAND,
  assertClosedFailedExecutions,
  assertRefusal,
  createMastraAgentTurnJourney,
  startRequest,
  withMastraGateEnvironment,
} from "../electron/scripts/mastra-agent-turn-product-journey.mjs";

const CONTRACT = "mastra:agent-turn-gate-load-audit";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the journey is a required catalog entry with its own contract, in the fixed shards and the runner's list", () => {
  assert.equal(ID, "mastra-agent-turn-gate-load-audit");
  const entry = PRODUCT_JOURNEY_CATALOG.find((row) => row.id === ID);
  assert.ok(entry);
  assert.deepEqual(entry.contracts, [CONTRACT]);
  assert.deepEqual(entry.capabilities, ["electron", "napi"]);
  assert.notEqual(entry.required, false);
  assert.ok(
    PRODUCT_CONTRACT_REQUIREMENTS.some(
      (requirement) => requirement.id === CONTRACT,
    ),
  );
  assert.equal(
    FIXED_PRODUCT_JOURNEY_SHARDS.flat().filter((id) => id === ID).length,
    1,
  );
  assert.equal(
    PRODUCT_JOURNEYS.filter((journey) => journey.id === ID).length,
    1,
  );
});

test("a change of the owner, the loader, the wire or the journey selects it", () => {
  for (const changed of [
    "electron/main/mastraTurnOwner.ts",
    "electron/main/mastraAgentLoader.ts",
    "electron/main/mastraAgentTurnGate.ts",
    "electron/main/mastra/agentRuntime.ts",
    "electron/shared/mastraAgentTurnWire.ts",
  ]) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changed],
    });
    assert.ok(
      selection.journeyIds.includes(ID),
      `${changed} must select ${ID}`,
    );
    assert.equal(selection.fallback, false);
  }
  for (const changedPath of [
    "electron/scripts/mastra-agent-turn-product-journey.mjs",
    "scripts/mastra-agent-turn-product-journey.test.mjs",
  ]) {
    const selected = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.equal(
      selected.fallback,
      false,
      `${changedPath} is a known infrastructure path`,
    );
  }
});

test("the seam names and the wire are the product's: the gate file and the wire file are read, not copied", () => {
  const gate = read("electron/main/mastraAgentTurnGate.ts");
  assert.ok(gate.includes(`"${MASTRA_GATE_OWNER_TOKEN_ENV}"`));
  assert.ok(gate.includes(`"${MASTRA_GATE_NONCE_ENV}"`));
  assert.ok(gate.includes(`"${MASTRA_GATE_OWNER_TOKEN}"`));
  const wire = read("electron/shared/mastraAgentTurnWire.ts");
  assert.ok(wire.includes(`"${START_COMMAND}"`));
  assert.ok(wire.includes(`"${CANCEL_COMMAND}"`));
  // The request has exactly the wire's seven keys.
  const keys = /const START_KEYS = \[([^\]]*)\]/
    .exec(wire)?.[1]
    ?.split(",")
    .map((key) => key.trim().replace(/"/g, ""))
    .filter(Boolean);
  assert.deepEqual(Object.keys(startRequest()).sort(), [...keys].sort());
});

test("the gate's seam variables are set only while the launch runs, and need CI=true", async () => {
  const env = { CI: "true", [MASTRA_GATE_OWNER_TOKEN_ENV]: "previous" };
  let seen;
  const result = await withMastraGateEnvironment(async () => {
    seen = { ...env };
    return "launched";
  }, env);
  assert.equal(result, "launched");
  assert.equal(seen[MASTRA_GATE_OWNER_TOKEN_ENV], MASTRA_GATE_OWNER_TOKEN);
  assert.match(
    seen[MASTRA_GATE_NONCE_ENV],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // Restored: the previous value stays, the nonce is gone.
  assert.equal(env[MASTRA_GATE_OWNER_TOKEN_ENV], "previous");
  assert.equal(MASTRA_GATE_NONCE_ENV in env, false);
  // Restored on a failed launch too.
  await assert.rejects(
    withMastraGateEnvironment(async () => {
      throw new Error("launch failed");
    }, env),
    /launch failed/,
  );
  assert.equal(MASTRA_GATE_NONCE_ENV in env, false);
  // No CI: refused up front, with nothing set.
  const noCi = {};
  await assert.rejects(
    withMastraGateEnvironment(async () => "x", noCi),
    /needs CI=true/,
  );
  assert.deepEqual(noCi, {});
});

test("assertRefusal accepts exactly the typed refusal", () => {
  assertRefusal(
    { status: "refused", command: "start", reason: "invalid" },
    "start",
    "invalid",
  );
  for (const wrong of [
    { status: "refused", command: "start", reason: "busy" },
    { status: "refused", command: "cancel", reason: "invalid" },
    { status: "refused", command: "start", reason: "invalid", extra: 1 },
    { status: "completed" },
  ]) {
    assert.throws(() => assertRefusal(wrong, "start", "invalid"));
  }
});

const rowsOf = (executionId, types, overrides = {}) =>
  types.map((event_type, index) => ({
    sequence: index,
    execution_id: executionId,
    event_type,
    path_id: "chat_agent_main",
    payload: JSON.stringify(
      event_type === "request.dispatched"
        ? {
            dispatchBoundary: "before_electron_main_native_send",
            transportTarget: "electron-main-native",
          }
        : {},
    ),
    ...overrides,
  }));
const CLOSED = [
  "execution.started",
  "request.prepared",
  "request.dispatched",
  "execution.failed",
];

test("closed executions: each is the dispatch rows then one failed terminal (a negative control for each way to be wrong)", () => {
  assert.deepEqual(
    assertClosedFailedExecutions(
      [...rowsOf("a", CLOSED), ...rowsOf("b", CLOSED)],
      2,
    ),
    ["a", "b"],
  );
  // start-only, completed (a send happened), a second terminal, missing dispatch, wrong count.
  for (const bad of [
    rowsOf("a", CLOSED.slice(0, 3)),
    rowsOf("a", [
      ...CLOSED.slice(0, 3),
      "response.completed",
      "execution.succeeded",
    ]),
    rowsOf("a", [...CLOSED, "execution.failed"]),
    rowsOf("a", [CLOSED[0], CLOSED[3]]),
  ]) {
    assert.throws(() => assertClosedFailedExecutions(bad, 1));
  }
  assert.throws(() => assertClosedFailedExecutions(rowsOf("a", CLOSED), 2));
  // An ambiguous mark is not what a known not-sent failure carries.
  const marked = rowsOf("a", CLOSED);
  marked[3].payload = JSON.stringify({ remoteOutcome: "unknown" });
  assert.throws(() => assertClosedFailedExecutions(marked, 1));
  // A row written by another path, or at the wrong boundary.
  assert.throws(() =>
    assertClosedFailedExecutions(rowsOf("a", CLOSED, { path_id: "other" }), 1),
  );
  const wrongBoundary = rowsOf("a", CLOSED);
  wrongBoundary[2].payload = JSON.stringify({
    dispatchBoundary: "before_renderer_send",
    transportTarget: "electron-main-native",
  });
  assert.throws(() => assertClosedFailedExecutions(wrongBoundary, 1));
});

test("the journey drives Main's IPC directly (no renderer branch) and sends nothing", () => {
  const source = read("electron/scripts/mastra-agent-turn-product-journey.mjs");
  assert.match(source, /harness\.invokeOk\(page, "db_execute"/);
  assert.match(source, /No API key configured for anthropic/);
  const journey = createMastraAgentTurnJourney({
    configureWorkspace: async () => {},
  });
  assert.equal(journey.id, ID);
  assert.equal(typeof journey.run, "function");
});
