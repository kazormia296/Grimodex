import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunErrorCode } from "../shared/agentRunTypes.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  createAgentApprovalExchange,
  type AgentApprovalPendingInfo,
} from "./agentApprovalExchange.js";
import { createAgentRunRecorder } from "./agentRunRecorder.js";
import type {
  AgentRunApprovalPort,
  AgentRunLedgerEntry,
} from "./agentRunRecorderPort.js";
import { agentToolInputDigest } from "./agentToolInputDigest.js";

vi.mock("electron", () => ({ dialog: {} }));

type NativeBackendInstance = Parameters<
  typeof createAgentRunRecorder
>[0]["backend"] &
  Required<
    Pick<
      NapiBackendLike,
      | "openWorkspace"
      | "dbExecute"
      | "seedSampleWorkspace"
      | "shutdownWorkspaceLifecycle"
    >
  >;

// path は部品から組み立てる。scripts/ci-change-scope.test.mjs は相対の import を
// すべて解決できることを求め、CI のその段には .node がまだ無い。
const ADDON = path.join(
  path.resolve(__dirname, "..", ".."),
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
const { Backend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};

let root: string | undefined;
let backend: NativeBackendInstance | undefined;

afterEach(async () => {
  try {
    await backend?.shutdownWorkspaceLifecycle();
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
    backend = undefined;
    root = undefined;
  }
});

const fixtureDigest = "a".repeat(64);

async function openFixture({
  readPersistence = false,
  toolInputDigest = () => fixtureDigest,
}: {
  readPersistence?: boolean;
  toolInputDigest?: typeof agentToolInputDigest;
} = {}) {
  root = await mkdtemp(path.join(os.tmpdir(), "grimodex-agentrun-"));
  const appData = path.join(root, "app-data");
  await mkdir(appData);
  const native = new Backend(appData);
  backend = native;
  const { path: workspacePath, projectId } = JSON.parse(
    await native.seedSampleWorkspace(
      "ja",
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}',
    ),
  ) as { path: string; projectId: string };
  await native.openWorkspace(workspacePath);
  const turn = {
    senderId: 7,
    projectId,
    chatSessionId: "chat",
    operationId: "turn",
    route: "legacy",
    userMessageId: "user-message",
    assistantMessageId: "assistant-message",
    providerId: "fixture-provider",
    modelId: "fixture-model",
    endpointHash: "fixture-endpoint-hash",
  } as const;
  const recorder = createAgentRunRecorder({
    backend: native,
    isEnabled: () => true,
    toolInputDigest,
    newRunId: randomUUID,
    readTurnPersistence: readPersistence
      ? async ({
          projectId,
          chatSessionId,
          userMessageId,
          assistantMessageId,
        }) => {
          const { rows } = JSON.parse(
            await native.dbExecute(
              `SELECT m.role FROM chat_messages m
                JOIN chat_sessions s ON s.id = m.session_id
               WHERE s.project_id = ? AND s.id = ?
                 AND ((m.id = ? AND m.role = 'user')
                   OR (m.id = ? AND m.role = 'assistant'
                       AND (m.content <> '' OR m.metadata IS NOT NULL)))`,
              [projectId, chatSessionId, userMessageId, assistantMessageId],
              "all",
            ),
          ) as { rows: { role: string }[] };
          return {
            userMessageComplete: rows.some(({ role }) => role === "user"),
            assistantMessageComplete: rows.some(
              ({ role }) => role === "assistant",
            ),
          };
        }
      : undefined,
  });
  async function startRun(input: TurnFixture) {
    await native.dbExecute(
      "INSERT INTO chat_sessions (id, project_id, title) VALUES (?, ?, ?)",
      [input.chatSessionId, input.projectId, "Chat"],
      "run",
    );
    const started = await recorder.start(input);
    if (started.kind !== "recorded") throw new Error("expected a recorded Run");
    return { turn: input, runId: started.runId };
  }

  const { runId } = await startRun(turn);
  const status = async (): Promise<unknown> =>
    JSON.parse(await native.agentRunGetStatus({ runId }));
  return {
    native,
    recorder,
    turn,
    digest: fixtureDigest,
    runId,
    status,
    startAnotherRun: (label: string) =>
      startRun({ ...turn, chatSessionId: `chat-${label}`, operationId: label }),
  };
}

