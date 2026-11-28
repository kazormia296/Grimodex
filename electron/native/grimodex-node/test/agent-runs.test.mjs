import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "grimodex-node-agent-runs-"));
}

async function openWorkspace(t, root = tempRoot()) {
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

async function withOwnerProcess(root, method, payload, check) {
  // The owner file stays open for the Backend's lifetime. Process exit releases it deterministically.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { createRequire } from "node:module";
    process.on("disconnect", () => process.exit(0));
    const { Backend } = createRequire(${JSON.stringify(import.meta.url)})("../grimodex-node.node");
    const backend = new Backend(${JSON.stringify(join(root, "owner-app-data"))});
    await backend.openWorkspace(${JSON.stringify(join(root, "workspace"))});
    await backend.agentRunStart(${JSON.stringify(startPayload)});
    const run = await backend[${JSON.stringify(method)}](${JSON.stringify(payload)});
    process.send(JSON.parse(run));
  `,
    ],
    { stdio: ["ignore", "inherit", "inherit", "ipc"], timeout: 60_000 },
  );
  const exited = once(child, "exit");
  try {
    const [ready] = await Promise.race([once(child, "message"), exited]);
    await check(ready);
  } finally {
    if (child.connected) child.disconnect();
    await exited;
  }
  assert.deepEqual(await exited, [0, null]);
}

test("AgentRun starts, answers a question, and completes finalization", async (t) => {
  const backend = await openWorkspace(t);
  const started = JSON.parse(await backend.agentRunStart(startPayload));
  assert.deepEqual(started, runState(0, "running"));

  const question = JSON.parse(
    await backend.agentRunOpenQuestion({
      ...interaction,
      expectedVersion: started.version,
      request: "Which scene should the outline cover?",
    }),
  );
  assert.deepEqual(question, {
    ...runState(1, "waiting_user"),
    interactionVersion: 0,
  });

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
  const finalizing = JSON.parse(
    await backend.agentRunBeginFinalizing({
      runId,
      expectedStatus: answered.status,
      version: answered.version,
      target: "completed",
      assistantMessageId,
    }),
  );
  assert.deepEqual(finalizing, runState(3, "finalizing"));
  assert.deepEqual(JSON.parse(await backend.agentRunListFinalizing({})), [
    {
      runId,
      targetStatus: "completed",
      targetReason: "completed",
      originUserMessageId,
      originAssistantMessageId: assistantMessageId,
      version: finalizing.version,
    },
  ]);

  await backend.dbExecute(
    "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    [assistantMessageId, chatSessionId, "assistant", "Opening scene outline"],
    "run",
  );
  const completed = JSON.parse(
    await backend.agentRunFinishFinalizing({
      runId,
      version: finalizing.version,
    }),
  );
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
  const targetBasis = [
    { sourceKind: "codex", sourceId: "entry-1", version: "rev-1" },
  ];
  const toolName = "codex_update";
  const approval = JSON.parse(
    await backend.agentRunOpenApproval({
      ...interaction,
      toolName,
      request: "Update this Codex entry?",
      targetBasis,
    }),
  );
  assert.deepEqual(approval, {
    ...runState(1, "waiting_approval"),
    interactionVersion: 0,
  });
  assert.deepEqual(
    JSON.parse(await backend.agentRunGetPendingApproval({ runId })),
    {
      interactionId: interaction.interactionId,
      interactionVersion: approval.interactionVersion,
      toolCallId: interaction.toolCallId,
      toolName,
      argsDigest: interaction.argsDigest,
      targetBasis,
    },
  );
  const decided = JSON.parse(
    await backend.agentRunDecideApproval({
      runId,
      runVersion: approval.version,
      interactionId: interaction.interactionId,
      interactionVersion: approval.interactionVersion,
      decision: "approved",
    }),
  );
  assert.deepEqual(decided, runState(2, "running"));
  assert.equal(
    JSON.parse(await backend.agentRunGetPendingApproval({ runId })),
    null,
  );
});

test("AgentRun interrupts and claims with the Native owner", async (t) => {
  const backend = await openWorkspace(t);
  await backend.agentRunStart(startPayload);
  assert.deepEqual(
    JSON.parse(await backend.agentRunRecover({ finalizingEvidence: [] })),
    [],
  );
  const interrupted = JSON.parse(
    await backend.agentRunInterrupt({
      runId,
      expectedStatus: "running",
      version: 0,
      reason: "renderer_lost",
    }),
  );
  assert.deepEqual(interrupted, runState(1, "interrupted"));

  const claimPayload = {
    runId,
    expectedVersion: interrupted.version,
    requestId: "claim-1",
    gate: { kind: "allowed" },
  };
  const claimed = JSON.parse(await backend.agentRunClaim(claimPayload));
  assert.deepEqual(claimed, runState(2, "running"));
  assert.deepEqual(
    JSON.parse(await backend.agentRunClaim(claimPayload)),
    claimed,
  );
});

test("AgentRun reads the unfinished run by session", async (t) => {
  const backend = await openWorkspace(t);
  const read = async () =>
    JSON.parse(
      await backend.agentRunGetUnfinishedForSession({ chatSessionId }),
    );
  assert.equal(await read(), null);
  await backend.agentRunStart(startPayload);
  assert.deepEqual(
    await read(),
    JSON.parse(await backend.agentRunGetStatus({ runId })),
  );
  await backend.agentRunInterrupt({
    runId,
    expectedStatus: "running",
    version: 0,
    reason: "renderer_lost",
  });
  assert.deepEqual(
    await read(),
    JSON.parse(await backend.agentRunGetStatus({ runId })),
  );
  await backend.agentRunDiscard({ runId, version: 1 });
  assert.equal(await read(), null);
  await assert.rejects(
    backend.agentRunGetUnfinishedForSession({
      chatSessionId,
      owner: "caller-owner",
    }),
    /unknown field `owner`/,
  );
});

test("AgentRun records a blocked gate and marks an interrupted run under its old owner", async (t) => {
  const root = tempRoot();
  const observer = await openWorkspace(t, root);
  const interrupt = {
    runId,
    expectedStatus: "running",
    version: 0,
    reason: "renderer_lost",
  };
  await withOwnerProcess(
    root,
    "agentRunInterrupt",
    interrupt,
    async (ready) => {
      assert.deepEqual(ready, runState(1, "interrupted"));
      const mark = { runId, reason: "route_unsupported" };
      const claim = { runId, expectedVersion: 1, requestId: "foreign-claim" };
      const detail = "Current route cannot resume this run";
      const blocked = await observer.agentRunClaim({
        ...claim,
        gate: { kind: "blocked", detail },
      });
      assert.equal(JSON.parse(blocked), null);
      assert.equal(
        JSON.parse(await observer.agentRunGetStatus({ runId }))
          .resumeBlockDetail,
        detail,
      );
      const marked = await observer.agentRunMarkNotResumable(mark);
      assert.deepEqual(JSON.parse(marked), runState(1, "interrupted"));
      const status = JSON.parse(await observer.agentRunGetStatus({ runId }));
      assert.equal(status.resumable, false);
      assert.equal(status.notResumableReason, mark.reason);
      await assert.rejects(
        observer.agentRunClaim({ ...claim, gate: { kind: "allowed" } }),
        /AGENT_RUN_NOT_RESUMABLE/,
      );
    },
  );
});

test("AgentRun refuses a live owner's finalizing run and closes it after owner exit", async (t) => {
  const root = tempRoot();
  const observer = await openWorkspace(t, root);
  const assistantMessageId = "assistant-message-1";
  const finalizing = { runId, version: 1 };
  await observer.dbExecute(
    "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    [assistantMessageId, chatSessionId, "assistant", "Opening scene outline"],
    "run",
  );
  const begin = {
    runId,
    expectedStatus: "running",
    version: 0,
    target: "completed",
    assistantMessageId,
  };
  await withOwnerProcess(
    root,
    "agentRunBeginFinalizing",
    begin,
    async (ready) => {
      assert.deepEqual(ready, runState(finalizing.version, "finalizing"));
      await assert.rejects(
        observer.agentRunMarkNotResumable({
          runId,
          reason: "route_unsupported",
        }),
        /AGENT_RUN_OWNER_MISMATCH/,
      );
      // The live owner's run is left out; it does not fail the whole list.
      assert.deepEqual(
        JSON.parse(await observer.agentRunListFinalizing({})),
        [],
      );
      await assert.rejects(
        observer.agentRunFinishFinalizing(finalizing),
        /AGENT_RUN_OWNER_LOCK_BUSY/,
      );
      await assert.rejects(
        observer.agentRunRecoverFinalizing({
          ...finalizing,
          userMessageComplete: true,
          assistantMessageComplete: true,
        }),
        /AGENT_RUN_OWNER_LOCK_BUSY/,
      );
    },
  );

  assert.deepEqual(JSON.parse(await observer.agentRunListFinalizing({})), [
    {
      ...finalizing,
      targetStatus: "completed",
      targetReason: "completed",
      originUserMessageId,
      originAssistantMessageId: assistantMessageId,
    },
  ]);
  const completed = await observer.agentRunFinishFinalizing(finalizing);
  assert.deepEqual(JSON.parse(completed), runState(2, "completed"));
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
    backend.agentRunStart({ ...startPayload, route: "bad_route" }),
    /unknown variant `bad_route`/,
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
