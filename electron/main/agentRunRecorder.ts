import { AsyncLocalStorage } from "node:async_hooks";
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
type TurnPersistenceKey = Pick<
  StartInput,
  "projectId" | "chatSessionId" | "userMessageId" | "assistantMessageId"
>;
interface TurnPersistence {
  userMessageComplete: boolean;
  assistantMessageComplete: boolean;
}
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
  persistenceKey: TurnPersistenceKey;
  state: AgentRunState;
  dirty: boolean;
}

interface Operation {
  binding: RunBinding;
  ready: Promise<TrackedRun | undefined>;
  run?: TrackedRun;
}

interface ExecutionBinding {
  run: TrackedRun;
  recorded: boolean;
}

class ExecutionCollisionError extends Error {
  constructor() {
    super("AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH");
  }
}

function createWorkspace() {
  return {
    operations: new Map<string, Operation>(),
    runs: new Map<string, TrackedRun>(),
    executions: new Map<string, ExecutionBinding | null>(),
    tails: new Map<string, Promise<void>>(),
    pending: new Set<Promise<unknown>>(),
    quiescing: false,
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
  interruptAll(reason: InterruptReason): Promise<string[]>;
  interruptSender(senderId: number, reason: InterruptReason): Promise<string[]>;
  quiesce(): Promise<void>;
  forgetAll(): void;
}

interface RecorderDeps {
  backend: Backend;
  isEnabled(): boolean;
  toolInputDigest(toolName: string, input: unknown): string | null;
  newRunId(): string;
  readTurnPersistence?(key: TurnPersistenceKey): Promise<TurnPersistence>;
  logger?: { warn(message: string): void };
}

const terminalStatuses = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "discarded",
]);

const activeStatuses = new Set<AgentRunStatus>([
  "running",
  "waiting_user",
  "waiting_approval",
]);

function operationKey({ senderId, operationId }: RunKey): string {
  return JSON.stringify([senderId, operationId]);
}

