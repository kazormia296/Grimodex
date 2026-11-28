import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAgentRunRecorder } from "./agentRunRecorder.js";
import type { AgentRunState } from "./agentRunRecorderPort.js";

vi.mock("electron", () => ({ dialog: {} }));

const turn = {
  senderId: 7,
  operationId: "turn",
  projectId: "project",
  chatSessionId: "chat",
  route: "legacy",
  userMessageId: "user",
  assistantMessageId: "assistant",
  providerId: "provider",
  modelId: "model",
  endpointHash: "endpoint-hash",
} as const;

const response = {
  ...turn,
  executionId: "execution",
  chatMessageId: "model-message",
  model: "model",
  toolUses: [
    { id: "write-1", name: "write", input: { title: "private body" } },
    { id: "read-1", name: "read", input: { z: [2, false], a: "first" } },
  ],
};

const resolveInput = {
  senderId: turn.senderId,
  projectId: turn.projectId,
  executionId: response.executionId,
};

const approval = {
  runId: "run-1",
  interactionId: "approval-1",
  executionId: response.executionId,
  toolCallId: "write-1",
  toolName: "write",
  argsDigest: "gate-digest",
  request: "private request",
  targetBasis: null,
};

type RunRow = AgentRunState & {
  projectId: string;
  chatSessionId: string;
  ownedByCaller: boolean;
  target?: string;
};

type Payload = {
  runId: string;
  version?: number;
  expectedVersion?: number;
  runVersion?: number;
  target?: string;
};

