// Test-only fake: product modules must not import this file.
import type {
  AgentRunApprovalPort,
  AgentRunLedgerEntry,
  AgentRunState,
  AgentRunToolCallKey,
  PendingApproval,
} from "./agentRunRecorderPort.js";
import type {
  AgentRunCapabilityState,
  AgentRunExecutionState,
  AgentRunInteractionStatus,
  AgentRunStatus,
} from "../shared/agentRunTypes.js";

type Interaction = {
  -readonly [Key in keyof PendingApproval]: PendingApproval[Key];
} & {
  runId: string;
  status: AgentRunInteractionStatus;
  request: string;
  resolution: string;
};
type MutableLedgerEntry = {
  -readonly [Key in keyof AgentRunLedgerEntry]: AgentRunLedgerEntry[Key];
};
type Run = {
  runId: string;
  rootRunId: string;
  version: number;
  status: AgentRunStatus;
  ledger: MutableLedgerEntry[];
  auditExecutionIds: string[];
};

function fail(code: string): never {
  throw new Error(code);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateToolCallKey(executionId: string, toolCallId: string): void {
  if (!executionId) fail("AGENT_RUN_EXECUTION_ID_INVALID");
  if (!toolCallId) fail("AGENT_RUN_TOOL_CALL_ID_INVALID");
}

function validBasis(
  value: unknown,
): value is NonNullable<PendingApproval["targetBasis"]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    return false;
  if (utf8Bytes(JSON.stringify(value)) > 32 * 1024) return false;
  return value.every((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const basis = entry as Record<string, unknown>;
    const hasVersion = Object.hasOwn(basis, "version");
    const hasHash = Object.hasOwn(basis, "contentHash");
    const revision = hasVersion ? basis.version : basis.contentHash;
    return (
      Object.keys(basis).every((key) =>
        ["sourceKind", "sourceId", "version", "contentHash"].includes(key),
      ) &&
      typeof basis.sourceKind === "string" &&
      utf8Bytes(basis.sourceKind) >= 1 &&
      utf8Bytes(basis.sourceKind) <= 64 &&
      typeof basis.sourceId === "string" &&
      utf8Bytes(basis.sourceId) >= 1 &&
      utf8Bytes(basis.sourceId) <= 256 &&
      hasVersion !== hasHash &&
      typeof revision === "string" &&
      utf8Bytes(revision) >= 1 &&
      utf8Bytes(revision) <= 256
    );
  });
}

function invalidBasisDeserialization(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const basis = entry as Record<string, unknown>;
      const hasVersion = Object.hasOwn(basis, "version");
      const hasHash = Object.hasOwn(basis, "contentHash");
      return (
        hasVersion === hasHash ||
        Object.keys(basis).some(
          (key) =>
            !["sourceKind", "sourceId", "version", "contentHash"].includes(key),
        )
      );
    })
  );
}

export class FakeAgentRunApprovalPort implements AgentRunApprovalPort {
  readonly #runs = new Map<string, Run>();
  readonly #interactions = new Map<string, Interaction>();

  createRunningRun(runId: string, rootRunId = runId): AgentRunState {
    const run = {
      runId,
      rootRunId,
      version: 0,
      status: "running" as const,
      ledger: [],
      auditExecutionIds: [],
    };
    this.#runs.set(runId, run);
    return this.readRun(runId);
  }

  readRun(runId: string): AgentRunState {
    const run = this.#runs.get(runId);
    if (!run) fail("AGENT_RUN_NOT_FOUND");
    return { runId, version: run.version, status: run.status };
  }

  readInteraction(interactionId: string): {
    status: AgentRunInteractionStatus;
    request: string;
    resolution: string;
  } | null {
    const interaction = this.#interactions.get(interactionId);
    return interaction
      ? {
          status: interaction.status,
          request: interaction.request,
          resolution: interaction.resolution,
        }
      : null;
  }

  readToolCall(
    runId: string,
    key: AgentRunToolCallKey,
  ): AgentRunLedgerEntry | null {
    const entry = this.#runs
      .get(runId)
      ?.ledger.find(
        (item) =>
          item.executionId === key.executionId &&
          item.toolCallId === key.toolCallId,
      );
    return entry ? { ...entry } : null;
  }

