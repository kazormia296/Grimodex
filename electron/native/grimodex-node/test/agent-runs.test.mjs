import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { Backend } = createRequire(import.meta.url)("../grimodex-node.node");
const startPayload = {
  runId: "run-1",
  projectId: "default-project",
  chatSessionId: "session-1",
  turnId: "turn-1",
  route: "legacy",
  originUserMessageId: "user-message-1",
  modelProviderId: "fixture-provider",
  modelId: "fixture-model",
  endpointHash: "fixture-endpoint-hash",
};
const { runId, projectId, chatSessionId, originUserMessageId } = startPayload;
const interaction = {
  runId,
  interactionId: "interaction-1",
  expectedVersion: 0,
  toolCallId: "tool-call-1",
  argsDigest: "fixture-args-hash",
};
const runState = (version, status) => ({ runId, version, status });

async function openWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-agent-runs-"));
  const backend = new Backend(join(root, "app-data"));
  t.after(async () => {
    const shutdown = JSON.parse(await backend.shutdownWorkspaceLifecycle());
    assert.equal(shutdown.status, "closed");
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      // The Backend can still hold the owner file open on Windows.
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  });
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  await backend.dbExecute(
    "INSERT INTO chat_sessions (id, project_id, title) VALUES (?, ?, ?)",
    [chatSessionId, projectId, "AgentRun fixture"],
    "run",
  );
  await backend.dbExecute(
    "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    [originUserMessageId, chatSessionId, "user", "Draft an outline."],
    "run",
  );
  return backend;
}

test("AgentRun starts, answers a question, and completes finalization", async (t) => {
  const backend = await openWorkspace(t);
  const started = JSON.parse(await backend.agentRunStart(startPayload));
  assert.deepEqual(started, runState(0, "running"));

  const question = JSON.parse(await backend.agentRunOpenQuestion({
    ...interaction,
    expectedVersion: started.version,
    request: "Which scene should the outline cover?",
  }));
  assert.deepEqual(question, { ...runState(1, "waiting_user"), interactionVersion: 0 });

  const answerPayload = {
    runId,
    runVersion: question.version,
    interactionId: interaction.interactionId,
    interactionVersion: question.interactionVersion,
    resolution: "The opening scene.",
  };
  const answered = JSON.parse(await backend.agentRunAnswer(answerPayload));
  assert.deepEqual(answered, runState(2, "running"));
  await assert.rejects(
    backend.agentRunAnswer(answerPayload),
    /AGENT_RUN_VERSION_OR_STATUS_MISMATCH/,
  );

  const assistantMessageId = "assistant-message-1";
  const finalizing = JSON.parse(await backend.agentRunBeginFinalizing({
    runId,
    expectedStatus: answered.status,
    version: answered.version,
    target: "completed",
    assistantMessageId,
  }));
  assert.deepEqual(finalizing, runState(3, "finalizing"));
  assert.deepEqual(JSON.parse(await backend.agentRunListFinalizing({})), [{
    runId,
    targetStatus: "completed",
    targetReason: "completed",
    originUserMessageId,
    originAssistantMessageId: assistantMessageId,
    version: finalizing.version,
  }]);

  await backend.dbExecute(
    "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    [assistantMessageId, chatSessionId, "assistant", "Opening scene outline"],
    "run",
  );
  const completed = JSON.parse(await backend.agentRunFinishFinalizing({
    runId,
    version: finalizing.version,
  }));
  assert.deepEqual(completed, runState(4, "completed"));
  const status = JSON.parse(await backend.agentRunGetStatus({ runId }));
  assert.equal(status.terminalReason, "completed");
  assert.equal(status.version, completed.version);
  assert.equal(status.status, completed.status);
  assert.equal(Object.hasOwn(status, "executionOwner"), false);
});

test("AgentRun opens and decides approval using the returned interactionVersion", async (t) => {
  const backend = await openWorkspace(t);
  await backend.agentRunStart(startPayload);
  const targetBasis = [{ sourceKind: "codex", sourceId: "entry-1", version: "rev-1" }];
  const toolName = "codex_update";
  const approval = JSON.parse(await backend.agentRunOpenApproval({
    ...interaction,
    toolName,
    request: "Update this Codex entry?",
    targetBasis,
  }));
  assert.deepEqual(approval, { ...runState(1, "waiting_approval"), interactionVersion: 0 });
  assert.deepEqual(JSON.parse(await backend.agentRunGetPendingApproval({ runId })), {
    interactionId: interaction.interactionId,
    interactionVersion: approval.interactionVersion,
    toolCallId: interaction.toolCallId,
    toolName,
    argsDigest: interaction.argsDigest,
    targetBasis,
  });
  const decided = JSON.parse(await backend.agentRunDecideApproval({
    runId,
    runVersion: approval.version,
    interactionId: interaction.interactionId,
    interactionVersion: approval.interactionVersion,
    decision: "approved",
  }));
  assert.deepEqual(decided, runState(2, "running"));
  assert.equal(JSON.parse(await backend.agentRunGetPendingApproval({ runId })), null);
});

test("AgentRun interrupts and claims with the Native owner", async (t) => {
  const backend = await openWorkspace(t);
  await backend.agentRunStart(startPayload);
  assert.deepEqual(JSON.parse(await backend.agentRunRecover({ finalizingEvidence: [] })), []);
  const interrupted = JSON.parse(await backend.agentRunInterrupt({
    runId,
    expectedStatus: "running",
    version: 0,
    reason: "renderer_lost",
  }));
  assert.deepEqual(interrupted, runState(1, "interrupted"));

  const claimPayload = {
    runId,
    expectedVersion: interrupted.version,
    requestId: "claim-1",
    gate: { kind: "allowed" },
  };
  const claimed = JSON.parse(await backend.agentRunClaim(claimPayload));
  assert.deepEqual(claimed, runState(2, "running"));
  assert.deepEqual(JSON.parse(await backend.agentRunClaim(claimPayload)), claimed);
});

test("AgentRun rejects unknown fields and caller-supplied owner IDs", async (t) => {
  const backend = await openWorkspace(t);
  await assert.rejects(
    backend.agentRunStart({ ...startPayload, unexpected: true }),
    /unknown field `unexpected`/,
  );
  await assert.rejects(
    backend.agentRunStart({ ...startPayload, owner: "caller-owner" }),
    /unknown field `owner`/,
  );
  await assert.rejects(
    backend.agentRunStartSuperseding({
      oldRunId: runId,
      oldVersion: 0,
      newRun: { ...startPayload, executionOwner: "caller-owner" },
    }),
    /unknown field `executionOwner`/,
  );
  assert.equal(JSON.parse(await backend.agentRunGetStatus({ runId })), null);
});
