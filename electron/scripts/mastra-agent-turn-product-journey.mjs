// Mastra agent turn (MP-3c, docs/plans/mastra-mp3-decisions.md DR-MP3-13, -17, -27, -32):
// with gate L opened by the journey's own seam, Main's two IPC commands are driven
// directly (harness.invokeOk, no renderer branch: that is MP-4).
//
// What it proves in a real Electron main, against the real addon:
//   - refusals are typed and write nothing (invalid, forbidden key, unsupported);
//   - an unknown cancel is a no-op (found: false);
//   - an admitted start lazy-loads the third bundle (the owner loads the runtime
//     first, then resolves settings and the key: an error that names the key can
//     only come after a successful load), and with no API key it is `ok:false`
//     with that reason, before the Agent runs: no audit row, nothing start-only,
//     nothing sent. The journey harness fails the run on any error-looking line
//     of Main's stderr, so a quiet run also proves nothing was logged as a fault.
// What it does not do: the dispatch rows and the terminal. They are held by the
// real-addon pipeline spec (`mastraAgentAudit.pipeline.spec.ts`) and the owner's
// unit tests; a dispatch with a real provider is MP-13's acceptance. A key cannot
// be given here (headless safeStorage is basic_text, which the key store refuses).
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

/** A valid start request of the wire (`electron/shared/mastraAgentTurnWire.ts`). */
export function startRequest(overrides = {}) {
  return {
    turnId: randomUUID(),
    chatSessionId: `journey-session-${randomUUID()}`,
    projectId: `journey-project-${randomUUID()}`,
    currentSceneId: null,
    chatMessageId: `journey-message-${randomUUID()}`,
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

async function queryAuditRows(harness, page) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: `SELECT sequence, execution_id, event_type, path_id, payload
            FROM ai_audit_events
           WHERE path_id = 'chat_agent_main'
           ORDER BY sequence`,
    params: [],
    method: "all",
  });
  return result?.rows ?? [];
}

/**
 * The first read after `open_workspace`: the open settles asynchronously, so
 * wait (as the Chronicle journey does) while the DB answers "switching" or
 * "no workspace", and fail on anything else.
 */
async function waitForAuditRows(harness, page) {
  const outcome = await harness.waitUntil(
    async () => {
      try {
        return { ready: true, rows: await queryAuditRows(harness, page) };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "db_execute rejected: No workspace is open" ||
            /^db_execute rejected: WORKSPACE_SWITCHING(?::|$)/u.test(
              error.message,
            ))
        ) {
          return false;
        }
        return { ready: false, error };
      }
    },
    "the opened workspace answers the audit read",
    30_000,
  );
  if (!outcome.ready) throw outcome.error;
  return outcome.rows;
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
        assert.deepEqual(await waitForAuditRows(harness, gate.page), []);

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
        // The fallback project ID names no project: Main's owner refuses it
        // (MP-4a), a request that is otherwise valid.
        assertRefusal(
          await invoke(
            START_COMMAND,
            startRequest({ projectId: "default-project" }),
          ),
          "start",
          "unsupported",
        );
        assertRefusal(
          await invoke(START_COMMAND, startRequest({ projectId: "" })),
          "start",
          "invalid",
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
          refusals: 8,
          auditRows: 0,
        });

        // An admitted start: the runtime is loaded now (lazy), then the key is
        // resolved. No key is configured, so the start is `ok:false` with that
        // reason before the Agent runs. Twice: nothing is cached or left behind.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await assert.rejects(
            invoke(START_COMMAND, startRequest()),
            /No API key configured for anthropic/,
          );
        }
        assert.deepEqual(await queryAuditRows(harness, gate.page), []);
        harness.recordTimeline(`${ID}/no-key-no-rows`, {
          loadedThenRejectedForKey: 2,
          auditRows: 0,
          sent: false,
        });
      } finally {
        await harness.close(gate.app, gate.page, `${ID}/gate-open`);
      }
    },
  };
}
