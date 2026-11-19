// Mastra agent turn (MP-3c, docs/plans/mastra-mp3-decisions.md DR-MP3-17, -23, -27..-31):
// with gate L opened by the journey's own seam, Main's two IPC commands are driven
// directly (harness.invokeOk, no renderer branch: that is MP-4).
//
// What it proves in a real Electron main, against the real addon:
//   - refusals are typed and write nothing (invalid, forbidden key, unsupported);
//   - an unknown cancel is a no-op (found: false);
//   - an admitted start loads the third bundle (lazy, only now), runs the real
//     Agent, and writes the audit rows of a dispatch in order
//     (started, prepared, dispatched) and closes the execution with ONE failed
//     terminal, through the real `ai_audit_append_batch`, in the workspace chain.
// What it does not do: send. No API key is configured, so Main's send closure
// stops at the key's resolution, before Native's `send_agent_message`; no
// provider, no network, no key is involved (the fake AI of the journey harness
// is also on, as in every journey). The in-flight cases (cancel, workspace
// switch, restricted, quit) are in `electron/main/mastraTurnOwner.test.ts`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const MASTRA_AGENT_TURN_JOURNEY_ID = "mastra-agent-turn-gate-load-audit";
const ID = MASTRA_AGENT_TURN_JOURNEY_ID;

// Gate L's own seam (electron/main/mastraAgentTurnGate.ts): CI=true, the owner
// token and a per-launch UUIDv4 nonce, with the journey's own userData (the
// harness sets that for every launch).
export const MASTRA_GATE_OWNER_TOKEN_ENV =
  "GRIMODEX_MASTRA_AGENT_TURN_CI_OWNER_TOKEN";
export const MASTRA_GATE_NONCE_ENV = "GRIMODEX_MASTRA_AGENT_TURN_CI_NONCE";
export const MASTRA_GATE_OWNER_TOKEN = "mp3b-turn-gate-owner-v1";

export const START_COMMAND = "mastra_agent_turn_start";
export const CANCEL_COMMAND = "mastra_agent_turn_cancel";

const DISPATCH_ROWS = [
  "execution.started",
  "request.prepared",
  "request.dispatched",
];

/** A valid start request of the wire (`electron/shared/mastraAgentTurnWire.ts`). */
export function startRequest(overrides = {}) {
  return {
    turnId: randomUUID(),
    chatSessionId: `journey-session-${randomUUID()}`,
    messages: [
      { role: "system", content: "MASTRA-AGENT-TURN-JOURNEY system" },
      { role: "user", content: "MASTRA-AGENT-TURN-JOURNEY prompt" },
    ],
    route: {
      provider: "anthropic",
      model: "claude-journey",
      endpointId: null,
      apiVariant: null,
      expectedOllamaEndpoint: null,
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      webSearch: null,
    },
    systemCacheSegments: null,
    systemVolatileTail: null,
    tools: [],
    ...overrides,
  };
}

/**
 * Sets the gate seam's variables for the duration of `launch` only (the harness
 * copies the process environment when it launches), then restores them. CI must
 * already be "true": the seam is inert otherwise, and the journey says so
 * instead of failing later as a closed gate.
 */
