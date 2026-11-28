import {
  parseAgentRunErrorCode,
  type AgentRunInterruptReason,
  type AgentRunStatus,
  type AgentRunTerminalReason,
} from "../shared/agentRunTypes.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type {
  AgentRunApprovalPort,
  AgentRunLedgerEntry,
  AgentRunResolution,
  AgentRunResolver,
  AgentRunState,
  PendingApproval,
} from "./agentRunRecorderPort.js";
import { canonicalJson, sha256Hex } from "./mainGrant.js";

type Backend = Required<
  Pick<
    NapiBackendLike,
    | "agentRunStart"
    | "agentRunStartSuperseding"
    | "agentRunGetStatus"
    | "agentRunAppendToolCalls"
    | "agentRunAddAuditExecutionId"
    | "agentRunMarkNotResumable"
    | "agentRunBeginFinalizing"
    | "agentRunFinishFinalizing"
    | "agentRunFinishWithoutMessages"
    | "agentRunInterrupt"
    | "agentRunRecoverFinalizing"
    | "agentRunOpenApproval"
    | "agentRunDecideApproval"
    | "agentRunInvalidateApproval"
    | "agentRunGetPendingApproval"
    | "agentRunUpdateToolCall"
  >
>;

interface RunKey {
  senderId: number;
  operationId: string;
}

interface RunBinding extends RunKey {
  projectId: string;
  chatSessionId: string;
}

interface StartInput extends RunBinding {
  route: "legacy" | "mastra";
  userMessageId: string;
  assistantMessageId: string;
  providerId: string;
  modelId: string;
  endpointHash: string;
  supersede?: string;
}

interface ExecutionInput extends RunKey {
  projectId: string;
  executionId: string;
}

interface ResponseInput extends ExecutionInput {
  chatMessageId: string;
  model: string;
  toolUses: readonly { id: string; name: string; input: unknown }[];
}

type StartResult =
  | { kind: "recorded"; runId: string }
  | { kind: "not_recording" }
  | { kind: "unrecorded" };
type ResponseResult =
  | "recorded"
  | "marked_not_resumable"
  | "failed"
  | "not_recording";
type InterruptReason = Exclude<AgentRunInterruptReason, "copied_snapshot">;
type StatusRead = AgentRunState & {
  projectId: string;
  chatSessionId: string;
  ownedByCaller: boolean;
};
type Recovery = Pick<AgentRunState, "runId" | "version"> &
  (
    | { outcome: "interrupted" | "needs_stop_message_replay" | "skipped" }
    | { outcome: "finalized"; status: AgentRunStatus }
  );

interface TrackedRun {
  binding: RunBinding;
  state: AgentRunState;
  dirty: boolean;
  tail: Promise<void>;
}

interface Operation {
  binding: RunBinding;
  ready: Promise<TrackedRun | undefined>;
}

function createWorkspace() {
  return {
    operations: new Map<string, Operation>(),
    runs: new Map<string, TrackedRun>(),
    executions: new Map<string, TrackedRun | null>(),
  };
}

type Workspace = ReturnType<typeof createWorkspace>;

interface AgentRunRecorder extends AgentRunApprovalPort, AgentRunResolver {
  start(input: StartInput): Promise<StartResult>;
  recordResponse(input: ResponseInput): Promise<ResponseResult>;
  recordSubagentExecution(input: ExecutionInput): Promise<void>;
  beginFinalizing(
    key: RunKey,
    target: AgentRunTerminalReason,
    assistantMessageId: string,
  ): Promise<AgentRunState | undefined>;
  finishFinalizing(key: RunKey): Promise<AgentRunState | undefined>;
  finishWithoutMessages(
    key: RunKey,
    target: AgentRunTerminalReason,
  ): Promise<AgentRunState | undefined>;
  interrupt(
    key: RunKey,
    reason: InterruptReason,
  ): Promise<AgentRunState | undefined>;
  interruptAll(reason: InterruptReason): Promise<void>;
  interruptSender(senderId: number, reason: InterruptReason): Promise<void>;
  forgetAll(): void;
}