export function createAgentRunRecorder({
  backend,
  isEnabled,
  toolInputDigest,
  newRunId,
  readTurnPersistence,
  logger,
}: RecorderDeps): AgentRunRecorder {
  let workspace = createWorkspace();
  const transactions = new AsyncLocalStorage<{
    run: TrackedRun;
    active: boolean;
  }>();

  function assertAvailable(scope: Workspace) {
    if (scope !== workspace) throw new Error("AGENT_RUN_WORKSPACE_CHANGED");
    if (!isEnabled()) throw new Error("AGENT_RUN_NOT_RECORDING");
  }

  function assertAdmission(scope: Workspace) {
    if (scope.quiescing && scope === workspace) {
      throw new Error("AGENT_RUN_QUIESCING");
    }
    assertAvailable(scope);
  }

  function track<T>(scope: Workspace, promise: Promise<T>): Promise<T> {
    scope.pending.add(promise);
    const settled = () => scope.pending.delete(promise);
    void promise.then(settled, settled);
    return promise;
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
      const logId = /^[A-Za-z0-9_-]{1,64}$/u.test(id) ? id : "invalid_id";
      logger?.warn(`${logId} ${code}`);
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
    target: TrackedRun | string,
    op: () => Promise<T>,
  ): Promise<T> {
    const runId = typeof target === "string" ? target : target.state.runId;
    const result = (scope.tails.get(runId) ?? Promise.resolve()).then(
      async () => {
        if (typeof target !== "string") await prepare(scope, target);
        assertAvailable(scope);
        return op();
      },
    );
    const tail = track(
      scope,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    scope.tails.set(runId, tail);
    void tail.then(() => {
      if (scope.tails.get(runId) === tail) scope.tails.delete(runId);
    });
    return result;
  }

  async function byOperation<T>(
    scope: Workspace,
    key: RunKey & { projectId?: string },
    op: (run: TrackedRun) => Promise<T>,
    prepareRun = true,
  ): Promise<T> {
    const operation = scope.operations.get(operationKey(key));
    if (
      !operation ||
      (key.projectId !== undefined &&
        operation.binding.projectId !== key.projectId)
    ) {
      throw new Error("AGENT_RUN_NOT_FOUND");
    }
    const schedule = (run: TrackedRun | undefined) => {
      if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
      return enqueue(scope, prepareRun ? run : run.state.runId, () => op(run));
    };
    return operation.run
      ? schedule(operation.run)
      : track(scope, operation.ready.then(schedule));
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

  function portRun(scope: Workspace, runId: string) {
    const run = scope.runs.get(runId);
    const inTransaction = transactions.getStore();
    if (inTransaction?.active && inTransaction.run !== run) {
      throw new Error("AGENT_RUN_NOT_FOUND");
    }
    return { run, inTransaction: inTransaction?.active === true };
  }

  async function fromPort<T>(
    runId: string,
    op: (scope: Workspace, run: TrackedRun) => Promise<T>,
    prepareRun = true,
  ): Promise<T> {
    const scope = workspace;
    assertAdmission(scope);
    const { run, inTransaction } = portRun(scope, runId);
    if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
    // Gate A already holds this Run's queue inside transact.
    return inTransaction
      ? track(scope, op(scope, run))
      : enqueue(scope, prepareRun ? run : runId, () => op(scope, run));
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
      state = await enqueue(scope, old ?? oldRunId, () =>
        old ? mutate(old, () => supersede(oldRunId)) : supersede(oldRunId),
      );
    }
    const run = {
      binding,
      persistenceKey: {
        projectId: binding.projectId,
        chatSessionId: binding.chatSessionId,
        userMessageId: payload.originUserMessageId,
        assistantMessageId: payload.originAssistantMessageId,
      },
      state,
      dirty: false,
    };
    scope.runs.set(runId, run);
    return run;
  }

  async function append(
    scope: Workspace,
    run: TrackedRun,
    entries: readonly AgentRunLedgerEntry[],
  ) {
    const executionId = entries[0]?.executionId;
    const existing =
      executionId === undefined ? undefined : scope.executions.get(executionId);
    const binding = existing ?? { run, recorded: false };
    if (executionId !== undefined) {
      if (existing === null || binding.run !== run) {
        scope.executions.set(executionId, null);
        throw new ExecutionCollisionError();
      }
      // Reserve before awaiting Native so another Run cannot append the same ID.
      scope.executions.set(executionId, binding);
    }
    try {
      await prepare(scope, run);
      if (
        executionId !== undefined &&
        scope.executions.get(executionId) === null
      ) {
        throw new ExecutionCollisionError();
      }
      const { runId } = run.state;
      await mutate(run, async () => {
        await native(
          scope,
          "agentRunAppendToolCalls",
          { runId, entries },
          runId,
        );
      });
      if (
        executionId !== undefined &&
        scope.executions.get(executionId) === null
      ) {
        throw new ExecutionCollisionError();
      }
      binding.recorded = true;
    } finally {
      if (
        executionId !== undefined &&
        !binding.recorded &&
        scope.executions.get(executionId) === binding
      ) {
        scope.executions.delete(executionId);
      }
    }
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
    const scope = workspace;
    if (!scope.quiescing && !isEnabled()) return;
    assertAdmission(scope);
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
      let evidence: TurnPersistence | undefined;
      try {
        evidence = await readTurnPersistence?.(run.persistenceKey);
      } catch {
        // A failed read provides no evidence that either message was saved.
      }
      const result = await native<Recovery>(
        scope,
        "agentRunRecoverFinalizing",
        {
          runId,
          version,
          reason,
          userMessageComplete: evidence?.userMessageComplete ?? false,
          assistantMessageComplete: evidence?.assistantMessageComplete ?? false,
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
    const scope = workspace;
    if (!scope.quiescing && !isEnabled()) return [];
    assertAdmission(scope);
    const results = await track(
      scope,
      Promise.all(
        [...scope.operations.values()]
          .filter(
            ({ binding }) =>
              senderId === undefined || binding.senderId === senderId,
          )
          .map(async (operation) => {
            const run = operation.run ?? (await operation.ready);
            if (!run || terminalStatuses.has(run.state.status)) return;
            try {
              const state = await enqueue(scope, run, () =>
                interruptRun(scope, run, reason),
              );
              if (state.status === "finalizing") return state.runId;
            } catch {
              if (!terminalStatuses.has(run.state.status))
                return run.state.runId;
            }
          }),
      ),
    );
    return results.filter((runId) => runId !== undefined);
  }

  return {
    async start(input) {
      const scope = workspace;
      if (scope.quiescing) return { kind: "unrecorded" };
      if (!isEnabled()) return { kind: "not_recording" };
      const { senderId, operationId, projectId, chatSessionId } = input;
      const key = operationKey(input);
      let operation = scope.operations.get(key);
      if (!operation) {
        const binding = { senderId, operationId, projectId, chatSessionId };
        const pending: Operation = {
          binding,
          ready: track(
            scope,
            Promise.resolve()
              .then(async () => {
                const run = await startRun(scope, input, binding);
                pending.run = run;
                return run;
              })
              .catch(() => undefined),
          ),
        };
        operation = pending;
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
      const scope = workspace;
      if (scope.quiescing) return "failed";
      if (!isEnabled()) return "not_recording";
      const { executionId, chatMessageId, model, toolUses } = input;
      try {
        return await byOperation(
          scope,
          input,
          async (run) => {
            if (toolUses.length === 0) {
              await prepare(scope, run);
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
            } catch (error) {
              if (error instanceof ExecutionCollisionError) throw error;
              await prepare(scope, run);
              await writeState(scope, run, "agentRunMarkNotResumable", {
                runId: run.state.runId,
                expectedStatus: run.state.status,
                reason: "ledger_write_failed",
              });
              return "marked_not_resumable";
            }
          },
          false,
        );
      } catch {
        return "failed";
      }
    },

    async recordSubagentExecution(input) {
      const scope = workspace;
      if (!scope.quiescing && !isEnabled()) return;
      assertAdmission(scope);
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

    async quiesce() {
      const scope = workspace;
      scope.quiescing = true;
      while (scope.pending.size > 0) {
        await Promise.allSettled(scope.pending);
      }
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
      const scope = workspace;
      if (!scope.quiescing && !isEnabled()) return null;
      assertAdmission(scope);
      const { inTransaction } = portRun(scope, runId);
      const read = () =>
        native<
          | (Omit<PendingApproval, "version"> & { interactionVersion: number })
          | null
        >(scope, "agentRunGetPendingApproval", { runId }, runId);
      const pending = await (inTransaction
        ? track(scope, read())
        : enqueue(scope, runId, read));
      if (!pending) return null;
      const { interactionVersion, ...rest } = pending;
      return { ...rest, version: interactionVersion };
    },

    appendToolCalls(runId, entries) {
      return fromPort(
        runId,
        (scope, run) => append(scope, run, entries),
        false,
      );
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
      const scope = workspace;
      if (scope.quiescing) return { kind: "unrecorded" };
      if (!isEnabled()) return { kind: "not_recording" };
      const execution = scope.executions.get(executionId);
      const isCurrent = (run: TrackedRun) =>
        scope.executions.get(executionId) === execution &&
        run.binding.senderId === senderId &&
        run.binding.projectId === projectId &&
        activeStatuses.has(run.state.status);
      if (!execution?.recorded || !isCurrent(execution.run)) {
        return { kind: "unrecorded" };
      }
      const { run } = execution;
      return {
        kind: "recorded",
        runId: run.state.runId,
        async transact(op) {
          assertAdmission(scope);
          if (transactions.getStore()?.active) {
            throw new Error("AGENT_RUN_REENTRANT_TRANSACTION");
          }
          return enqueue(scope, run, () => {
            if (!isCurrent(run)) {
              throw new Error("AGENT_RUN_NOT_FOUND");
            }
            return mutate(run, async () => {
              const transaction = { run, active: true };
              try {
                const state = await transactions.run(transaction, () =>
                  op(run.state.version),
                );
                if (scope !== workspace)
                  throw new Error("AGENT_RUN_WORKSPACE_CHANGED");
                return save(run, state);
              } finally {
                transaction.active = false;
              }
            });
          });
        },
      };
    },
  };
}