export async function withMastraGateEnvironment(launch, env = process.env) {
  if (env.CI !== "true") {
    throw new Error(
      `${ID} needs CI=true (gate L's seam is inert otherwise); run it with CI=true`,
    );
  }
  const names = [MASTRA_GATE_OWNER_TOKEN_ENV, MASTRA_GATE_NONCE_ENV];
  const saved = names.map((name) => [name, env[name]]);
  env[MASTRA_GATE_OWNER_TOKEN_ENV] = MASTRA_GATE_OWNER_TOKEN;
  env[MASTRA_GATE_NONCE_ENV] = randomUUID();
  try {
    return await launch();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

/** A typed refusal (an `ok:true` value), never an error and never a row. */
export function assertRefusal(value, command, reason) {
  assert.deepEqual(value, { status: "refused", command, reason });
}

/**
 * Every execution of the rows is a dispatch's three rows in order and exactly
 * one failed terminal after them: nothing start-only, nothing completed (no
 * send happened), and no ambiguous mark (the outcome is known: not sent).
 * Returns the execution IDs in order.
 */
export function assertClosedFailedExecutions(rows, expectedCount) {
  const byExecution = new Map();
  for (const row of rows) {
    const list = byExecution.get(row.execution_id) ?? [];
    list.push(row);
    byExecution.set(row.execution_id, list);
  }
  assert.equal(byExecution.size, expectedCount, "executions written");
  for (const [executionId, list] of byExecution) {
    assert.deepEqual(
      list.map((row) => row.event_type),
      [...DISPATCH_ROWS, "execution.failed"],
      `execution ${executionId}: dispatch rows then one failed terminal`,
    );
    assert.ok(list.every((row) => row.path_id === "chat_agent_main"));
    const dispatched = JSON.parse(String(list[2].payload));
    assert.equal(
      dispatched.dispatchBoundary,
      "before_electron_main_native_send",
    );
    assert.equal(dispatched.transportTarget, "electron-main-native");
    const failed = JSON.parse(String(list[3].payload));
    assert.equal(failed.remoteOutcome, undefined);
    assert.equal(failed.responseObserved, undefined);
  }
  return [...byExecution.keys()];
}

async function queryAuditRows(harness, page) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: `SELECT sequence, execution_id, event_type, path_id, payload
            FROM ai_audit_events
           WHERE scope_id = 'workspace' AND path_id = 'chat_agent_main'
           ORDER BY sequence`,
    params: [],
    method: "all",
  });
  return result?.rows ?? [];
}

export function createMastraAgentTurnJourney({ configureWorkspace }) {
  return {
    id: ID,
    run: async (harness) => {
      const workspace = harness.workspacePath(ID);
      await configureWorkspace(harness, workspace, { deterministicAi: true });
      const gate = await withMastraGateEnvironment(() =>
        harness.launch(`${ID}/gate-open`),
      );
      try {
        const invoke = (command, args) =>
          harness.invokeOk(gate.page, command, args);
        // Bind the main-trusted workspace (the identity carries it after Native's event).
        await invoke("open_workspace", { path: workspace });
        assert.deepEqual(await queryAuditRows(harness, gate.page), []);

        // Refusals: typed, and nothing is written.
        assertRefusal(
          await invoke(START_COMMAND, startRequest({ tools: [{ name: "x" }] })),
          "start",
          "invalid",
        );
        assertRefusal(
          await invoke(START_COMMAND, {
            ...startRequest(),
            executionId: randomUUID(),
          }),
          "start",
          "invalid",
        );
        assertRefusal(
          await invoke(
            START_COMMAND,
            startRequest({
              route: { ...startRequest().route, provider: "ollama" },
            }),
          ),
          "start",
          "invalid",
        );
        assertRefusal(
          await invoke(
            START_COMMAND,
            startRequest({
              messages: [{ role: "user", content: "no system" }],
            }),
          ),
          "start",
          "unsupported",
        );
        assertRefusal(await invoke(CANCEL_COMMAND, {}), "cancel", "invalid");
        const unknownTurn = randomUUID();
        assert.deepEqual(
          await invoke(CANCEL_COMMAND, { turnId: unknownTurn }),
          {
            status: "ok",
            turnId: unknownTurn,
            found: false,
          },
        );
        assert.deepEqual(await queryAuditRows(harness, gate.page), []);
        harness.recordTimeline(`${ID}/refusals-write-nothing`, {
          refusals: 6,
          auditRows: 0,
        });

        // An admitted start: the runtime is loaded now (lazy), the real Agent
        // runs, the dispatch rows are written, and Main's send stops before
        // Native because no API key is configured (no network, no provider).
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await assert.rejects(
            invoke(START_COMMAND, startRequest()),
            /No API key configured for anthropic/,
          );
        }
        const rows = await queryAuditRows(harness, gate.page);
        const executions = assertClosedFailedExecutions(rows, 2);
        harness.recordTimeline(`${ID}/dispatch-rows-closed`, {
          executions: executions.length,
          rows: rows.length,
          sent: false,
        });
      } finally {
        await harness.close(gate.app, gate.page, `${ID}/gate-open`);
      }
    },
  };
}