function defer() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(enabled = true) {
  const rows = new Map<string, RunRow>();
  function row(id: string) {
    const state = rows.get(id);
    if (!state) throw new Error("AGENT_RUN_NOT_FOUND");
    return state;
  }
  function add({ runId, projectId, chatSessionId }: RunRow) {
    const state: RunRow = {
      runId,
      projectId,
      chatSessionId,
      ownedByCaller: true,
      version: 0,
      status: "running",
    };
    rows.set(runId, state);
    return state;
  }
  function change(payload: Payload, status: AgentRunState["status"]) {
    const state = row(payload.runId);
    const version =
      payload.version ?? payload.expectedVersion ?? payload.runVersion;
    if (state.version !== version) {
      throw new Error("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
    }
    const next = { ...state, version: state.version + 1, status };
    rows.set(next.runId, next);
    return next;
  }
  function wire<T>(op: (payload: T) => unknown) {
    return vi.fn(async (payload: unknown) => JSON.stringify(op(payload as T)));
  }
  const writeVoid = () =>
    wire(({ runId }: Payload) => {
      row(runId);
      return null;
    });
  const backend = {
    agentRunStart: wire(add),
    agentRunStartSuperseding: wire(
      ({
        oldRunId,
        oldVersion,
        newRun,
      }: {
        oldRunId: string;
        oldVersion: number;
        newRun: RunRow;
      }) => ({
        discarded: change(
          { runId: oldRunId, version: oldVersion },
          "discarded",
        ),
        started: add(newRun),
      }),
    ),
    agentRunGetStatus: wire(({ runId }: Payload) => rows.get(runId) ?? null),
    agentRunAppendToolCalls: writeVoid(),
    agentRunAddAuditExecutionId: writeVoid(),
    agentRunMarkNotResumable: wire(({ runId }: Payload) => row(runId)),
    agentRunBeginFinalizing: wire((payload: Payload) => {
      const next = { ...change(payload, "finalizing"), target: payload.target };
      rows.set(next.runId, next);
      return next;
    }),
    agentRunFinishFinalizing: wire((payload: Payload) =>
      change(payload, "completed"),
    ),
    agentRunFinishWithoutMessages: wire((payload: Payload) =>
      change(payload, "cancelled"),
    ),
    agentRunInterrupt: wire((payload: Payload) =>
      change(payload, "interrupted"),
    ),
    agentRunRecoverFinalizing: wire((payload: Payload) => {
      const state = row(payload.runId);
      return state.target === "user_stop"
        ? { ...state, outcome: "needs_stop_message_replay" }
        : { ...change(payload, "interrupted"), outcome: "interrupted" };
    }),
    agentRunOpenApproval: wire((payload: Payload) => ({
      ...change(payload, "waiting_approval"),
      interactionVersion: 0,
    })),
    agentRunDecideApproval: wire((payload: Payload) =>
      change(payload, "running"),
    ),
    agentRunInvalidateApproval: wire((payload: Payload) =>
      change(payload, "running"),
    ),
    agentRunGetPendingApproval: wire(({ runId }: Payload) =>
      row(runId).status === "waiting_approval"
        ? {
            interactionId: approval.interactionId,
            interactionVersion: 2,
            executionId: approval.executionId,
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            argsDigest: approval.argsDigest,
            targetBasis: approval.targetBasis,
          }
        : null,
    ),
    agentRunUpdateToolCall: writeVoid(),
  };
  const toolInputDigest = vi.fn((name: string) =>
    name === "write" ? "gate-digest" : null,
  );
  let count = 0;
  const warn = vi.fn();
  const recorder = createAgentRunRecorder({
    backend,
    isEnabled: () => enabled,
    toolInputDigest,
    newRunId: () => `run-${++count}`,
    logger: { warn },
  });
  async function recordedRun() {
    await recorder.start(turn);
    expect(await recorder.recordResponse(response)).toBe("recorded");
    const result = recorder.resolveRun(resolveInput);
    if (result.kind !== "recorded") throw new Error("expected recorded Run");
    return result;
  }
  return {
    backend,
    recorder,
    recordedRun,
    rows,
    toolInputDigest,
    warn,
    disable: () => {
      enabled = false;
    },
  };
}

describe("AgentRun recorder", () => {
  it("makes no Native call with the flag closed, including through existing handles", async () => {
    const { backend, recorder, recordedRun, disable } = fixture();
    const { transact } = await recordedRun();
    Object.values(backend).forEach((method) => method.mockClear());
    disable();
    const interactionCas = {
      runId: "run-1",
      expectedVersion: 0,
      interactionId: "approval-1",
      interactionVersion: 0,
    };
    const refused = "AGENT_RUN_NOT_RECORDING";
    expect(await recorder.start(turn)).toEqual({ kind: "not_recording" });
    expect(await recorder.recordResponse(response)).toBe("not_recording");
    expect(recorder.resolveRun(resolveInput)).toEqual({
      kind: "not_recording",
    });
    await recorder.recordSubagentExecution(response);
    await recorder.beginFinalizing(turn, "completed", turn.assistantMessageId);
    await recorder.finishFinalizing(turn);
    await recorder.finishWithoutMessages(turn, "user_stop");
    await recorder.interrupt(turn, "renderer_lost");
    await recorder.interruptAll("app_shutdown");
    await recorder.interruptSender(turn.senderId, "renderer_lost");
    expect(await recorder.getPendingApproval("run-1")).toBeNull();
    await expect(
      recorder.openApproval({ ...approval, expectedVersion: 0 }),
    ).rejects.toThrow(refused);
    await expect(
      recorder.decideApproval({ ...interactionCas, decision: "approved" }),
    ).rejects.toThrow(refused);
    await expect(
      recorder.invalidateApproval({ ...interactionCas, outcome: "expired" }),
    ).rejects.toThrow(refused);
    await expect(
      recorder.interruptForApprovalTimeout(interactionCas),
    ).rejects.toThrow(refused);
    await expect(recorder.appendToolCalls("run-1", [])).rejects.toThrow(
      refused,
    );
    await expect(
      recorder.updateToolCall("run-1", approval, {}),
    ).rejects.toThrow(refused);
    const op = vi.fn();
    await expect(transact(op)).rejects.toThrow(refused);
    expect(op).not.toHaveBeenCalled();
    for (const method of Object.values(backend))
      expect(method).not.toHaveBeenCalled();
  });

  it("shares in-flight and completed starts by sender and operation", async () => {
    const { backend, recorder } = fixture();
    const entered = defer();
    const release = defer();
    const nativeStart = backend.agentRunStart.getMockImplementation()!;
    backend.agentRunStart.mockImplementationOnce(async (payload) => {
      entered.release();
      await release.promise;
      return nativeStart(payload);
    });
    const first = recorder.start(turn);
    await entered.promise;
    const second = recorder.start(turn);
    release.release();
    const recorded = { kind: "recorded", runId: "run-1" };
    expect(await Promise.all([first, second])).toEqual([recorded, recorded]);
    expect(await recorder.start(turn)).toEqual(recorded);
    expect(backend.agentRunStart).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      projectId: "project",
      chatSessionId: "chat",
      turnId: "turn",
      route: "legacy",
      originUserMessageId: "user",
      originAssistantMessageId: "assistant",
      modelProviderId: "provider",
      modelId: "model",
      endpointHash: "endpoint-hash",
    });
    expect(await recorder.start({ ...turn, senderId: 8 })).toEqual({
      kind: "recorded",
      runId: "run-2",
    });
  });

  it("uses the interrupted Run version for a superseding start and closes its old handle", async () => {
    const { backend, recorder, recordedRun } = fixture();
    const old = await recordedRun();
    await recorder.interrupt(turn, "renderer_lost");
    const next = {
      ...turn,
      operationId: "replacement",
      supersede: old.runId,
      route: "mastra",
    } as const;
    expect(await recorder.start(next)).toEqual({
      kind: "recorded",
      runId: "run-2",
    });
    expect(backend.agentRunStartSuperseding).toHaveBeenCalledExactlyOnceWith({
      oldRunId: "run-1",
      oldVersion: 1,
      newRun: expect.objectContaining({
        runId: "run-2",
        turnId: "replacement",
        route: "mastra",
      }),
    });
    expect(recorder.resolveRun(resolveInput)).toEqual({ kind: "unrecorded" });
    await expect(old.transact(vi.fn())).rejects.toThrow("AGENT_RUN_TERMINAL");
  });

  it("records both digests and binds only successful ledger executions to the sender and project", async () => {
    const { backend, recorder, recordedRun, toolInputDigest } = fixture();
    expect(recorder.resolveRun(resolveInput)).toEqual({ kind: "unrecorded" });
    expect(await recorder.recordResponse(response)).toBe("failed");
    const { runId } = await recordedRun();
    expect(runId).toBe("run-1");
    const digest = createHash("sha256")
      .update('{"a":"first","z":[2,false]}')
      .digest("hex");
    expect(backend.agentRunAppendToolCalls).toHaveBeenCalledExactlyOnceWith({
      runId,
      entries: response.toolUses.map(({ id, name, input }) => ({
        toolCallId: id,
        name,
        canonicalArgs: input,
        argsDigest: name === "write" ? "gate-digest" : digest,
        executionId: response.executionId,
        chatMessageId: response.chatMessageId,
        model: "model",
        capabilityState: "not_issued",
        executionState: "pending",
        mainOwnedProvenanceId: "",
      })),
    });
    expect(toolInputDigest.mock.calls.map(([name]) => name)).toEqual([
      "write",
      "read",
    ]);
    expect(
      await recorder.recordResponse({ ...response, projectId: "other" }),
    ).toBe("failed");
    expect(
      recorder.resolveRun({ ...resolveInput, projectId: "other" }),
    ).toEqual({ kind: "unrecorded" });
    expect(recorder.resolveRun({ ...resolveInput, senderId: 9 })).toEqual({
      kind: "unrecorded",
    });
    expect(
      await recorder.recordResponse({
        ...response,
        executionId: "empty",
        toolUses: [],
      }),
    ).toBe("recorded");
    await recorder.recordSubagentExecution({
      ...response,
      executionId: "child",
    });
    expect(backend.agentRunAddAuditExecutionId.mock.calls).toEqual([
      [{ runId, executionId: "empty" }],
      [{ runId, executionId: "child" }],
    ]);
    for (const executionId of ["empty", "child"]) {
      expect(recorder.resolveRun({ ...resolveInput, executionId })).toEqual({
        kind: "unrecorded",
      });
    }
    expect(backend.agentRunAppendToolCalls).toHaveBeenCalledTimes(1);
  });

  it("refreshes status after ledger failure, reports fallback failure and logs only IDs and markers", async () => {
    const { backend, recorder, rows, warn } = fixture();
    await recorder.start(turn);
    const error = new Error(
      "private body AGENT_RUN_DUPLICATE_TOOL_CALL_ID private request",
    );
    backend.agentRunAppendToolCalls.mockImplementationOnce(async () => {
      rows.set("run-1", {
        ...rows.get("run-1")!,
        version: 1,
        status: "waiting_user",
      });
      throw error;
    });
    expect(await recorder.recordResponse(response)).toBe(
      "marked_not_resumable",
    );
    expect(backend.agentRunGetStatus).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
    });
    expect(backend.agentRunMarkNotResumable).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      expectedStatus: "waiting_user",
      reason: "ledger_write_failed",
    });
    backend.agentRunAppendToolCalls.mockRejectedValueOnce(error);
    backend.agentRunMarkNotResumable.mockRejectedValueOnce(
      new Error("private payload without marker"),
    );
    expect(await recorder.recordResponse(response)).toBe("failed");
    expect(recorder.resolveRun(resolveInput)).toEqual({ kind: "unrecorded" });
    expect(warn.mock.calls).toEqual([
      ["run-1 AGENT_RUN_DUPLICATE_TOOL_CALL_ID"],
      ["run-1 AGENT_RUN_DUPLICATE_TOOL_CALL_ID"],
      ["run-1 AGENT_RUN_RECORDER_FAILED"],
    ]);
  });

  it("refuses to resolve an execution ID recorded by two Runs", async () => {
    const { recorder, recordedRun } = fixture();
    await recordedRun();
    const other = { ...turn, operationId: "other", chatSessionId: "other" };
    await recorder.start(other);
    expect(await recorder.recordResponse({ ...response, ...other })).toBe(
      "marked_not_resumable",
    );
    expect(recorder.resolveRun(resolveInput)).toEqual({ kind: "unrecorded" });
  });

  it("serializes transactions, refreshes a failed version and allows port calls inside a transaction", async () => {
    const { backend, recorder, recordedRun } = fixture();
    const { runId, transact } = await recordedRun();
    const opened = defer();
    const release = defer();
    const nativeOpen = backend.agentRunOpenApproval.getMockImplementation()!;
    backend.agentRunOpenApproval.mockImplementationOnce(async (payload) => {
      opened.release();
      await release.promise;
      return nativeOpen(payload);
    });
    const first = transact((expectedVersion) =>
      recorder.openApproval({ ...approval, expectedVersion }),
    );
    await opened.promise;
    const decide = vi.fn((expectedVersion: number) =>
      recorder.decideApproval({
        runId,
        expectedVersion,
        interactionId: approval.interactionId,
        interactionVersion: 0,
        decision: "approved",
      }),
    );
    const second = transact(decide);
    expect(decide).not.toHaveBeenCalled();
    release.release();
    expect(await first).toMatchObject({
      version: 1,
      status: "waiting_approval",
      interactionVersion: 0,
    });
    expect(await second).toMatchObject({ version: 2, status: "running" });
    expect(decide).toHaveBeenCalledExactlyOnceWith(1);

    const failing = vi.fn(async () => {
      throw new Error("failed transaction");
    });
    await expect(transact(failing)).rejects.toThrow("failed transaction");
    expect(failing).toHaveBeenCalledExactlyOnceWith(2);
    expect(backend.agentRunGetStatus).not.toHaveBeenCalled();
    expect(
      await transact((expectedVersion) =>
        recorder.openApproval({ ...approval, expectedVersion }),
      ),
    ).toMatchObject({ version: 3 });
    expect(backend.agentRunGetStatus).toHaveBeenCalledExactlyOnceWith({
      runId,
    });
    expect(await recorder.getPendingApproval(runId)).toEqual({
      interactionId: approval.interactionId,
      executionId: approval.executionId,
      version: 2,
      targetBasis: null,
      toolCallId: "write-1",
      toolName: "write",
      argsDigest: "gate-digest",
    });

    const interaction = {
      runId,
      interactionId: approval.interactionId,
      interactionVersion: 2,
    };
    await transact((expectedVersion) =>
      recorder.invalidateApproval({
        ...interaction,
        expectedVersion,
        outcome: "expired",
      }),
    );
    expect(backend.agentRunInvalidateApproval).toHaveBeenCalledExactlyOnceWith({
      ...interaction,
      runVersion: 3,
      invalidation: "expired",
    });
    await transact((expectedVersion) =>
      recorder.openApproval({ ...approval, expectedVersion }),
    );
    expect(
      await transact((expectedVersion) =>
        recorder.interruptForApprovalTimeout({ runId, expectedVersion }),
      ),
    ).toMatchObject({
      version: 6,
      status: "interrupted",
    });
    expect(backend.agentRunInterrupt).toHaveBeenCalledExactlyOnceWith({
      runId,
      version: 5,
      expectedStatus: "waiting_approval",
      reason: "approval_timeout",
    });
  });

  it("interrupts by sender and across Runs, preserving a pending Stop and isolating failures", async () => {
    const { backend, recorder, rows } = fixture();
    const otherTurn = (
      operationId: string,
      senderId: number = turn.senderId,
    ) => ({
      ...turn,
      operationId,
      chatSessionId: operationId,
      senderId,
    });
    const saving = otherTurn("saving");
    const stop = otherTurn("stop");
    const other = otherTurn("elsewhere", 9);
    const finished = otherTurn("finished");
    for (const input of [turn, saving, stop, other, finished])
      await recorder.start(input);
    await recorder.beginFinalizing(
      saving,
      "completed",
      saving.assistantMessageId,
    );
    await recorder.beginFinalizing(stop, "user_stop", stop.assistantMessageId);
    await recorder.finishWithoutMessages(finished, "user_stop");
    backend.agentRunInterrupt.mockRejectedValueOnce(
      new Error("AGENT_RUN_OWNER_MISMATCH"),
    );

    await recorder.interruptSender(turn.senderId, "renderer_lost");
    expect(rows.get("run-1")?.status).toBe("running");
    expect(rows.get("run-2")?.status).toBe("interrupted");
    expect(rows.get("run-3")?.status).toBe("finalizing");
    expect(rows.get("run-4")?.status).toBe("running");
    expect(backend.agentRunRecoverFinalizing.mock.calls).toEqual(
      ["run-2", "run-3"].map((runId) => [
        {
          runId,
          version: 1,
          reason: "renderer_lost",
          userMessageComplete: false,
          assistantMessageComplete: false,
        },
      ]),
    );
    await recorder.interruptAll("workspace_switched");
    expect([...rows.values()].map(({ status }) => status)).toEqual([
      "interrupted",
      "interrupted",
      "finalizing",
      "interrupted",
      "cancelled",
    ]);
    expect(backend.agentRunInterrupt).toHaveBeenCalledTimes(3);
    expect(backend.agentRunRecoverFinalizing).toHaveBeenLastCalledWith({
      runId: "run-3",
      version: 1,
      reason: "workspace_switched",
      userMessageComplete: false,
      assistantMessageComplete: false,
    });
  });

  it("rejects pending and later transactions using a handle from the old workspace", async () => {
    const { backend, recorder, recordedRun } = fixture();
    const { runId, transact } = await recordedRun();
    const entered = defer();
    const release = defer();
    const active = transact(async (version) => {
      entered.release();
      await release.promise;
      return { runId, version, status: "running" };
    });
    await entered.promise;
    const op = vi.fn();
    const queued = transact(op);
    recorder.forgetAll();
    expect(recorder.resolveRun(resolveInput)).toEqual({ kind: "unrecorded" });
    await expect(recorder.updateToolCall(runId, approval, {})).rejects.toThrow(
      "AGENT_RUN_NOT_FOUND",
    );
    await expect(transact(op)).rejects.toThrow("AGENT_RUN_WORKSPACE_CHANGED");
    release.release();
    await expect(active).rejects.toThrow("AGENT_RUN_WORKSPACE_CHANGED");
    await expect(queued).rejects.toThrow("AGENT_RUN_WORKSPACE_CHANGED");
    expect(await recorder.start(turn)).toEqual({
      kind: "recorded",
      runId: "run-2",
    });
    await expect(transact(op)).rejects.toThrow("AGENT_RUN_WORKSPACE_CHANGED");
    expect(op).not.toHaveBeenCalled();
    expect(backend.agentRunUpdateToolCall).not.toHaveBeenCalled();
  });
});