type TurnFixture = Parameters<
  ReturnType<typeof createAgentRunRecorder>["start"]
>[0];
type OpenApproval = Parameters<AgentRunApprovalPort["openApproval"]>[0];
type Fixture = Awaited<ReturnType<typeof openFixture>>;

async function recordToolCall(
  { recorder, turn }: { recorder: Fixture["recorder"]; turn: TurnFixture },
  {
    executionId,
    toolCallId,
    toolName,
  }: Pick<OpenApproval, "executionId" | "toolCallId" | "toolName">,
) {
  expect(
    await recorder.recordResponse({
      ...turn,
      executionId,
      chatMessageId: turn.assistantMessageId,
      model: turn.modelId,
      toolUses: [{ id: toolCallId, name: toolName, input: {} }],
    }),
  ).toBe("recorded");
}

async function approvalFixture(record = true) {
  const fixture = await openFixture();
  const { runId, digest, turn } = fixture;
  const entry: AgentRunLedgerEntry = {
    executionId: "execution",
    toolCallId: "tool-call",
    name: "update_fixture",
    argsDigest: digest,
    canonicalArgs: {},
    chatMessageId: turn.assistantMessageId,
    mainOwnedProvenanceId: "",
    model: turn.modelId,
    capabilityState: "not_issued",
    executionState: "pending",
  };
  const approval: OpenApproval = {
    runId,
    expectedVersion: 0,
    interactionId: "approval",
    executionId: entry.executionId,
    toolCallId: entry.toolCallId,
    toolName: entry.name,
    argsDigest: entry.argsDigest,
    request: "Apply the proposed change?",
    targetBasis: null,
  };
  if (record) await recordToolCall(fixture, approval);
  const pending = {
    runId,
    expectedVersion: 1,
    interactionId: approval.interactionId,
    interactionVersion: 0,
  };
  return { ...fixture, entry, approval, pending };
}

async function expectCode(promise: Promise<unknown>, code: AgentRunErrorCode) {
  await expect(promise).rejects.toHaveProperty("message", code);
}

async function readInteraction(
  native: NativeBackendInstance,
  interactionId: string,
) {
  const { rows } = JSON.parse(
    await native.dbExecute(
      "SELECT status, request, resolution FROM agent_run_interactions WHERE interaction_id = ?",
      [interactionId],
      "all",
    ),
  ) as {
    rows: { status: string; request: string; resolution: string | null }[];
  };
  return rows[0];
}

async function readLedger(native: NativeBackendInstance, runId: string) {
  const { rows } = JSON.parse(
    await native.dbExecute(
      "SELECT tool_call_ledger FROM agent_runs WHERE run_id = ?",
      [runId],
      "all",
    ),
  ) as { rows: { tool_call_ledger: string }[] };
  return JSON.parse(rows[0].tool_call_ledger) as AgentRunLedgerEntry[];
}

async function saveTurnMessages(
  native: NativeBackendInstance,
  turn: TurnFixture,
) {
  for (const [id, role] of [
    [turn.userMessageId, "user"],
    [turn.assistantMessageId, "assistant"],
  ]) {
    await native.dbExecute(
      "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
      [id, turn.chatSessionId, role, "Fixture message"],
      "run",
    );
  }
}

