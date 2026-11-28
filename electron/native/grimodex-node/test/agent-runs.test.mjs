import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  executionId: "execution-1",
  toolCallId: "tool-call-1",
  argsDigest: "fixture-args-hash",
};
const runState = (version, status) => ({ runId, version, status });
const ledgerEntry = {
  executionId: interaction.executionId,
  toolCallId: interaction.toolCallId,
  name: "ask_user",
  canonicalArgs: {},
  argsDigest: interaction.argsDigest,
  chatMessageId: "assistant-message-1",
  mainOwnedProvenanceId: "",
  model: startPayload.modelId,
  capabilityState: "not_issued",
  executionState: "pending",
};

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

async function withOwnerProcess(
  root,
  method,
  payload,
  check,
  run = startPayload,
) {
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
    await backend.agentRunStart(${JSON.stringify(run)});
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
  const assistantMessageId = "assistant-message-1";
  const started = JSON.parse(
    await backend.agentRunStart({
      ...startPayload,
      originAssistantMessageId: assistantMessageId,
    }),
  );
  assert.deepEqual(started, runState(0, "running"));

  const questionPayload = {
    ...interaction,
    expectedVersion: started.version,
    request: "Which scene should the outline cover?",
  };
  await assert.rejects(
    backend.agentRunOpenQuestion(questionPayload),
    /AGENT_RUN_UNKNOWN_TOOL_CALL_ID/,
  );
  await backend.agentRunAppendToolCalls({ runId, entries: [ledgerEntry] });
  await assert.rejects(
    backend.agentRunOpenQuestion({ ...questionPayload, argsDigest: "wrong" }),
    /AGENT_RUN_TOOL_CALL_MISMATCH/,
  );
  const question = JSON.parse(
    await backend.agentRunOpenQuestion(questionPayload),
  );
  assert.deepEqual(question, {
    ...runState(1, "waiting_user"),
    interactionVersion: 0,
  });
  await assert.rejects(
    backend.agentRunFinishWithoutMessages({
      runId,
      expectedVersion: question.version,
      target: "user_stop",
    }),
    /AGENT_RUN_VERSION_OR_STATUS_MISMATCH/,
  );

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

  const begin = {
    runId,
    expectedStatus: answered.status,
    version: answered.version,
    target: "completed",
    assistantMessageId,
  };
  await assert.rejects(
    backend.agentRunBeginFinalizing({ ...begin, assistantMessageId: "wrong" }),
    /AGENT_RUN_ASSISTANT_MESSAGE_ID_MISMATCH/,
  );
  const finalizing = JSON.parse(await backend.agentRunBeginFinalizing(begin));
  assert.deepEqual(finalizing, runState(3, "finalizing"));
  assert.deepEqual(JSON.parse(await backend.agentRunListFinalizing({})), [
    {
      runId,
      targetStatus: "completed",
      targetReason: "completed",
      originUserMessageId,
      originAssistantMessageId: assistantMessageId,
      version: finalizing.version,
      ownedByCaller: true,
    },
  ]);
  const finalizingStatus = JSON.parse(
    await backend.agentRunGetStatus({ runId }),
  );
  assert.equal(finalizingStatus.ownedByCaller, true);
  assert.deepEqual(
    JSON.parse(
      await backend.agentRunGetUnfinishedForSession({ chatSessionId }),
    ),
    finalizingStatus,
  );

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

test("AgentRun binds pending approval to the latest ledger entry and returns its versions", async (t) => {
  const backend = await openWorkspace(t);
  await backend.agentRunStart(startPayload);
  const targetBasis = [
    { sourceKind: "codex", sourceId: "entry-1", version: "rev-1" },
  ];
  const toolName = "codex_update";
  const newerExecutionId = "execution-2";
  for (const executionId of [interaction.executionId, newerExecutionId]) {
    await backend.agentRunAppendToolCalls({
      runId,
      entries: [{ ...ledgerEntry, name: toolName, executionId }],
    });
  }
  const approvalPayload = {
    ...interaction,
    toolName,
    request: "Update this Codex entry?",
    targetBasis,
  };
  await assert.rejects(
    backend.agentRunOpenApproval(approvalPayload),
    /AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH/,
  );
  const latestApproval = { ...approvalPayload, executionId: newerExecutionId };
  for (const mismatch of [
    { toolName: "other_tool" },
    { argsDigest: "wrong" },
  ]) {
    await assert.rejects(
      backend.agentRunOpenApproval({ ...latestApproval, ...mismatch }),
      /AGENT_RUN_TOOL_CALL_MISMATCH/,
    );
  }
  const approval = JSON.parse(
    await backend.agentRunOpenApproval(latestApproval),
  );
  assert.deepEqual(approval, {
    ...runState(1, "waiting_approval"),
    interactionVersion: 0,
  });
  await assert.rejects(
    backend.agentRunFinishWithoutMessages({
      runId,
      expectedVersion: approval.version,
      target: "user_stop",
    }),
    /AGENT_RUN_VERSION_OR_STATUS_MISMATCH/,
  );
  assert.deepEqual(
    JSON.parse(await backend.agentRunGetPendingApproval({ runId })),
    {
      interactionId: interaction.interactionId,
      interactionVersion: approval.interactionVersion,
      executionId: newerExecutionId,
      toolCallId: interaction.toolCallId,
      toolName,
      argsDigest: interaction.argsDigest,
      targetBasis,
    },
  );
  await assert.rejects(
    backend.agentRunAppendToolCalls({
      runId,
      entries: [{ ...ledgerEntry, executionId: "execution-3" }],
    }),
    /AGENT_RUN_PENDING_INTERACTION_EXISTS/,
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
  await assert.rejects(
    backend.agentRunRecover({ finalizingEvidence: [] }),
    /missing field `minActivityAgeSecs`/,
  );
  assert.deepEqual(
    JSON.parse(
      await backend.agentRunRecover({
        minActivityAgeSecs: 0,
        finalizingEvidence: [],
      }),
    ),
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
  await assert.rejects(
    backend.agentRunAppendToolCalls({ runId, entries: [ledgerEntry] }),
    /AGENT_RUN_VERSION_OR_STATUS_MISMATCH/,
  );

  const claimPayload = {
    runId,
    expectedVersion: interrupted.version,
    requestId: "claim-1",
    gate: { kind: "allowed" },
  };
  await assert.rejects(
    backend.agentRunClaim({
      ...claimPayload,
      gate: { kind: "allowed", extra: 1 },
    }),
    /unknown field `extra`/,
  );
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
      const mark = {
        runId,
        expectedStatus: "interrupted",
        reason: "route_unsupported",
      };
      const claim = { runId, expectedVersion: 1, requestId: "foreign-claim" };
      await assert.rejects(
        observer.agentRunClaim({
          ...claim,
          gate: { kind: "blocked", detail: "free text" },
        }),
        /unknown variant `free text`/,
      );
      const detail = "route_unavailable";
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
      await assert.rejects(
        observer.agentRunMarkNotResumable({
          ...mark,
          expectedStatus: "running",
        }),
        /AGENT_RUN_OWNER_MISMATCH/,
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

test("AgentRun requires both an old-enough finalizing run and a dead foreign owner", async (t) => {
  const root = tempRoot();
  const observer = await openWorkspace(t, root);
  const assistantMessageId = "assistant-message-1";
  const finalizing = { runId, version: 1 };
  const evidence = {
    ...finalizing,
    userMessageComplete: true,
    assistantMessageComplete: true,
  };
  const recovery = { ...evidence, reason: "renderer_lost" };
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
          expectedStatus: "finalizing",
          reason: "route_unsupported",
        }),
        /AGENT_RUN_OWNER_MISMATCH/,
      );
      // The live owner's run is left out; it does not fail the whole list.
      assert.deepEqual(
        JSON.parse(await observer.agentRunListFinalizing({})),
        [],
      );
      assert.deepEqual(JSON.parse(await observer.agentRunListOwned({})), []);
      await assert.rejects(
        observer.agentRunFinishFinalizing({
          ...finalizing,
          minActivityAgeSecs: 0,
        }),
        /AGENT_RUN_OWNER_LOCK_BUSY/,
      );
      await assert.rejects(
        observer.agentRunRecoverFinalizing({
          ...recovery,
          minActivityAgeSecs: 0,
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
      ownedByCaller: false,
    },
  ]);
  const status = JSON.parse(await observer.agentRunGetStatus({ runId }));
  assert.equal(status.ownedByCaller, false);
  assert.equal(Object.hasOwn(status, "executionOwner"), false);
  assert.deepEqual(
    JSON.parse(
      await observer.agentRunGetUnfinishedForSession({ chatSessionId }),
    ),
    status,
  );
  await assert.rejects(
    observer.agentRunFinishFinalizing(finalizing),
    /AGENT_RUN_ACTIVITY_AGE_REQUIRED/,
  );
  await assert.rejects(
    observer.agentRunRecoverFinalizing(recovery),
    /AGENT_RUN_ACTIVITY_AGE_REQUIRED/,
  );
  const minActivityAgeSecs = 86_400;
  const skipped = {
    ...finalizing,
    outcome: "skipped",
    reason: "AGENT_RUN_ACTIVITY_TOO_RECENT",
  };
  assert.deepEqual(
    JSON.parse(
      await observer.agentRunFinishFinalizing({
        ...finalizing,
        minActivityAgeSecs,
      }),
    ),
    skipped,
  );
  assert.deepEqual(
    JSON.parse(
      await observer.agentRunRecoverFinalizing({
        ...recovery,
        minActivityAgeSecs,
      }),
    ),
    skipped,
  );
  assert.deepEqual(
    JSON.parse(
      await observer.agentRunRecover({
        finalizingEvidence: [evidence],
        minActivityAgeSecs,
      }),
    ),
    [{ outcome: "recovered", results: [] }],
  );
  assert.deepEqual(
    JSON.parse(await observer.agentRunGetStatus({ runId })),
    status,
  );
  const completed = await observer.agentRunFinishFinalizing({
    ...finalizing,
    minActivityAgeSecs: 0,
  });
  assert.deepEqual(JSON.parse(completed), runState(2, "completed"));
});

test("AgentRun batch append is atomic and keys updates by execution and call", async (t) => {
  const backend = await openWorkspace(t);
  await backend.agentRunStart(startPayload);
  const extraEntry = { ...ledgerEntry, toolCallId: "tool-call-2" };
  const otherExecution = { ...ledgerEntry, executionId: "execution-2" };
  await assert.rejects(
    backend.agentRunAppendToolCalls({
      runId,
      entries: [ledgerEntry, otherExecution],
    }),
    /AGENT_RUN_TOOL_CALL_BATCH_EXECUTION_MISMATCH/,
  );
  const append = { runId, entries: [ledgerEntry, extraEntry] };
  assert.equal(JSON.parse(await backend.agentRunAppendToolCalls(append)), null);
  await assert.rejects(
    backend.agentRunAppendToolCalls(append),
    /AGENT_RUN_DUPLICATE_TOOL_CALL_ID/,
  );
  await backend.agentRunAppendToolCalls({ runId, entries: [otherExecution] });
  for (const { executionId, toolCallId } of [
    ledgerEntry,
    extraEntry,
    otherExecution,
  ]) {
    assert.equal(
      JSON.parse(
        await backend.agentRunUpdateToolCall({
          runId,
          executionId,
          toolCallId,
          mainOwnedProvenanceId: `${executionId}-${toolCallId}`,
        }),
      ),
      null,
    );
  }
  await assert.rejects(
    backend.agentRunUpdateToolCall({
      runId,
      executionId: otherExecution.executionId,
      toolCallId: extraEntry.toolCallId,
    }),
    /AGENT_RUN_UNKNOWN_TOOL_CALL_ID/,
  );
});

test("AgentRun lists owned unfinished runs, records audit IDs and finishes without messages", async (t) => {
  const root = tempRoot();
  const backend = await openWorkspace(t, root);
  const owned = async () => JSON.parse(await backend.agentRunListOwned({}));
  assert.deepEqual(await owned(), []);
  const originAssistantMessageId = "assistant-at-start";
  await backend.agentRunStart({ ...startPayload, originAssistantMessageId });
  const [run] = await owned();
  assert.deepEqual(await owned(), [
    {
      ...runState(0, "running"),
      projectId,
      chatSessionId,
      turnId: startPayload.turnId,
      originUserMessageId,
      originAssistantMessageId,
      activityAt: run.activityAt,
      interruptReason: null,
      finalizingTargetStatus: null,
    },
  ]);
  assert.equal(typeof run.activityAt, "string");
  const audit = { runId, executionId: "child-execution-1" };
  assert.equal(
    JSON.parse(await backend.agentRunAddAuditExecutionId(audit)),
    null,
  );
  assert.equal(
    JSON.parse(await backend.agentRunAddAuditExecutionId(audit)),
    null,
  );
  const sqlite = new DatabaseSync(join(root, "workspace", "grimodex.db"), {
    readOnly: true,
  });
  try {
    const stored = sqlite
      .prepare("SELECT audit_execution_ids FROM agent_runs WHERE run_id = ?")
      .get(runId);
    assert.deepEqual(JSON.parse(stored.audit_execution_ids), [
      audit.executionId,
    ]);
  } finally {
    sqlite.close();
  }
  await assert.rejects(
    backend.agentRunAddAuditExecutionId({ ...audit, executionId: "" }),
    /AGENT_RUN_EXECUTION_ID_INVALID/,
  );
  const finish = {
    runId,
    expectedVersion: 0,
    target: "user_stop",
  };
  await assert.rejects(
    backend.agentRunFinishWithoutMessages({
      ...finish,
      expectedStatus: "running",
    }),
    /unknown field `expectedStatus`/,
  );
  await assert.rejects(
    backend.agentRunFinishWithoutMessages({ ...finish, expectedVersion: 1 }),
    /AGENT_RUN_VERSION_OR_STATUS_MISMATCH/,
  );
  assert.deepEqual(
    JSON.parse(await backend.agentRunFinishWithoutMessages(finish)),
    runState(1, "cancelled"),
  );
  assert.equal(
    JSON.parse(await backend.agentRunGetStatus({ runId })).terminalReason,
    "user_stop",
  );
  assert.deepEqual(await owned(), []);
  await assert.rejects(
    backend.agentRunAddAuditExecutionId(audit),
    /AGENT_RUN_TERMINAL/,
  );
});

test("AgentRun recovers owned finalizing with the supplied reason and no age minimum", async (t) => {
  const backend = await openWorkspace(t);
  await backend.agentRunStart(startPayload);
  await backend.agentRunBeginFinalizing({
    runId,
    expectedStatus: "running",
    version: 0,
    target: "completed",
    assistantMessageId: "incomplete-assistant",
  });
  const recovered = await backend.agentRunRecoverFinalizing({
    runId,
    version: 1,
    userMessageComplete: true,
    assistantMessageComplete: false,
    reason: "profile_switched",
  });
  assert.deepEqual(JSON.parse(recovered), {
    runId,
    version: 2,
    outcome: "interrupted",
  });
  const [run] = JSON.parse(await backend.agentRunListOwned({}));
  assert.equal(run.status, "interrupted");
  assert.equal(run.interruptReason, "profile_switched");
  const newRun = {
    ...startPayload,
    runId: "run-2",
    turnId: "turn-2",
    originAssistantMessageId: "superseding-assistant",
  };
  assert.deepEqual(
    JSON.parse(
      await backend.agentRunStartSuperseding({
        oldRunId: runId,
        oldVersion: run.version,
        newRun,
      }),
    ),
    {
      discarded: runState(3, "discarded"),
      started: { runId: newRun.runId, version: 0, status: "running" },
    },
  );
  const [superseding] = JSON.parse(await backend.agentRunListOwned({}));
  assert.equal(
    superseding.originAssistantMessageId,
    newRun.originAssistantMessageId,
  );
});

test("AgentRun recovery groups successes and failures by owner without owner IDs", async (t) => {
  const root = tempRoot();
  const observer = await openWorkspace(t, root);
  const lockDir = join(root, "workspace", ".grimodex", "agent-run-owners");
  await withOwnerProcess(root, "agentRunGetStatus", { runId }, () => {});
  const [failedLock] = readdirSync(lockDir);
  const path = join(lockDir, failedLock);
  renameSync(path, `${path}.fixture`);
  mkdirSync(path);

  const otherRun = {
    ...startPayload,
    runId: "run-2",
    turnId: "turn-2",
    chatSessionId: "session-2",
    originUserMessageId: "user-message-2",
  };
  await observer.dbExecute(
    "INSERT INTO chat_sessions (id, project_id, title) VALUES (?, ?, ?)",
    [otherRun.chatSessionId, projectId, "Second recovery fixture"],
    "run",
  );
  await observer.dbExecute(
    "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    [
      otherRun.originUserMessageId,
      otherRun.chatSessionId,
      "user",
      "Draft a scene.",
    ],
    "run",
  );
  await withOwnerProcess(
    root,
    "agentRunGetStatus",
    { runId: otherRun.runId },
    () => {},
    otherRun,
  );
  const recovered = JSON.parse(
    await observer.agentRunRecover({
      minActivityAgeSecs: 0,
      finalizingEvidence: [],
    }),
  );
  assert.deepEqual(
    recovered.sort((a, b) => a.outcome.localeCompare(b.outcome)),
    [
      { outcome: "failed", reason: "AGENT_RUN_OWNER_RECOVERY_FAILED" },
      {
        outcome: "recovered",
        results: [
          { runId: otherRun.runId, version: 1, outcome: "interrupted" },
        ],
      },
    ],
  );
  assert.equal(
    JSON.parse(await observer.agentRunGetStatus({ runId })).status,
    "running",
  );
});

test("AgentRun rejects unknown fields and caller-supplied owner IDs", async (t) => {
  const backend = await openWorkspace(t);
  await assert.rejects(
    backend.agentRunListOwned({ owner: "caller-owner" }),
    /unknown field `owner`/,
  );
  await assert.rejects(
    backend.agentRunAppendToolCalls({
      runId,
      entries: [{ ...ledgerEntry, unexpected: true }],
    }),
    /unknown field `unexpected`/,
  );
  await assert.rejects(
    backend.agentRunRecoverFinalizing({
      runId,
      version: 0,
      userMessageComplete: false,
      assistantMessageComplete: false,
      reason: "invalid_reason",
    }),
    /unknown variant `invalid_reason`/,
  );
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