  stopRun(runId: string): AgentRunState {
    const run = this.#requireRun(runId);
    if (run.status === "waiting_approval") {
      run.status = "finalizing";
      run.version += 1;
    } else if (run.status !== "running") {
      fail("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
    }
    run.status = "cancelled";
    run.version += 1;
    run.ledger = [];
    for (const interaction of this.#interactions.values()) {
      if (interaction.runId === runId) {
        if (interaction.status === "pending") {
          interaction.status = "cancelled";
          interaction.version += 1;
        }
        interaction.request = "";
        interaction.resolution = "";
        interaction.targetBasis = null;
      }
    }
    return this.readRun(runId);
  }

  beginFinalizingRun(runId: string): AgentRunState {
    const run = this.#requireRun(runId);
    if (!["running", "waiting_approval"].includes(run.status))
      fail("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
    run.status = "finalizing";
    run.version += 1;
    return this.readRun(runId);
  }

  async openApproval(
    input: Parameters<AgentRunApprovalPort["openApproval"]>[0],
  ) {
    if (invalidBasisDeserialization(input.targetBasis))
      throw new Error("invalid target basis enum during deserialization");
    if (utf8Bytes(input.request) > 65_536) fail("AGENT_RUN_REQUEST_TOO_LARGE");
    if (input.targetBasis !== null && !validBasis(input.targetBasis))
      fail("AGENT_RUN_TARGET_BASIS_INVALID");
    const run = this.#requireRun(input.runId);
    this.#requireNonterminal(input.runId);
    if (
      [...this.#interactions.values()].some(
        (item) =>
          item.status === "pending" &&
          this.#runs.get(item.runId)?.rootRunId === run.rootRunId,
      )
    ) {
      fail("AGENT_RUN_PENDING_INTERACTION_EXISTS");
    }
    validateToolCallKey(input.executionId, input.toolCallId);
    const entry = [...run.ledger]
      .reverse()
      .find((item) => item.toolCallId === input.toolCallId);
    if (!entry) fail("AGENT_RUN_UNKNOWN_TOOL_CALL_ID");
    if (entry.executionId !== input.executionId)
      fail("AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH");
    if (entry.name !== input.toolName || entry.argsDigest !== input.argsDigest)
      fail("AGENT_RUN_TOOL_CALL_MISMATCH");
    this.#requireCas(input.runId, input.expectedVersion, "running");
    if (this.#interactions.has(input.interactionId))
      throw new Error(
        "UNIQUE constraint failed: agent_run_interactions.interaction_id",
      );
    run.status = "waiting_approval";
    run.version += 1;
    this.#interactions.set(input.interactionId, {
      runId: input.runId,
      interactionId: input.interactionId,
      executionId: input.executionId,
      version: 0,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argsDigest: input.argsDigest,
      targetBasis: input.targetBasis,
      status: "pending",
      request: input.request,
      resolution: "",
    });
    return { ...this.readRun(input.runId), interactionVersion: 0 };
  }

  async decideApproval(
    input: Parameters<AgentRunApprovalPort["decideApproval"]>[0],
  ) {
    return this.#closeApproval(input, "resolved", input.decision);
  }

  async invalidateApproval(
    input: Parameters<AgentRunApprovalPort["invalidateApproval"]>[0],
  ) {
    return this.#closeApproval(input, input.outcome, "");
  }

  async interruptForApprovalTimeout(
    input: Parameters<AgentRunApprovalPort["interruptForApprovalTimeout"]>[0],
  ) {
    const run = this.#requireCas(
      input.runId,
      input.expectedVersion,
      "waiting_approval",
    );
    run.status = "interrupted";
    run.version += 1;
    return this.readRun(input.runId);
  }