describe("AgentRun recorder against the real Native addon", () => {
  it("opens and decides a recorded tool call through the real approval exchange", async () => {
    const { native, recorder, turn, runId, status } = await openFixture({
      toolInputDigest: agentToolInputDigest,
    });
    const executionId = "execution";
    const toolCallId = "tool-call";
    const toolName = "update_codex_entry";
    // Padding makes the model digest differ from the recorder's raw-input fallback.
    const modelInput = { id: "entry-1", name: " Revised " };
    const invocation = {
      executionId,
      chatMessageId: turn.assistantMessageId,
      model: turn.modelId,
    };
    expect(
      await recorder.recordResponse({
        ...turn,
        ...invocation,
        toolUses: [{ id: toolCallId, name: toolName, input: modelInput }],
      }),
    ).toBe("recorded");
    const owner = { senderId: turn.senderId, projectId: turn.projectId };
    const run = recorder.resolveRun({ ...owner, executionId });
    if (run.kind !== "recorded") throw new Error("expected ledger binding");

    const interactionId = "approval";
    const target = {
      summary: "Rename the codex entry",
      basis: null,
      baseVersions: [{ id: modelInput.id, version: 1 }],
      expected: null,
    };
    const grant = { mainOwnedProvenanceId: "provenance" };
    let notify!: (info: AgentApprovalPendingInfo) => void;
    const pending = new Promise<AgentApprovalPendingInfo>((resolve) => {
      notify = resolve;
    });
    const controller = new AbortController();
    const exchange = createAgentApprovalExchange({
      port: recorder,
      inputDigest: agentToolInputDigest,
      isPolicyAllowed: () => true,
      readTarget: () => target,
      prepareCapability: () => ({ grant, activate() {}, revoke() {} }),
      onPending: notify,
      setTimer: () => () => {},
      newId: () => interactionId,
    });
    const request = exchange.request({
      ...owner,
      ...invocation,
      toolCallId,
      toolName,
      modelInput,
      observed: target,
      run,
      signal: controller.signal,
    });
    try {
      expect(await Promise.race([pending, request])).toMatchObject({
        interactionId,
        executionId,
        toolCallId,
        toolName,
      });
      expect(await status()).toMatchObject({
        runId,
        version: 1,
        status: "waiting_approval",
      });
      expect(
        exchange.resolve({ ...owner, interactionId, decision: "approved" }),
      ).toBe("accepted");
      expect(await request).toEqual({ kind: "approved", interactionId, grant });
      expect(await status()).toMatchObject({
        runId,
        version: 2,
        status: "running",
      });
      expect(await readInteraction(native, interactionId)).toMatchObject({
        status: "resolved",
        resolution: "approved",
      });
    } finally {
      controller.abort();
      await request;
    }
  });

  it("records a response, approves its tool, updates the ledger and finalizes", async () => {
    const { native, recorder, turn, digest, runId, status } =
      await openFixture();
    expect(await status()).toMatchObject({
      runId,
      status: "running",
      version: 0,
      ownedByCaller: true,
    });
    const call = { executionId: "execution", toolCallId: "tool-call" };
    const toolName = "update_fixture";
    expect(
      await recorder.recordResponse({
        ...turn,
        executionId: call.executionId,
        chatMessageId: turn.assistantMessageId,
        model: turn.modelId,
        toolUses: [
          { id: call.toolCallId, name: toolName, input: { title: "Revised" } },
        ],
      }),
    ).toBe("recorded");
    const resolution = recorder.resolveRun({
      ...turn,
      executionId: call.executionId,
    });
    if (resolution.kind !== "recorded")
      throw new Error("expected ledger binding");
    const interactionId = "approval";
    const opened = await resolution.transact((expectedVersion) =>
      recorder.openApproval({
        ...call,
        runId,
        expectedVersion,
        interactionId,
        toolName,
        argsDigest: digest,
        request: "Update the title",
        targetBasis: null,
      }),
    );
    expect(opened).toEqual({
      runId,
      version: 1,
      status: "waiting_approval",
      interactionVersion: 0,
    });
    const pending = await recorder.getPendingApproval(runId);
    expect(pending).toEqual({
      ...call,
      interactionId,
      version: 0,
      toolName,
      argsDigest: digest,
      targetBasis: null,
    });
    const decided = await resolution.transact((expectedVersion) =>
      recorder.decideApproval({
        runId,
        expectedVersion,
        interactionId,
        interactionVersion: opened.interactionVersion,
        decision: "approved",
      }),
    );
    expect(decided).toEqual({ runId, version: 2, status: "running" });
    expect(await readInteraction(native, interactionId)).toMatchObject({
      status: "resolved",
      request: "Update the title",
      resolution: "approved",
    });
    expect(await recorder.getPendingApproval(runId)).toBeNull();
    await recorder.updateToolCall(runId, call, {
      mainOwnedProvenanceId: "provenance",
      capabilityState: "issued",
    });
    await recorder.updateToolCall(runId, call, {
      capabilityState: "consumed",
      executionState: "committed",
    });
    expect(
      await recorder.beginFinalizing(
        turn,
        "completed",
        turn.assistantMessageId,
      ),
    ).toEqual({
      runId,
      version: 3,
      status: "finalizing",
    });
    await saveTurnMessages(native, turn);
    expect(await recorder.finishFinalizing(turn)).toEqual({
      runId,
      version: 4,
      status: "completed",
    });
    expect(await status()).toMatchObject({
      status: "completed",
      terminalReason: "completed",
      version: 4,
    });
    expect(
      recorder.resolveRun({ ...turn, executionId: call.executionId }),
    ).toEqual({ kind: "unrecorded" });
  });

  // 呼び出し側の試験（grimodex-node の main-pipeline-specs）は、出力に「失敗」を表す
  // 英単語があると落ちる。試験名に戻り値の語を埋め込まない。
  it.each([
    { result: "recorded", label: "the non-resumable mark is written" },
    { result: "failed", label: "the non-resumable mark cannot be written" },
  ] as const)(
    "keeps only valid tool call IDs when $label",
    async ({ result }) => {
      const { native, recorder, turn, runId, status } = await openFixture();
      const executionId = "execution";
      const mark = vi.spyOn(native, "agentRunMarkNotResumable");
      if (result === "failed") {
        mark.mockRejectedValueOnce(
          new Error("AGENT_RUN_VERSION_OR_STATUS_MISMATCH"),
        );
      }
      try {
        expect(
          await recorder.recordResponse({
            ...turn,
            executionId,
            chatMessageId: turn.assistantMessageId,
            model: turn.modelId,
            toolUses: ["", " \t", " padded", "padded ", "tool-call"].map(
              (id) => ({
                id,
                name: "update_fixture",
                input: { title: "Revised" },
              }),
            ),
          }),
        ).toBe(result);
        expect(mark).toHaveBeenCalledOnce();
      } finally {
        mark.mockRestore();
      }
      expect(await readLedger(native, runId)).toEqual([
        expect.objectContaining({ toolCallId: "tool-call", executionId }),
      ]);
      const resolution = recorder.resolveRun({ ...turn, executionId });
      if (result === "failed") {
        expect(resolution).toEqual({ kind: "unrecorded" });
        expect(await status()).toMatchObject({
          status: "running",
          resumable: true,
        });
      } else {
        expect(resolution).toMatchObject({ kind: "recorded", runId });
        expect(await status()).toMatchObject({
          resumable: false,
          notResumableReason: "ledger_write_failed",
        });
      }
    },
  );

  it("interrupts active and incomplete finalizing Runs before a workspace switch", async () => {
    const { native, recorder, turn, status, startAnotherRun } =
      await openFixture();
    const active = await startAnotherRun("switch");
    await recorder.beginFinalizing(turn, "completed", turn.assistantMessageId);
    expect(await recorder.interruptForSwitch("workspace_switched")).toEqual([]);
    expect(await status()).toMatchObject({
      status: "interrupted",
      interruptReason: "workspace_switched",
      version: 2,
      resumable: true,
    });
    expect(
      JSON.parse(await native.agentRunGetStatus({ runId: active.runId })),
    ).toMatchObject({
      status: "interrupted",
      interruptReason: "workspace_switched",
      version: 1,
    });
  });

  it("recovers a Stop after both messages are saved and the renderer is lost", async () => {
    const { native, recorder, turn, runId, status } = await openFixture({
      readPersistence: true,
    });
    await recorder.beginFinalizing(turn, "user_stop", turn.assistantMessageId);
    for (const [id, role, content] of [
      [turn.userMessageId, "user", "Fixture user message"],
      [turn.assistantMessageId, "assistant", ""],
    ]) {
      await native.dbExecute(
        "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
        [id, turn.chatSessionId, role, content],
        "run",
      );
    }
    expect(
      await recorder.interruptSender(turn.senderId, "renderer_lost"),
    ).toEqual([runId]);
    expect(await status()).toMatchObject({ status: "finalizing", version: 1 });

    await native.dbExecute(
      "UPDATE chat_messages SET content = ? WHERE id = ? AND session_id = ?",
      [
        "Fixture assistant message",
        turn.assistantMessageId,
        turn.chatSessionId,
      ],
      "run",
    );
    expect(
      await recorder.interruptSender(turn.senderId, "renderer_lost"),
    ).toEqual([]);
    expect(await status()).toMatchObject({
      status: "cancelled",
      terminalReason: "user_stop",
      version: 2,
    });
  });
});

