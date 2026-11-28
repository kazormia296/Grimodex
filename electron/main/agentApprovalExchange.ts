import type {
  AgentRunApprovalPort,
  AgentRunState,
} from "./agentRunRecorderPort.js";
import type {
  AgentRunExecutionState,
  AnalysisReadBasisEntryV1,
  ApprovalResolution,
} from "../shared/agentRunTypes.js";
import {
  AGENT_APPROVAL_PROTECTED_TOOLS,
  AGENT_APPROVAL_VERSIONED_TOOLS,
  type AgentApprovalExpected,
  type AgentApprovalObservation,
  agentTreePlanRequiresVersion,
} from "./agentApprovalProtectedTools.js";

export const AGENT_APPROVAL_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
export const AGENT_APPROVAL_CAPABILITY_TTL_MS = 60 * 1000;

export interface AgentApprovalRunHandle {
  readonly runId: string;
  transact<T extends AgentRunState>(
    op: (version: number) => Promise<T>,
  ): Promise<T>;
}

export interface AgentApprovalRequest {
  readonly senderId: number;
  readonly projectId: string;
  readonly executionId: string;
  readonly chatMessageId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly model: string | null;
  readonly modelInput: Record<string, unknown>;
  readonly observed: AgentApprovalObservation | null;
  readonly run: AgentApprovalRunHandle;
  readonly signal: AbortSignal;
}

export interface AgentApprovalTarget extends AgentApprovalObservation {
  readonly summary: string;
  readonly expected: AgentApprovalExpected | null;
}

export interface AgentApprovalPendingInfo {
  readonly interactionId: string;
  readonly senderId: number;
  readonly projectId: string;
  readonly executionId: string;
  readonly chatMessageId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly summary: string;
}

export interface PreparedAgentApprovalCapability<TGrant> {
  readonly grant: TGrant;
  activate(): void;
  revoke(): void;
}

export interface AgentApprovalGrantLike {
  readonly mainOwnedProvenanceId: string;
}

export interface AgentApprovalExchangeDependencies<TGrant> {
  readonly port: AgentRunApprovalPort;
  isPolicyAllowed(
    request: AgentApprovalRequest,
    additionalPolicy?: "bodyWrite",
  ): boolean | Promise<boolean>;
  inputDigest(
    toolName: string,
    modelInput: Record<string, unknown>,
  ): string | null;
  readTarget(
    request: AgentApprovalRequest,
  ): AgentApprovalTarget | null | Promise<AgentApprovalTarget | null>;
  prepareCapability(
    request: AgentApprovalRequest,
    target: AgentApprovalTarget,
  ): PreparedAgentApprovalCapability<TGrant> | null;
  onPending(info: AgentApprovalPendingInfo): void;
  setTimer(ms: number, fn: () => void): () => void;
  newId(): string;
}

export type AgentApprovalExchangeOutcome<TGrant> =
  | {
      readonly kind: "approved";
      readonly grant: TGrant;
      readonly interactionId: string;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "superseded" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "not_protected"
        | "duplicate"
        | "policy"
        | "input_unsupported"
        | "target_unreadable"
        | "target_changed"
        | "model_version_mismatch"
        | "version_missing"
        | "request_too_large"
        | "port_failed";
    };

type Settlement =
  | { readonly kind: "answer"; readonly decision: ApprovalResolution }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "notification_failed" };

interface LiveWait {
  readonly info: AgentApprovalPendingInfo;
  readonly interactionVersion: number;
  readonly run: AgentApprovalRunHandle;
  readonly signal: AbortSignal;
  readonly promise: Promise<Settlement>;
  isPending(): boolean;
  settle(value: Settlement): boolean;
  start(): void;
}

const ABORTED = Symbol("agent-approval-aborted");

function cloneFrozenJson<T>(value: T): T {
  const cloned = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item))
      return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

function snapshotTarget(target: AgentApprovalTarget): AgentApprovalTarget {
  return cloneFrozenJson(target);
}