interface RecorderDeps {
  backend: Backend;
  isEnabled(): boolean;
  toolInputDigest(toolName: string, input: unknown): string | null;
  newRunId(): string;
  logger?: { warn(message: string): void };
}

const terminalStatuses = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "discarded",
]);

function operationKey({ senderId, operationId }: RunKey): string {
  return JSON.stringify([senderId, operationId]);
}

export function createAgentRunRecorder({
  backend,
  isEnabled,
  toolInputDigest,
  newRunId,
  logger,
}: RecorderDeps): AgentRunRecorder {
  let workspace = createWorkspace();

  function assertAvailable(scope: Workspace) {
    if (scope !== workspace) throw new Error("AGENT_RUN_WORKSPACE_CHANGED");
    if (!isEnabled()) throw new Error("AGENT_RUN_NOT_RECORDING");
  }

  async function native<T>(
    scope: Workspace,
    method: keyof Backend,
    payload: unknown,
    id: string,
  ): Promise<T> {
    assertAvailable(scope);
    let result: T;
    try {
      result = JSON.parse(await backend[method](payload)) as T;
    } catch (error) {
      const code = parseAgentRunErrorCode(error) ?? "AGENT_RUN_RECORDER_FAILED";
      logger?.warn(`${id} ${code}`);
      // eslint-disable-next-line preserve-caught-error -- The Native error can contain payload data.
      throw new Error(code);
    }
    if (scope !== workspace) throw new Error("AGENT_RUN_WORKSPACE_CHANGED");
    return result;
  }

  function readStatus(scope: Workspace, runId: string) {
    return native<StatusRead | null>(
      scope,
      "agentRunGetStatus",
      { runId },
      runId,
    );
  }

  function save<T extends AgentRunState>(run: TrackedRun, state: T): T {
    if (state.runId !== run.state.runId) {
      throw new Error("AGENT_RUN_NOT_FOUND");
    }
    const { runId, version, status } = state;
    run.state = { runId, version, status };
    return state;
  }

  async function prepare(scope: Workspace, run: TrackedRun) {
    assertAvailable(scope);
    if (run.dirty) {
      const state = await readStatus(scope, run.state.runId);
      if (!state) throw new Error("AGENT_RUN_NOT_FOUND");
      if (
        !state.ownedByCaller ||
        state.projectId !== run.binding.projectId ||
        state.chatSessionId !== run.binding.chatSessionId
      ) {
        throw new Error("AGENT_RUN_OWNER_MISMATCH");
      }
      save(run, state);
      run.dirty = false;
    }
    if (terminalStatuses.has(run.state.status)) {
      throw new Error("AGENT_RUN_TERMINAL");
    }
  }

  async function mutate<T>(run: TrackedRun, op: () => Promise<T>): Promise<T> {
    const before = run.state;
    try {
      return await op();
    } catch (error) {
      run.state = before;
      run.dirty = true;
      throw error;
    }
  }

  function enqueue<T>(
    scope: Workspace,
    run: TrackedRun,
    op: () => Promise<T>,
  ): Promise<T> {
    const result = run.tail.then(async () => {
      await prepare(scope, run);
      assertAvailable(scope);
      return op();
    });
    run.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function byOperation<T>(
    scope: Workspace,
    key: RunKey & { projectId?: string },
    op: (run: TrackedRun) => Promise<T>,
  ): Promise<T> {
    const operation = scope.operations.get(operationKey(key));
    if (
      !operation ||
      (key.projectId !== undefined &&
        operation.binding.projectId !== key.projectId)
    ) {
      throw new Error("AGENT_RUN_NOT_FOUND");
    }
    const run = await operation.ready;
    if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
    return enqueue(scope, run, () => op(run));
  }

  function writeState<T extends AgentRunState = AgentRunState>(
    scope: Workspace,
    run: TrackedRun,
    method: keyof Backend,
    payload: unknown,
  ): Promise<T> {
    return mutate(run, async () =>
      save(run, await native<T>(scope, method, payload, run.state.runId)),
    );
  }

  // Gate A already holds the queue when calling a port mutation in transact.
  async function fromPort<T>(
    runId: string,
    op: (scope: Workspace, run: TrackedRun) => Promise<T>,
  ): Promise<T> {
    const scope = workspace;
    assertAvailable(scope);
    const run = scope.runs.get(runId);
    if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
    await prepare(scope, run);
    return op(scope, run);
  }

  async function startRun(
    scope: Workspace,
    input: StartInput,
    binding: RunBinding,
  ): Promise<TrackedRun> {
    assertAvailable(scope);
    const runId = newRunId();
    const payload = {
      runId,
      projectId: binding.projectId,
      chatSessionId: binding.chatSessionId,
      turnId: binding.operationId,
      route: input.route,
      originUserMessageId: input.userMessageId,
      originAssistantMessageId: input.assistantMessageId,
      modelProviderId: input.providerId,
      modelId: input.modelId,
      endpointHash: input.endpointHash,
    };
    const oldRunId = input.supersede;
    let state: AgentRunState;
    if (oldRunId === undefined) {
      state = await native<AgentRunState>(
        scope,
        "agentRunStart",
        payload,
        runId,
      );
    } else {
      const old = scope.runs.get(oldRunId);
      async function supersede(oldRunId: string) {
        const previous = old
          ? { ...old.binding, ...old.state }
          : await readStatus(scope, oldRunId);
        if (
          previous?.status !== "interrupted" ||
          previous.projectId !== binding.projectId ||
          previous.chatSessionId !== binding.chatSessionId
        ) {
          throw new Error("AGENT_RUN_SESSION_MISMATCH");
        }
        const { started, discarded } = await native<{
          started: AgentRunState;
          discarded: AgentRunState;
        }>(
          scope,
          "agentRunStartSuperseding",
          { oldRunId, oldVersion: previous.version, newRun: payload },
          runId,
        );
        if (old) save(old, discarded);
        return started;
      }
      state = old
        ? await enqueue(scope, old, () =>
            mutate(old, () => supersede(oldRunId)),
          )
        : await supersede(oldRunId);
    }
    const run = { binding, state, dirty: false, tail: Promise.resolve() };
    scope.runs.set(runId, run);
    return run;
  }

  function append(
    scope: Workspace,
    run: TrackedRun,
    entries: readonly AgentRunLedgerEntry[],
  ): Promise<void> {
    return mutate(run, async () => {
      const executionId = entries[0]?.executionId;
      const { runId } = run.state;
      await native(scope, "agentRunAppendToolCalls", { runId, entries }, runId);
      if (executionId === undefined) return;
      const existing = scope.executions.get(executionId);
      if (existing !== undefined && existing !== run) {
        // An ambiguous execution ID must never resolve to either Run.
        scope.executions.set(executionId, null);
        throw new Error("AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH");
      }
      scope.executions.set(executionId, run);
    });
  }

  function addAudit(scope: Workspace, run: TrackedRun, executionId: string) {
    const { runId } = run.state;
    return mutate(run, async () => {
      await native(
        scope,
        "agentRunAddAuditExecutionId",
        { runId, executionId },
        runId,
      );
    });
  }

  async function lifecycle(
    key: RunKey,
    op: (scope: Workspace, run: TrackedRun) => Promise<AgentRunState>,
  ) {
    if (!isEnabled()) return;
    const scope = workspace;
    return byOperation(scope, key, (run) => op(scope, run));
  }

  async function interruptRun(
    scope: Workspace,
    run: TrackedRun,
    reason: InterruptReason,
  ) {
    const { runId, version, status } = run.state;
    if (status === "interrupted") return run.state;
    if (status !== "finalizing") {
      return writeState(scope, run, "agentRunInterrupt", {
        runId,
        version,
        expectedStatus: status,
        reason,
      });
    }
    return mutate(run, async () => {
      const result = await native<Recovery>(
        scope,
        "agentRunRecoverFinalizing",
        {
          runId,
          version,
          reason,
          userMessageComplete: false,
          assistantMessageComplete: false,
        },
        runId,
      );
      switch (result.outcome) {
        case "interrupted":
          return save(run, {
            runId: result.runId,
            version: result.version,
            status: "interrupted",
          });
        case "needs_stop_message_replay":
          return run.state;
        case "finalized":
          return save(run, result);
        case "skipped":
          throw new Error("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
      }
    });
  }

  async function interruptKnown(reason: InterruptReason, senderId?: number) {
    if (!isEnabled()) return;
    const scope = workspace;
    await Promise.allSettled(
      [...scope.operations.values()]
        .filter(
          ({ binding }) =>
            senderId === undefined || binding.senderId === senderId,
        )
        .map(async ({ ready }) => {
          const run = await ready;
          if (run && !terminalStatuses.has(run.state.status)) {
            await enqueue(scope, run, () => interruptRun(scope, run, reason));
          }
        }),
    );
  }

  return {
    async start(input) {
      if (!isEnabled()) return { kind: "not_recording" };
      const scope = workspace;
      const { senderId, operationId, projectId, chatSessionId } = input;
      const key = operationKey(input);
      let operation = scope.operations.get(key);
      if (!operation) {
        const binding = { senderId, operationId, projectId, chatSessionId };
        const ready = Promise.resolve()
          .then(() => startRun(scope, input, binding))
          .catch(() => undefined);
        operation = { binding, ready };
        scope.operations.set(key, operation);
      }
      if (
        operation.binding.projectId !== projectId ||
        operation.binding.chatSessionId !== chatSessionId
      ) {
        return { kind: "unrecorded" };
      }
      const run = await operation.ready;
      return run && scope === workspace
        ? { kind: "recorded", runId: run.state.runId }
        : { kind: "unrecorded" };
    },

    async recordResponse(input) {
      if (!isEnabled()) return "not_recording";
      const scope = workspace;
      const { executionId, chatMessageId, model, toolUses } = input;
      try {
        return await byOperation(scope, input, async (run) => {
          if (toolUses.length === 0) {
            await addAudit(scope, run, executionId);
            return "recorded";
          }
          try {
            const entries = toolUses.map(
              ({ id, name, input }): AgentRunLedgerEntry => ({
                toolCallId: id,
                name,
                canonicalArgs: input,
                argsDigest:
                  toolInputDigest(name, input) ??
                  sha256Hex(canonicalJson(input)),
                executionId,
                chatMessageId,
                mainOwnedProvenanceId: "",
                model,
                capabilityState: "not_issued",
                executionState: "pending",
              }),
            );
            await append(scope, run, entries);
            return "recorded";
          } catch {
            await prepare(scope, run);
            await writeState(scope, run, "agentRunMarkNotResumable", {
              runId: run.state.runId,
              expectedStatus: run.state.status,
              reason: "ledger_write_failed",
            });
            return "marked_not_resumable";
          }
        });
      } catch {
        return "failed";
      }
    },

    async recordSubagentExecution(input) {
      if (!isEnabled()) return;
      const scope = workspace;
      await byOperation(scope, input, (run) =>
        addAudit(scope, run, input.executionId),
      );
    },

    beginFinalizing(key, target, assistantMessageId) {
      return lifecycle(key, async (scope, run) => {
        const { runId, version, status } = run.state;
        if (status === "interrupted" || status === "finalizing") {
          throw new Error("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
        }
        return writeState(scope, run, "agentRunBeginFinalizing", {
          runId,
          version,
          expectedStatus: status,
          target,
          assistantMessageId,
        });
      });
    },

    finishFinalizing(key) {
      return lifecycle(key, (scope, run) =>
        mutate(run, async () => {
          const { runId, version } = run.state;
          const state = await native<AgentRunState | Recovery>(
            scope,
            "agentRunFinishFinalizing",
            { runId, version },
            runId,
          );
          if ("outcome" in state) {
            throw new Error("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
          }
          return save(run, state);
        }),
      );
    },

    finishWithoutMessages(key, target) {
      return lifecycle(key, (scope, run) =>
        writeState(scope, run, "agentRunFinishWithoutMessages", {
          runId: run.state.runId,
          expectedVersion: run.state.version,
          target,
        }),
      );
    },

    interrupt(key, reason) {
      return lifecycle(key, (scope, run) => interruptRun(scope, run, reason));
    },

    interruptAll(reason) {
      return interruptKnown(reason);
    },

    interruptSender(senderId, reason) {
      return interruptKnown(reason, senderId);
    },

    forgetAll() {
      workspace.operations.clear();
      workspace.runs.clear();
      workspace.executions.clear();
      workspace = createWorkspace();
    },

    openApproval(input) {
      return fromPort(input.runId, (scope, run) =>
        writeState<AgentRunState & { interactionVersion: number }>(
          scope,
          run,
          "agentRunOpenApproval",
          input,
        ),
      );
    },

    decideApproval({ expectedVersion, ...input }) {
      return fromPort(input.runId, (scope, run) =>
        writeState(scope, run, "agentRunDecideApproval", {
          ...input,
          runVersion: expectedVersion,
        }),
      );
    },

    invalidateApproval({ expectedVersion, outcome, ...input }) {
      return fromPort(input.runId, (scope, run) =>
        writeState(scope, run, "agentRunInvalidateApproval", {
          ...input,
          runVersion: expectedVersion,
          invalidation: outcome,
        }),
      );
    },

    interruptForApprovalTimeout({ runId, expectedVersion }) {
      return fromPort(runId, (scope, run) =>
        writeState(scope, run, "agentRunInterrupt", {
          runId,
          version: expectedVersion,
          expectedStatus: "waiting_approval",
          reason: "approval_timeout",
        }),
      );
    },

    async getPendingApproval(runId) {
      if (!isEnabled()) return null;
      const pending = await native<
        | (Omit<PendingApproval, "version"> & { interactionVersion: number })
        | null
      >(workspace, "agentRunGetPendingApproval", { runId }, runId);
      if (!pending) return null;
      const { interactionVersion, ...rest } = pending;
      return { ...rest, version: interactionVersion };
    },

    appendToolCalls(runId, entries) {
      return fromPort(runId, (scope, run) => append(scope, run, entries));
    },

    updateToolCall(
      runId,
      { executionId, toolCallId },
      { mainOwnedProvenanceId, capabilityState, executionState },
    ) {
      return fromPort(runId, (scope, run) =>
        mutate(run, async () => {
          await native(
            scope,
            "agentRunUpdateToolCall",
            {
              runId,
              executionId,
              toolCallId,
              mainOwnedProvenanceId,
              capabilityState,
              executionState,
            },
            runId,
          );
        }),
      );
    },

    resolveRun({ senderId, projectId, executionId }): AgentRunResolution {
      if (!isEnabled()) return { kind: "not_recording" };
      const scope = workspace;
      const run = scope.executions.get(executionId);
      if (
        !run ||
        run.binding.senderId !== senderId ||
        run.binding.projectId !== projectId ||
        terminalStatuses.has(run.state.status)
      ) {
        return { kind: "unrecorded" };
      }
      return {
        kind: "recorded",
        runId: run.state.runId,
        async transact(op) {
          assertAvailable(scope);
          return enqueue(scope, run, () =>
            mutate(run, async () => {
              const state = await op(run.state.version);
              if (scope !== workspace)
                throw new Error("AGENT_RUN_WORKSPACE_CHANGED");
              return save(run, state);
            }),
          );
        },
      };
    },
  };
}