describe("AgentRun approval port contract against Native", () => {
  it("stores a null resolution when an approval is superseded", async () => {
    const { native, recorder, runId, approval, pending } =
      await approvalFixture();
    await recorder.openApproval(approval);
    expect(
      await recorder.invalidateApproval({
        ...pending,
        outcome: "superseded",
      }),
    ).toEqual({ runId, version: 2, status: "running" });
    expect(await readInteraction(native, approval.interactionId)).toMatchObject(
      {
        status: "superseded",
        request: approval.request,
        resolution: null,
      },
    );
  });

  it("rejects an approval whose tool call has no ledger row", async () => {
    const { recorder, approval } = await approvalFixture(false);
    await expectCode(
      recorder.openApproval(approval),
      "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
    );
  });

  it("requires the expected run and interaction versions and statuses", async () => {
    const { recorder, approval, pending } = await approvalFixture();
    await expectCode(
      recorder.openApproval({ ...approval, expectedVersion: 1 }),
      "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
    );
    await recorder.openApproval(approval);
    const decision = { ...pending, decision: "rejected" } as const;
    await expectCode(
      recorder.decideApproval({ ...decision, expectedVersion: 0 }),
      "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
    );
    await expectCode(
      recorder.decideApproval({ ...decision, interactionVersion: 1 }),
      "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
    );
  });

  it("rejects a second pending interaction, malformed basis, and oversized UTF-8 request", async () => {
    const { recorder, approval } = await approvalFixture();
    for (const targetBasis of [
      [],
      Array.from({ length: 65 }, () => ({
        sourceKind: "entry",
        sourceId: "1",
        version: "v1",
      })),
      Array.from({ length: 64 }, () => ({
        sourceKind: "k".repeat(64),
        sourceId: "i".repeat(256),
        version: "v".repeat(256),
      })),
      [{ sourceKind: "é".repeat(33), sourceId: "1", version: "v1" }],
    ]) {
      await expectCode(
        recorder.openApproval({ ...approval, targetBasis }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
    }
    // These shapes fail Native deserialization before it attaches an AGENT_RUN code.
    for (const targetBasis of [
      [
        {
          sourceKind: "entry",
          sourceId: "1",
          version: "v1",
          contentHash: "hash",
        },
      ],
      [{ sourceKind: "entry", sourceId: "1" }],
    ]) {
      await expect(
        recorder.openApproval({
          ...approval,
          targetBasis: targetBasis as unknown as OpenApproval["targetBasis"],
        }),
      ).rejects.toBeDefined();
    }
    await expectCode(
      recorder.openApproval({ ...approval, request: "é".repeat(32_769) }),
      "AGENT_RUN_REQUEST_TOO_LARGE",
    );
    await recorder.openApproval(approval);
    await expectCode(
      recorder.openApproval({
        ...approval,
        expectedVersion: 1,
        interactionId: "second-approval",
      }),
      "AGENT_RUN_PENDING_INTERACTION_EXISTS",
    );
  });

  it("keeps an approval pending on timeout", async () => {
    const { native, recorder, runId, approval, pending } =
      await approvalFixture();
    await recorder.openApproval(approval);
    expect(
      await recorder.interruptForApprovalTimeout({
        runId,
        expectedVersion: pending.expectedVersion,
      }),
    ).toEqual({ runId, version: 2, status: "interrupted" });
    expect(await readInteraction(native, approval.interactionId)).toMatchObject(
      {
        status: "pending",
        request: approval.request,
      },
    );
    expect(await recorder.getPendingApproval(runId)).toMatchObject({
      interactionId: approval.interactionId,
      version: 0,
    });
  });

  it("cancels and scrubs a pending approval and ledger when the run stops", async () => {
    const { native, recorder, runId, turn, approval } = await approvalFixture();
    await recorder.openApproval(approval);
    await recorder.beginFinalizing(turn, "user_stop", turn.assistantMessageId);
    await saveTurnMessages(native, turn);
    expect(await recorder.finishFinalizing(turn)).toEqual({
      runId,
      version: 3,
      status: "cancelled",
    });
    expect(await readInteraction(native, approval.interactionId)).toMatchObject(
      {
        status: "cancelled",
        request: "",
      },
    );
    expect(await recorder.getPendingApproval(runId)).toBeNull();
    expect(await readLedger(native, runId)).toEqual([]);
  });

  it("matches ledger rejection rules without incrementing run version", async () => {
    const { recorder, runId, entry, status } = await approvalFixture();
    await expectCode(
      recorder.appendToolCalls(runId, [entry]),
      "AGENT_RUN_DUPLICATE_TOOL_CALL_ID",
    );
    const key = {
      executionId: entry.executionId,
      toolCallId: entry.toolCallId,
    };
    await expectCode(
      recorder.updateToolCall(
        runId,
        { ...key, toolCallId: "missing" },
        {
          capabilityState: "issued",
        },
      ),
      "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
    );
    await recorder.updateToolCall(runId, key, {
      capabilityState: "issued",
      executionState: "committed",
    });
    await expectCode(
      recorder.updateToolCall(runId, key, {
        capabilityState: "awaiting_approval",
      }),
      "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
    );
    await expectCode(
      recorder.updateToolCall(runId, key, { executionState: "failed" }),
      "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
    );
    expect(await status()).toMatchObject({
      runId,
      version: 0,
      status: "running",
    });
  });

  it("validates batched ledger keys and blocks appending the pending tool call ID", async () => {
    const { recorder, runId, entry, approval, startAnotherRun } =
      await approvalFixture(false);
    const otherExecution = { ...entry, executionId: "other-execution" };
    await expectCode(
      recorder.appendToolCalls(runId, []),
      "AGENT_RUN_EMPTY_TOOL_CALL_BATCH",
    );
    await expectCode(
      recorder.appendToolCalls(runId, [{ ...entry, toolCallId: "" }]),
      "AGENT_RUN_TOOL_CALL_ID_INVALID",
    );
    await expectCode(
      recorder.appendToolCalls(runId, [entry, otherExecution]),
      "AGENT_RUN_TOOL_CALL_BATCH_EXECUTION_MISMATCH",
    );
    await recorder.appendToolCalls(runId, [entry]);
    await expectCode(
      recorder.appendToolCalls(runId, [entry]),
      "AGENT_RUN_DUPLICATE_TOOL_CALL_ID",
    );
    await recorder.openApproval(approval);
    await expectCode(
      recorder.appendToolCalls(runId, [otherExecution]),
      "AGENT_RUN_PENDING_INTERACTION_EXISTS",
    );
    const second = await startAnotherRun("execution-scoped-keys");
    await recorder.appendToolCalls(second.runId, [
      { ...entry, executionId: "scoped-execution-1" },
    ]);
    await recorder.appendToolCalls(second.runId, [
      { ...entry, executionId: "scoped-execution-2" },
    ]);
  });

  it("rejects ledger appends after interruption but permits updates", async () => {
    const { native, recorder, runId, entry, approval } =
      await approvalFixture();
    await recorder.openApproval(approval);
    await recorder.interruptForApprovalTimeout({ runId, expectedVersion: 1 });
    await expectCode(
      recorder.appendToolCalls(runId, [{ ...entry, toolCallId: "later-call" }]),
      "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
    );
    await recorder.updateToolCall(
      runId,
      { executionId: entry.executionId, toolCallId: entry.toolCallId },
      { executionState: "failed" },
    );
    expect(await readLedger(native, runId)).toEqual([
      expect.objectContaining({
        executionId: entry.executionId,
        toolCallId: entry.toolCallId,
        executionState: "failed",
      }),
    ]);
  });

  it("opens only the latest matching tool call row and exposes its execution ID", async () => {
    const fixture = await approvalFixture();
    const { recorder, runId, approval, pending } = fixture;
    await recorder.openApproval(approval);
    expect(await recorder.getPendingApproval(runId)).toMatchObject({
      executionId: approval.executionId,
      toolCallId: approval.toolCallId,
    });
    await recorder.decideApproval({ ...pending, decision: "rejected" });
    await recordToolCall(fixture, { ...approval, executionId: "execution-2" });
    await expectCode(
      recorder.openApproval({
        ...approval,
        expectedVersion: 2,
        interactionId: "latest-again",
      }),
      "AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH",
    );
  });

  it("rejects approval when the latest tool name or input digest differs", async () => {
    const { recorder, approval, pending } = await approvalFixture();
    await recorder.openApproval(approval);
    await recorder.decideApproval({ ...pending, decision: "rejected" });
    const next = { ...approval, expectedVersion: 2 };
    await expectCode(
      recorder.openApproval({
        ...next,
        interactionId: "wrong-digest",
        argsDigest: "different",
      }),
      "AGENT_RUN_TOOL_CALL_MISMATCH",
    );
    await expectCode(
      recorder.openApproval({
        ...next,
        interactionId: "wrong-name",
        toolName: "different",
      }),
      "AGENT_RUN_TOOL_CALL_MISMATCH",
    );
  });

  it("allows ledger updates only with a valid composite key", async () => {
    const { recorder, runId, entry } = await approvalFixture();
    await expectCode(
      recorder.updateToolCall(
        runId,
        { executionId: "wrong", toolCallId: entry.toolCallId },
        {
          capabilityState: "issued",
        },
      ),
      "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
    );
    await expectCode(
      recorder.updateToolCall(
        runId,
        { executionId: "", toolCallId: entry.toolCallId },
        {
          capabilityState: "issued",
        },
      ),
      "AGENT_RUN_EXECUTION_ID_INVALID",
    );
  });

  it("enforces the Native audit execution ID limit", async () => {
    const { recorder, runId, entry } = await approvalFixture(false);
    for (let index = 0; index < 512; index += 1) {
      await recorder.appendToolCalls(runId, [
        {
          ...entry,
          executionId: `execution-${index}`,
          toolCallId: `call-${index}`,
        },
      ]);
    }
    await expectCode(
      recorder.appendToolCalls(runId, [entry]),
      "AGENT_RUN_AUDIT_EXECUTION_IDS_LIMIT",
    );
  });

  it("never reuses an interaction ID after its first use", async () => {
    const { recorder, approval, pending, startAnotherRun } =
      await approvalFixture();
    await recorder.openApproval(approval);
    await recorder.decideApproval({ ...pending, decision: "rejected" });
    const second = await startAnotherRun("second");
    const reused = {
      ...approval,
      runId: second.runId,
      executionId: "execution-2",
    };
    await recordToolCall({ recorder, turn: second.turn }, reused);
    // The global interaction_id primary key rejects this without an AGENT_RUN code.
    await expect(recorder.openApproval(reused)).rejects.toBeDefined();
  });

  it("reports missing and terminal runs using Native error codes", async () => {
    const { recorder, turn, runId, approval, entry } =
      await approvalFixture(false);
    await expectCode(
      recorder.openApproval({ ...approval, runId: "missing" }),
      "AGENT_RUN_NOT_FOUND",
    );
    expect(await recorder.finishWithoutMessages(turn, "user_stop")).toEqual({
      runId,
      version: 1,
      status: "cancelled",
    });
    await expectCode(
      recorder.openApproval({ ...approval, expectedVersion: 1 }),
      "AGENT_RUN_TERMINAL",
    );
    await expectCode(
      recorder.appendToolCalls(runId, [entry]),
      "AGENT_RUN_TERMINAL",
    );
  });
});