  async getPendingApproval(runId: string): Promise<PendingApproval | null> {
    if (!this.#runs.has(runId)) return null;
    const item = [...this.#interactions.values()].find(
      (candidate) =>
        candidate.runId === runId && candidate.status === "pending",
    );
    if (!item) return null;
    const {
      runId: _runId,
      status: _status,
      request: _request,
      resolution: _resolution,
      ...pending
    } = item;
    return pending;
  }

  async appendToolCalls(
    runId: string,
    entries: readonly AgentRunLedgerEntry[],
  ): Promise<void> {
    if (entries.length === 0) fail("AGENT_RUN_EMPTY_TOOL_CALL_BATCH");
    const run = this.#requireRun(runId);
    this.#requireActive(runId);
    const executionId = entries[0]!.executionId;
    const pendingToolCallId = [...this.#interactions.values()].find(
      (item) => item.runId === runId && item.status === "pending",
    )?.toolCallId;
    const toolCallIds = new Set(
      run.ledger
        .filter((item) => item.executionId === executionId)
        .map((item) => item.toolCallId),
    );
    for (const entry of entries) {
      validateToolCallKey(entry.executionId, entry.toolCallId);
      if (entry.executionId !== executionId)
        fail("AGENT_RUN_TOOL_CALL_BATCH_EXECUTION_MISMATCH");
      if (pendingToolCallId === entry.toolCallId)
        fail("AGENT_RUN_PENDING_INTERACTION_EXISTS");
      if (toolCallIds.has(entry.toolCallId))
        fail("AGENT_RUN_DUPLICATE_TOOL_CALL_ID");
      toolCallIds.add(entry.toolCallId);
    }
    if (!run.auditExecutionIds.includes(executionId)) {
      if (run.auditExecutionIds.length >= 512)
        fail("AGENT_RUN_AUDIT_EXECUTION_IDS_LIMIT");
      run.auditExecutionIds.push(executionId);
    }
    run.ledger.push(...entries.map((entry) => ({ ...entry })));
  }

  async updateToolCall(
    runId: string,
    call: AgentRunToolCallKey,
    update: {
      readonly mainOwnedProvenanceId?: string;
      readonly capabilityState?: AgentRunCapabilityState;
      readonly executionState?: Exclude<AgentRunExecutionState, "pending">;
    },
  ): Promise<void> {
    validateToolCallKey(call.executionId, call.toolCallId);
    const run = this.#requireNonterminal(runId);
    const entry = run.ledger.find(
      (item) =>
        item.executionId === call.executionId &&
        item.toolCallId === call.toolCallId,
    );
    if (!entry) fail("AGENT_RUN_UNKNOWN_TOOL_CALL_ID");
    if (
      update.mainOwnedProvenanceId === undefined &&
      update.capabilityState === undefined &&
      update.executionState === undefined
    )
      fail("AGENT_RUN_TOOL_CALL_TRANSITION_INVALID");
    if (update.mainOwnedProvenanceId !== undefined) {
      if (!update.mainOwnedProvenanceId || entry.mainOwnedProvenanceId)
        fail("AGENT_RUN_TOOL_CALL_TRANSITION_INVALID");
    }
    if (update.capabilityState !== undefined) {
      const rank: Record<AgentRunCapabilityState, number> = {
        not_issued: 0,
        awaiting_approval: 1,
        issued: 2,
        consumed: 3,
      };
      if (rank[update.capabilityState] <= rank[entry.capabilityState])
        fail("AGENT_RUN_TOOL_CALL_TRANSITION_INVALID");
    }
    if (update.executionState !== undefined) {
      if (entry.executionState !== "pending")
        fail("AGENT_RUN_TOOL_CALL_TRANSITION_INVALID");
    }
    if (update.mainOwnedProvenanceId !== undefined)
      entry.mainOwnedProvenanceId = update.mainOwnedProvenanceId;
    if (update.capabilityState !== undefined)
      entry.capabilityState = update.capabilityState;
    if (update.executionState !== undefined)
      entry.executionState = update.executionState;
  }

  #closeApproval(
    input: {
      readonly runId: string;
      readonly expectedVersion: number;
      readonly interactionId: string;
      readonly interactionVersion: number;
    },
    status: "resolved" | "superseded" | "expired",
    resolution: string,
  ) {
    const run = this.#requireCas(
      input.runId,
      input.expectedVersion,
      "waiting_approval",
    );
    const interaction = this.#interactions.get(input.interactionId);
    if (
      !interaction ||
      interaction.runId !== input.runId ||
      interaction.status !== "pending" ||
      interaction.version !== input.interactionVersion
    ) {
      this.#requireCas(input.runId, input.expectedVersion, "waiting_approval");
      fail("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
    }
    interaction.status = status;
    interaction.version += 1;
    interaction.resolution = resolution;
    run.status = "running";
    run.version += 1;
    return this.readRun(input.runId);
  }

  #requireRun(runId: string): Run {
    const run = this.#runs.get(runId);
    if (!run) fail("AGENT_RUN_NOT_FOUND");
    return run;
  }

  #requireNonterminal(runId: string): Run {
    const run = this.#requireRun(runId);
    if (["completed", "failed", "cancelled", "discarded"].includes(run.status))
      fail("AGENT_RUN_TERMINAL");
    return run;
  }

  #requireActive(runId: string): Run {
    const run = this.#requireNonterminal(runId);
    if (!["running", "waiting_user", "waiting_approval"].includes(run.status))
      fail("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
    return run;
  }

  #requireCas(runId: string, version: number, status: AgentRunStatus): Run {
    const run = this.#requireNonterminal(runId);
    if (run.version !== version || run.status !== status)
      fail("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
    return run;
  }
}