function canonicalBasis(
  basis: readonly AnalysisReadBasisEntryV1[] | null,
): string | null {
  if (basis === null) return null;
  return JSON.stringify(
    basis
      .map((entry) => [
        entry.sourceKind,
        entry.sourceId,
        "version" in entry
          ? ["version", entry.version]
          : ["contentHash", entry.contentHash],
      ])
      .sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

function sameBasis(
  left: readonly AnalysisReadBasisEntryV1[] | null,
  right: readonly AnalysisReadBasisEntryV1[] | null,
): boolean {
  return canonicalBasis(left) === canonicalBasis(right);
}

function canonicalVersions(
  versions: AgentApprovalObservation["baseVersions"],
): string | null {
  if (versions === null) return null;
  return JSON.stringify(
    [...versions]
      .map(({ id, version }) => [id, version])
      .sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

function sameObservation(
  observed: AgentApprovalObservation | null,
  target: AgentApprovalTarget,
): boolean {
  if (observed === null)
    return (
      target.basis === null &&
      target.baseVersions === null &&
      target.expected === null
    );
  return (
    sameBasis(observed.basis, target.basis) &&
    canonicalVersions(observed.baseVersions) ===
      canonicalVersions(target.baseVersions) &&
    sameExpected(observed.expected, target.expected)
  );
}

function sameExpected(
  left: AgentApprovalExpected | null,
  right: AgentApprovalExpected | null,
): boolean {
  const key = (expected: AgentApprovalExpected | null) =>
    expected === null
      ? null
      : expected.kind === "scene_event_link"
        ? [expected.kind, expected.linkIncarnation, expected.eventVersion]
        : [
            expected.kind,
            expected.related,
            expected.causeVersion,
            expected.effectVersion,
          ];
  return JSON.stringify(key(left)) === JSON.stringify(key(right));
}

function sameTarget(
  left: AgentApprovalTarget,
  right: AgentApprovalTarget,
): boolean {
  const expectedKey = (expected: AgentApprovalExpected | null) => {
    if (!expected) return null;
    return expected.kind === "scene_event_link"
      ? [expected.kind, expected.linkIncarnation, expected.eventVersion]
      : [
          expected.kind,
          expected.related,
          expected.causeVersion,
          expected.effectVersion,
        ];
  };
  return (
    sameBasis(left.basis, right.basis) &&
    canonicalVersions(left.baseVersions) ===
      canonicalVersions(right.baseVersions) &&
    JSON.stringify(expectedKey(left.expected)) ===
      JSON.stringify(expectedKey(right.expected))
  );
}

function targetVersion(
  versions: AgentApprovalTarget["baseVersions"],
  id: unknown,
): number | null {
  if (versions === null || typeof id !== "string" || id.length === 0)
    return null;
  const matches = versions.filter((entry) => entry.id === id);
  const version = matches[0]?.version;
  return matches.length === 1 && Number.isSafeInteger(version) && version >= 0
    ? version
    : null;
}

function hasVersionedTarget(
  request: AgentApprovalRequest,
  target: AgentApprovalTarget,
): boolean {
  if (!AGENT_APPROVAL_VERSIONED_TOOLS.has(request.toolName)) return true;
  const versions = target.baseVersions;
  if (request.toolName === "apply_ai_tree_plan") {
    const ops = request.modelInput.ops;
    const requiresVersion = agentTreePlanRequiresVersion(ops);
    if (requiresVersion === null) return false;
    if (!requiresVersion) return true;
    const updatedIds = (ops as Array<{ op: string; nodeId?: unknown }>).flatMap(
      (op) =>
        op !== null &&
        typeof op === "object" &&
        (op.op === "move" || op.op === "rename") &&
        typeof op.nodeId === "string"
          ? [op.nodeId]
          : [],
    );
    if (updatedIds.length === 0) return true;
    if (versions === null || versions.length === 0) return false;
    return (
      new Set(versions.map(({ id }) => id)).size === versions.length &&
      updatedIds.every((id) => targetVersion(versions, id) !== null)
    );
  }
  if (
    versions === null ||
    versions.length === 0 ||
    versions.some(
      ({ id, version }) =>
        typeof id !== "string" ||
        id.length === 0 ||
        !Number.isSafeInteger(version) ||
        version < 0,
    )
  ) {
    return false;
  }
  switch (request.toolName) {
    case "update_codex_entry":
    case "update_foreshadow":
      return targetVersion(versions, request.modelInput.id) !== null;
    case "update_event":
    case "delete_event":
    case "set_event_participants":
      return targetVersion(versions, request.modelInput.eventId) !== null;
    default:
      return false;
  }
}

function modelVersionMatches(
  request: AgentApprovalRequest,
  target: AgentApprovalTarget,
): boolean {
  if (request.toolName !== "update_foreshadow") return true;
  return (
    typeof request.modelInput.baseVersion === "number" &&
    targetVersion(target.baseVersions, request.modelInput.id) ===
      request.modelInput.baseVersion
  );
}

function hasExpectedTarget(
  request: AgentApprovalRequest,
  target: AgentApprovalTarget,
): boolean {
  if (
    request.toolName === "stamp_scene_event" ||
    request.toolName === "unstamp_scene_event"
  ) {
    const expected = target.expected;
    return (
      expected?.kind === "scene_event_link" &&
      (expected.linkIncarnation === null ||
        (typeof expected.linkIncarnation === "string" &&
          expected.linkIncarnation.length > 0)) &&
      Number.isSafeInteger(expected.eventVersion) &&
      expected.eventVersion >= 0
    );
  }
  if (
    request.toolName === "add_event_relation" ||
    request.toolName === "remove_event_relation"
  ) {
    const expected = target.expected;
    return (
      expected?.kind === "event_relation" &&
      typeof expected.related === "boolean" &&
      Number.isSafeInteger(expected.causeVersion) &&
      expected.causeVersion >= 0 &&
      Number.isSafeInteger(expected.effectVersion) &&
      expected.effectVersion >= 0
    );
  }
  return target.expected === null;
}

function hasSynopsis(request: AgentApprovalRequest): boolean {
  if (request.toolName !== "apply_ai_tree_plan") return false;
  const ops = request.modelInput.ops;
  return (
    Array.isArray(ops) &&
    ops.some(
      (op) =>
        op !== null &&
        typeof op === "object" &&
        "op" in op &&
        op.op === "create" &&
        "synopsis" in op &&
        typeof op.synopsis === "string" &&
        op.synopsis.trim() !== "",
    )
  );
}

function summaryBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requestKey(request: AgentApprovalRequest): string {
  return `${request.run.runId}\0${request.toolCallId}`;
}

function createLiveWait(
  info: AgentApprovalPendingInfo,
  interactionVersion: number,
  run: AgentApprovalRunHandle,
  signal: AbortSignal,
  setTimer: (ms: number, fn: () => void) => () => void,
  remove: () => void,
): LiveWait {
  let settled = false;
  let cancelTimer = () => {};
  let started = false;
  let resolvePromise!: (value: Settlement) => void;
  const promise = new Promise<Settlement>((resolve) => {
    resolvePromise = resolve;
  });
  const onAbort = () => settle({ kind: "aborted" });

  function cleanup(): void {
    try {
      cancelTimer();
    } catch {
      // Listener and registration cleanup must still run if a timer adapter fails.
    } finally {
      signal.removeEventListener("abort", onAbort);
      remove();
    }
  }

  function settle(value: Settlement): boolean {
    if (settled) return false;
    settled = true;
    cleanup();
    resolvePromise(value);
    return true;
  }

  return {
    info,
    interactionVersion,
    run,
    signal,
    promise,
    isPending: () => !settled,
    settle,
    start() {
      if (started) return;
      started = true;
      signal.addEventListener("abort", onAbort, { once: true });
      cancelTimer = setTimer(AGENT_APPROVAL_WAIT_TIMEOUT_MS, () =>
        settle({ kind: "timeout" }),
      );
      if (settled) cancelTimer();
      if (signal.aborted) settle({ kind: "aborted" });
    },
  };
}

export function createAgentApprovalExchange<
  TGrant extends AgentApprovalGrantLike,
>(dependencies: AgentApprovalExchangeDependencies<TGrant>) {
  const liveByInteraction = new Map<string, LiveWait>();
  const activeRequests = new Set<string>();
  const capabilityWatches = new Map<
    string,
    { cleanup: () => void; revoke: () => void }
  >();

  const transact = async <T extends AgentRunState>(
    run: AgentApprovalRunHandle,
    signal: AbortSignal,
    op: (version: number) => Promise<T>,
  ): Promise<T> =>
    run.transact((version) => {
      if (signal.aborted) throw ABORTED;
      return op(version);
    });

  const policyAllowed = async (
    request: AgentApprovalRequest,
  ): Promise<boolean> => {
    try {
      if (!(await dependencies.isPolicyAllowed(request))) return false;
      return (
        !hasSynopsis(request) ||
        (await dependencies.isPolicyAllowed(request, "bodyWrite"))
      );
    } catch {
      return false;
    }
  };

  const watchCapability = (
    request: AgentApprovalRequest,
    prepared: PreparedAgentApprovalCapability<TGrant>,
  ): boolean => {
    const key = requestKey(request);
    let active = true;
    let cancelTimer: (() => void) | undefined;
    const cleanup = () => {
      if (!active) return;
      active = false;
      request.signal.removeEventListener("abort", onAbort);
      if (capabilityWatches.get(key)?.cleanup === cleanup)
        capabilityWatches.delete(key);
      try {
        cancelTimer?.();
      } catch {
        // Timer cleanup must not retain the abort listener.
      }
    };
    const revoke = () => {
      try {
        prepared.revoke();
      } finally {
        cleanup();
      }
    };
    const onAbort = () => revoke();
    request.signal.addEventListener("abort", onAbort, { once: true });
    capabilityWatches.set(key, { cleanup, revoke });
    try {
      cancelTimer = dependencies.setTimer(
        AGENT_APPROVAL_CAPABILITY_TTL_MS,
        revoke,
      );
      if (!active) cancelTimer();
    } catch {
      revoke();
      return false;
    }
    if (request.signal.aborted) revoke();
    return active;
  };

  const markFailed = async (
    request: AgentApprovalRequest,
    live: LiveWait,
    outcome: "rejected" | "superseded",
    resolution?: ApprovalResolution,
  ): Promise<"accepted" | "port_failed" | "aborted"> => {
    try {
      await transact(request.run, request.signal, (expectedVersion) =>
        outcome === "rejected"
          ? dependencies.port.decideApproval({
              runId: request.run.runId,
              expectedVersion,
              interactionId: live.info.interactionId,
              interactionVersion: live.interactionVersion,
              decision: resolution!,
            })
          : dependencies.port.invalidateApproval({
              runId: request.run.runId,
              expectedVersion,
              interactionId: live.info.interactionId,
              interactionVersion: live.interactionVersion,
              outcome: "superseded",
            }),
      );
    } catch {
      return request.signal.aborted ? "aborted" : "port_failed";
    }
    try {
      await dependencies.port.updateToolCall(
        request.run.runId,
        request.toolCallId,
        { executionState: "failed" },
      );
    } catch {
      return "port_failed";
    }
    return request.signal.aborted ? "aborted" : "accepted";
  };

  const supersede = async (
    request: AgentApprovalRequest,
    live: LiveWait,
  ): Promise<AgentApprovalExchangeOutcome<TGrant>> => {
    if (request.signal.aborted) return { kind: "aborted" };
    const result = await markFailed(request, live, "superseded");
    if (result === "aborted") return { kind: "aborted" };
    return result === "port_failed"
      ? { kind: "refused", reason: "port_failed" }
      : { kind: "superseded" };
  };

  const finishApproval = async (
    request: AgentApprovalRequest,
    live: LiveWait,
    originalTarget: AgentApprovalTarget,
    requestDigest: string,
  ): Promise<AgentApprovalExchangeOutcome<TGrant>> => {
    if (request.signal.aborted) return { kind: "aborted" };
    if (!(await policyAllowed(request))) return supersede(request, live);

    let digest: string | null;
    try {
      digest = dependencies.inputDigest(request.toolName, request.modelInput);
    } catch {
      digest = null;
    }
    if (digest === null) return supersede(request, live);
    let target: AgentApprovalTarget | null;
    try {
      const resolved = await dependencies.readTarget(request);
      target = resolved === null ? null : snapshotTarget(resolved);
    } catch {
      target = null;
    }
    let targetMatches = false;
    if (target !== null) {
      try {
        targetMatches = sameTarget(originalTarget, target);
      } catch {
        targetMatches = false;
      }
    }
    if (
      target === null ||
      digest !== requestDigest ||
      !targetMatches ||
      !hasVersionedTarget(request, target) ||
      !modelVersionMatches(request, target) ||
      !hasExpectedTarget(request, target)
    )
      return supersede(request, live);
    if (request.signal.aborted) return { kind: "aborted" };

    try {
      await transact(request.run, request.signal, (expectedVersion) =>
        dependencies.port.decideApproval({
          runId: request.run.runId,
          expectedVersion,
          interactionId: live.info.interactionId,
          interactionVersion: live.interactionVersion,
          decision: "approved",
        }),
      );
    } catch {
      return request.signal.aborted
        ? { kind: "aborted" }
        : { kind: "refused", reason: "port_failed" };
    }

    let prepared: PreparedAgentApprovalCapability<TGrant> | null;
    try {
      prepared = dependencies.prepareCapability(request, target);
    } catch {
      prepared = null;
    }
    if (!prepared) return { kind: "refused", reason: "port_failed" };
    try {
      await dependencies.port.updateToolCall(
        request.run.runId,
        request.toolCallId,
        {
          mainOwnedProvenanceId: prepared.grant.mainOwnedProvenanceId,
          capabilityState: "issued",
        },
      );
    } catch {
      return request.signal.aborted
        ? { kind: "aborted" }
        : { kind: "refused", reason: "port_failed" };
    }
    if (request.signal.aborted) {
      prepared.revoke();
      return { kind: "aborted" };
    }
    try {
      prepared.activate();
    } catch {
      prepared.revoke();
      return { kind: "refused", reason: "port_failed" };
    }
    if (!watchCapability(request, prepared)) {
      try {
        await dependencies.port.updateToolCall(
          request.run.runId,
          request.toolCallId,
          { executionState: "failed" },
        );
      } catch {
        // Revocation already happened; keep the watch setup failure outcome.
      }
      return request.signal.aborted
        ? { kind: "aborted" }
        : { kind: "refused", reason: "port_failed" };
    }
    return {
      kind: "approved",
      grant: prepared.grant,
      interactionId: live.info.interactionId,
    };
  };

  async function request(
    input: AgentApprovalRequest,
  ): Promise<AgentApprovalExchangeOutcome<TGrant>> {
    if (!AGENT_APPROVAL_PROTECTED_TOOLS.has(input.toolName))
      return { kind: "refused", reason: "not_protected" };
    if (input.signal.aborted) return { kind: "aborted" };
    const key = requestKey(input);
    if (activeRequests.has(key))
      return { kind: "refused", reason: "duplicate" };
    activeRequests.add(key);
    try {
      let modelInput: Record<string, unknown>;
      let observed: AgentApprovalObservation | null;
      try {
        modelInput = cloneFrozenJson(input.modelInput);
        if (!Object.hasOwn(input, "observed"))
          throw new Error("observed missing");
        observed = cloneFrozenJson(input.observed);
      } catch {
        return { kind: "refused", reason: "input_unsupported" };
      }
      const captured: AgentApprovalRequest = Object.freeze({
        ...input,
        modelInput,
        observed,
      });
      if (
        captured.toolName === "apply_ai_tree_plan" &&
        agentTreePlanRequiresVersion(captured.modelInput.ops) === null
      ) {
        return { kind: "refused", reason: "input_unsupported" };
      }
      if (input.signal.aborted) return { kind: "aborted" };
      if (!(await policyAllowed(captured)))
        return { kind: "refused", reason: "policy" };
      if (input.signal.aborted) return { kind: "aborted" };

      let digest: string | null;
      try {
        digest = dependencies.inputDigest(input.toolName, captured.modelInput);
      } catch {
        digest = null;
      }
      if (!digest) return { kind: "refused", reason: "input_unsupported" };
      let target: AgentApprovalTarget | null;
      try {
        const resolved = await dependencies.readTarget(captured);
        target = resolved === null ? null : snapshotTarget(resolved);
      } catch {
        target = null;
      }
      if (input.signal.aborted) return { kind: "aborted" };
      if (target === null || typeof target.summary !== "string")
        return { kind: "refused", reason: "target_unreadable" };
      let observationMatches = false;
      try {
        observationMatches = sameObservation(observed, target);
      } catch {
        observationMatches = false;
      }
      if (!observationMatches)
        return { kind: "refused", reason: "target_changed" };
      if (
        !hasVersionedTarget(captured, target) ||
        !hasExpectedTarget(captured, target)
      )
        return { kind: "refused", reason: "version_missing" };
      if (!modelVersionMatches(captured, target))
        return { kind: "refused", reason: "model_version_mismatch" };
      if (summaryBytes(target.summary) > 64 * 1024)
        return { kind: "refused", reason: "request_too_large" };

      try {
        await dependencies.port.updateToolCall(
          input.run.runId,
          input.toolCallId,
          {
            capabilityState: "awaiting_approval",
          },
        );
      } catch {
        return { kind: "refused", reason: "port_failed" };
      }
      if (input.signal.aborted) return { kind: "aborted" };
      let interactionId: string;
      try {
        interactionId = dependencies.newId();
      } catch {
        return { kind: "refused", reason: "port_failed" };
      }
      if (
        typeof interactionId !== "string" ||
        interactionId.length === 0 ||
        liveByInteraction.has(interactionId)
      ) {
        return { kind: "refused", reason: "port_failed" };
      }
      let opened: AgentRunState & { readonly interactionVersion: number };
      try {
        opened = await transact(input.run, input.signal, (expectedVersion) =>
          dependencies.port.openApproval({
            runId: input.run.runId,
            expectedVersion,
            interactionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            argsDigest: digest!,
            request: target!.summary,
            targetBasis: target!.basis,
          }),
        );
      } catch {
        return input.signal.aborted
          ? { kind: "aborted" }
          : { kind: "refused", reason: "port_failed" };
      }
      if (input.signal.aborted) return { kind: "aborted" };

      const info: AgentApprovalPendingInfo = Object.freeze({
        interactionId,
        senderId: input.senderId,
        projectId: input.projectId,
        executionId: input.executionId,
        chatMessageId: input.chatMessageId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        summary: target.summary,
      });
      const live = createLiveWait(
        info,
        opened.interactionVersion,
        input.run,
        input.signal,
        dependencies.setTimer,
        () => {
          if (liveByInteraction.get(interactionId) === live)
            liveByInteraction.delete(interactionId);
        },
      );
      liveByInteraction.set(interactionId, live);
      try {
        live.start();
      } catch {
        live.settle({ kind: "notification_failed" });
      }
      if (input.signal.aborted) live.settle({ kind: "aborted" });
      if (live.isPending() && !input.signal.aborted) {
        try {
          dependencies.onPending(info);
        } catch {
          live.settle({ kind: "notification_failed" });
        }
      }
      const settlement = await live.promise;
      if (settlement.kind === "timeout") {
        try {
          await input.run.transact((expectedVersion) =>
            dependencies.port.interruptForApprovalTimeout({
              runId: input.run.runId,
              expectedVersion,
            }),
          );
        } catch {
          // A timeout still ends the local wait; the owner records the failed interruption.
        }
        return { kind: "timeout" };
      }
      if (settlement.kind === "aborted") return { kind: "aborted" };
      if (settlement.kind === "notification_failed") {
        const result = await markFailed(input, live, "superseded");
        if (result === "aborted") return { kind: "aborted" };
        return { kind: "refused", reason: "port_failed" };
      }
      if (settlement.decision === "rejected") {
        const result = await markFailed(input, live, "rejected", "rejected");
        if (result === "aborted") return { kind: "aborted" };
        return result === "port_failed"
          ? { kind: "refused", reason: "port_failed" }
          : { kind: "rejected" };
      }
      return await finishApproval(captured, live, target, digest);
    } finally {
      activeRequests.delete(key);
    }
  }

  function resolve(input: {
    readonly interactionId: string;
    readonly senderId: number;
    readonly projectId: string;
    readonly decision: ApprovalResolution;
  }): "accepted" | "unknown" | "mismatch" {
    if (input.decision !== "approved" && input.decision !== "rejected")
      return "unknown";
    const live = liveByInteraction.get(input.interactionId);
    if (!live) return "unknown";
    if (
      input.senderId !== live.info.senderId ||
      input.projectId !== live.info.projectId
    ) {
      return "mismatch";
    }
    return live.settle({ kind: "answer", decision: input.decision })
      ? "accepted"
      : "unknown";
  }

  async function recordExecution(
    runId: string,
    toolCallId: string,
    executionState: Extract<AgentRunExecutionState, "committed" | "failed">,
  ): Promise<void> {
    const watch = capabilityWatches.get(`${runId}\0${toolCallId}`);
    if (executionState === "failed") watch?.revoke();
    else watch?.cleanup();
    await dependencies.port.updateToolCall(runId, toolCallId, {
      capabilityState: "consumed",
      executionState,
    });
  }

  return { request, resolve, recordExecution };
}
