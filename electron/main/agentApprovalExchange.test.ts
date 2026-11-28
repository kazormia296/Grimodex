import { describe, expect, it, vi } from "vitest";
import {
  AGENT_APPROVAL_CAPABILITY_TTL_MS,
  AGENT_APPROVAL_WAIT_TIMEOUT_MS,
  createAgentApprovalExchange,
  type AgentApprovalExchangeDependencies,
  type AgentApprovalPendingInfo,
  type AgentApprovalRequest,
  type AgentApprovalTarget,
  type AgentApprovalRunHandle,
} from "./agentApprovalExchange.js";
import type {
  AgentRunLedgerEntry,
  AgentRunState,
} from "./agentRunRecorderPort.js";
import { FakeAgentRunApprovalPort } from "./agentRunApprovalPort.fake.js";

interface TestGrant {
  readonly capability: string;
  readonly mainOwnedProvenanceId: string;
}
type TestExchange = ReturnType<typeof createAgentApprovalExchange<TestGrant>>;

interface Timer {
  readonly ms: number;
  readonly callback: () => void;
  cancelled: boolean;
}

const defaultInput = { eventId: "event-1", title: "Updated" };
const defaultTarget: AgentApprovalTarget = {
  summary: "Update event event-1",
  basis: [{ sourceKind: "event", sourceId: "event-1", version: "v1" }],
  baseVersions: [{ id: "event-1", version: 7 }],
  expected: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeFixture(
  options: {
    readonly toolName?: string;
    readonly input?: Record<string, unknown>;
    readonly target?: AgentApprovalTarget | null;
    readonly observed?: AgentApprovalRequest["observed"];
    readonly isPolicyAllowed?: AgentApprovalExchangeDependencies<TestGrant>["isPolicyAllowed"];
    readonly inputDigest?: AgentApprovalExchangeDependencies<TestGrant>["inputDigest"];
    readonly readTarget?: AgentApprovalExchangeDependencies<TestGrant>["readTarget"];
    readonly onPending?: AgentApprovalExchangeDependencies<TestGrant>["onPending"];
    readonly prepareCapability?: AgentApprovalExchangeDependencies<TestGrant>["prepareCapability"];
    readonly setTimer?: AgentApprovalExchangeDependencies<TestGrant>["setTimer"];
  } = {},
) {
  const toolName = options.toolName ?? "update_event";
  const modelInput = options.input ?? defaultInput;
  const port = new FakeAgentRunApprovalPort();
  let version = port.createRunningRun("run-1").version;
  const run: AgentApprovalRunHandle = {
    runId: "run-1",
    async transact<T extends AgentRunState>(
      op: (version: number) => Promise<T>,
    ): Promise<T> {
      const state = await op(version);
      version = state.version;
      return state;
    },
  };
  const signal = new AbortController();
  const initialTarget = Object.hasOwn(options, "target")
    ? options.target!
    : defaultTarget;
  const observed = Object.hasOwn(options, "observed")
    ? options.observed!
    : initialTarget
      ? {
          basis: initialTarget.basis,
          baseVersions: initialTarget.baseVersions,
          expected: initialTarget.expected,
        }
      : null;
  const request: AgentApprovalRequest = {
    senderId: 11,
    projectId: "project-1",
    executionId: "execution-1",
    chatMessageId: "message-1",
    toolCallId: "call-1",
    toolName,
    model: "model-1",
    modelInput,
    observed,
    run,
    signal: signal.signal,
  };
  const timers: Timer[] = [];
  let pendingInfo: AgentApprovalPendingInfo | null = null;
  const pendingEntered = deferred<void>();
  const activated: TestGrant[] = [];
  const dependencies: AgentApprovalExchangeDependencies<TestGrant> = {
    port,
    isPolicyAllowed: options.isPolicyAllowed ?? vi.fn(() => true),
    inputDigest: options.inputDigest ?? vi.fn(() => "digest-1"),
    readTarget:
      options.readTarget ??
      vi.fn(() =>
        options.target === undefined ? defaultTarget : options.target,
      ),
    prepareCapability:
      options.prepareCapability ??
      vi.fn((_request, _target) => {
        const grant = {
          capability: "cap-1",
          mainOwnedProvenanceId: "provenance-1",
        };
        return {
          grant,
          activate() {
            activated.push(grant);
          },
          revoke() {
            activated.splice(activated.indexOf(grant), 1);
          },
        };
      }),
    onPending:
      options.onPending ??
      vi.fn((info) => {
        pendingInfo = info;
        pendingEntered.resolve();
      }),
    setTimer:
      options.setTimer ??
      vi.fn((ms, callback) => {
        const timer = { ms, callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      }),
    newId: vi.fn(() => "interaction-1"),
  };
  const exchange = createAgentApprovalExchange(dependencies);

  async function appendToolCall(): Promise<void> {
    const entry: AgentRunLedgerEntry = {
      toolCallId: request.toolCallId,
      name: request.toolName,
      canonicalArgs: request.modelInput,
      argsDigest: "digest-1",
      executionId: request.executionId,
      chatMessageId: request.chatMessageId,
      mainOwnedProvenanceId: "",
      model: request.model ?? "",
      capabilityState: "not_issued",
      executionState: "pending",
    };
    await port.appendToolCall(run.runId, entry);
  }

  return {
    activated,
    appendToolCall,
    dependencies,
    exchange,
    pendingEntered: pendingEntered.promise,
    get pendingInfo() {
      return pendingInfo;
    },
    get runVersion() {
      return version;
    },
    port,
    request,
    signal,
    timers,
    fireTimer() {
      const timer = timers[0];
      if (timer && !timer.cancelled) timer.callback();
    },
  };
}

describe("agent approval exchange", () => {
  it("opens a pending interaction without activating a capability, then activates after approval", async () => {
    const f = makeFixture();
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;

    expect(f.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "awaiting_approval",
      executionState: "pending",
    });
    expect(f.activated).toEqual([]);
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("accepted");
    await expect(completion).resolves.toMatchObject({
      kind: "approved",
      grant: { capability: "cap-1" },
      interactionId: "interaction-1",
    });
    expect(f.activated).toHaveLength(1);
    expect(f.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "issued",
      mainOwnedProvenanceId: "provenance-1",
    });
    expect(f.timers[0]?.cancelled).toBe(true);
    expect(f.timers[1]?.ms).toBe(AGENT_APPROVAL_CAPABILITY_TTL_MS);
    expect(AGENT_APPROVAL_CAPABILITY_TTL_MS).toBe(60_000);
    f.signal.abort();
    expect(f.activated).toEqual([]);
    expect(f.timers[1]?.cancelled).toBe(true);
  });

  it("detaches the post-approval monitor on execution or capability expiry", async () => {
    const completed = makeFixture();
    await completed.appendToolCall();
    const completion = completed.exchange.request(completed.request);
    await completed.pendingEntered;
    completed.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toMatchObject({ kind: "approved" });
    await completed.exchange.recordExecution("run-1", "call-1", "committed");
    expect(completed.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "consumed",
      executionState: "committed",
    });
    expect(completed.timers[1]?.cancelled).toBe(true);
    completed.signal.abort();
    expect(completed.activated).toHaveLength(1);

    const failed = makeFixture();
    await failed.appendToolCall();
    const failedCompletion = failed.exchange.request(failed.request);
    await failed.pendingEntered;
    failed.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(failedCompletion).resolves.toMatchObject({ kind: "approved" });
    await failed.exchange.recordExecution("run-1", "call-1", "failed");
    expect(failed.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "consumed",
      executionState: "failed",
    });
    expect(failed.activated).toEqual([]);

    const expired = makeFixture();
    await expired.appendToolCall();
    const expiredCompletion = expired.exchange.request(expired.request);
    await expired.pendingEntered;
    expired.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(expiredCompletion).resolves.toMatchObject({
      kind: "approved",
    });
    expect(expired.timers[1]?.ms).toBe(60_000);
    expired.timers[1]?.callback();
    expect(expired.activated).toEqual([]);
    expect(expired.timers[1]?.cancelled).toBe(true);
  });

  it("rejects duplicate requests and a second answer", async () => {
    const f = makeFixture();
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;

    await expect(f.exchange.request(f.request)).resolves.toEqual({
      kind: "refused",
      reason: "duplicate",
    });
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "rejected",
      }),
    ).toBe("accepted");
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("unknown");
    await expect(completion).resolves.toEqual({ kind: "rejected" });
    expect(f.dependencies.prepareCapability).not.toHaveBeenCalled();
    expect(f.activated).toEqual([]);
    expect(f.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "awaiting_approval",
      executionState: "failed",
    });
  });

  it("keeps waiting after sender or project mismatches", async () => {
    const f = makeFixture();
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;

    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 12,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("mismatch");
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-2",
        decision: "approved",
      }),
    ).toBe("mismatch");
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "invalid" as never,
      }),
    ).toBe("unknown");
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("accepted");
    await expect(completion).resolves.toMatchObject({ kind: "approved" });
  });

  it("refuses unprotected, policy-off, unsupported, and already-aborted requests before opening", async () => {
    const unprotected = makeFixture({ toolName: "propose_scene_body" });
    await expect(
      unprotected.exchange.request(unprotected.request),
    ).resolves.toEqual({ kind: "refused", reason: "not_protected" });

    const policyOff = makeFixture({ isPolicyAllowed: vi.fn(() => false) });
    await policyOff.appendToolCall();
    const policyOpen = vi.spyOn(policyOff.port, "openApproval");
    await expect(
      policyOff.exchange.request(policyOff.request),
    ).resolves.toEqual({
      kind: "refused",
      reason: "policy",
    });
    expect(policyOpen).not.toHaveBeenCalled();

    const unsupported = makeFixture({ inputDigest: vi.fn(() => null) });
    await unsupported.appendToolCall();
    const unsupportedOpen = vi.spyOn(unsupported.port, "openApproval");
    await expect(
      unsupported.exchange.request(unsupported.request),
    ).resolves.toEqual({ kind: "refused", reason: "input_unsupported" });
    expect(unsupportedOpen).not.toHaveBeenCalled();

    const aborted = makeFixture();
    aborted.signal.abort();
    await expect(aborted.exchange.request(aborted.request)).resolves.toEqual({
      kind: "aborted",
    });

    const missingObserved = makeFixture();
    await missingObserved.appendToolCall();
    const missingObservedOpen = vi.spyOn(missingObserved.port, "openApproval");
    const requestWithoutObserved = { ...missingObserved.request };
    Reflect.deleteProperty(requestWithoutObserved, "observed");
    await expect(
      missingObserved.exchange.request(requestWithoutObserved),
    ).resolves.toEqual({ kind: "refused", reason: "input_unsupported" });
    expect(missingObservedOpen).not.toHaveBeenCalled();
  });

  it.each(["basis", "baseVersions", "expected"] as const)(
    "refuses when the observed target %s changes before opening",
    async (changed) => {
      const observed = {
        basis: defaultTarget.basis,
        baseVersions: defaultTarget.baseVersions,
        expected: defaultTarget.expected,
      };
      const freshTarget: AgentApprovalTarget = {
        ...defaultTarget,
        ...(changed === "basis"
          ? {
              basis: [
                { sourceKind: "event", sourceId: "event-1", version: "v2" },
              ],
            }
          : changed === "baseVersions"
            ? { baseVersions: [{ id: "event-1", version: 8 }] }
            : {
                expected: {
                  kind: "event_relation",
                  related: true,
                  causeVersion: 1,
                  effectVersion: 1,
                },
              }),
      };
      const f = makeFixture({
        observed,
        readTarget: vi.fn(() => freshTarget),
      });
      await f.appendToolCall();
      const openApproval = vi.spyOn(f.port, "openApproval");
      await expect(f.exchange.request(f.request)).resolves.toEqual({
        kind: "refused",
        reason: "target_changed",
      });
      expect(openApproval).not.toHaveBeenCalled();
      expect(f.dependencies.onPending).not.toHaveBeenCalled();
    },
  );

  it("opens for a scene link whose incarnation is the pre-schema-16 empty string", async () => {
    const target: AgentApprovalTarget = {
      summary: "Unlink scene s1 from event e1",
      basis: [
        { sourceKind: "scene_event_link", sourceId: "s1:e1", contentHash: "h" },
      ],
      baseVersions: null,
      expected: {
        kind: "scene_event_link",
        linkIncarnation: "",
        eventVersion: 3,
      },
    };
    const f = makeFixture({
      toolName: "unstamp_scene_event",
      input: { sceneId: "s1", eventId: "e1" },
      target,
    });
    await f.appendToolCall();
    const openApproval = vi.spyOn(f.port, "openApproval");
    void f.exchange.request(f.request);
    await vi.waitFor(() => expect(openApproval).toHaveBeenCalledTimes(1));
  });

  it("refuses a stale model baseVersion and tools without a versioned target", async () => {
    const target: AgentApprovalTarget = {
      summary: "Update foreshadow f1",
      basis: [{ sourceKind: "foreshadow", sourceId: "f1", version: "v3" }],
      baseVersions: [{ id: "f1", version: 3 }],
      expected: null,
    };
    const stale = makeFixture({
      toolName: "update_foreshadow",
      input: { id: "f1", baseVersion: 2, title: "Updated" },
      target,
    });
    await stale.appendToolCall();
    const staleOpen = vi.spyOn(stale.port, "openApproval");
    await expect(stale.exchange.request(stale.request)).resolves.toEqual({
      kind: "refused",
      reason: "model_version_mismatch",
    });
    expect(staleOpen).not.toHaveBeenCalled();

    const missing = makeFixture({
      toolName: "update_foreshadow",
      input: { id: "f1", baseVersion: 3, title: "Updated" },
      target: { ...target, baseVersions: null },
    });
    await missing.appendToolCall();
    const missingOpen = vi.spyOn(missing.port, "openApproval");
    await expect(missing.exchange.request(missing.request)).resolves.toEqual({
      kind: "refused",
      reason: "version_missing",
    });
    expect(missingOpen).not.toHaveBeenCalled();
  });

  it.each([
    ["update_codex_entry", { id: "entry-1", summary: "Updated" }],
    ["update_event", { eventId: "event-1", title: "Updated" }],
    ["delete_event", { eventId: "event-1" }],
    ["set_event_participants", { eventId: "event-1", codexEntryIds: [] }],
    [
      "apply_ai_tree_plan",
      {
        kind: "reorganize",
        ops: [{ op: "rename", nodeId: "node-1", title: "Updated" }],
      },
    ],
  ] as const)("requires a readable version for %s", async (toolName, input) => {
    const f = makeFixture({
      toolName,
      input,
      target: { ...defaultTarget, baseVersions: null },
    });
    await f.appendToolCall();
    const openApproval = vi.spyOn(f.port, "openApproval");
    await expect(f.exchange.request(f.request)).resolves.toEqual({
      kind: "refused",
      reason: "version_missing",
    });
    expect(openApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["move only", [{ op: "move", nodeId: "node-1" }], false],
    [
      "create and move",
      [{ op: "create" }, { op: "move", nodeId: "node-1" }],
      false,
    ],
    [
      "create and rename",
      [{ op: "create" }, { op: "rename", nodeId: "node-1" }],
      false,
    ],
    ["unknown op", [{ op: "delete", nodeId: "node-1" }], false],
    ["rename without nodeId", [{ op: "rename" }], false],
    ["empty ops", [], false],
    ["create only", [{ op: "create" }], true],
  ] as const)("tree plan version rule: %s", async (_label, ops, accepted) => {
    const target: AgentApprovalTarget = {
      summary: "Apply tree plan",
      basis: null,
      baseVersions: null,
      expected: null,
    };
    const f = makeFixture({
      toolName: "apply_ai_tree_plan",
      input: { kind: "scaffold", ops },
      target,
    });
    await f.appendToolCall();
    const openApproval = vi.spyOn(f.port, "openApproval");
    const completion = f.exchange.request(f.request);
    if (!accepted) {
      await expect(completion).resolves.toMatchObject({ kind: "refused" });
      expect(openApproval).not.toHaveBeenCalled();
      return;
    }
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toMatchObject({ kind: "approved" });
  });

  it("supersedes changed input, disabled policy, or changed target basis", async () => {
    const changedDigest = vi
      .fn()
      .mockReturnValueOnce("digest-1")
      .mockReturnValueOnce("digest-2");
    const changedInput = makeFixture({ inputDigest: changedDigest });
    await changedInput.appendToolCall();
    const changedInputCompletion = changedInput.exchange.request(
      changedInput.request,
    );
    await changedInput.pendingEntered;
    changedInput.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(changedInputCompletion).resolves.toEqual({
      kind: "superseded",
    });
    expect(changedInput.port.readInteraction("interaction-1")?.status).toBe(
      "superseded",
    );
    expect(changedInput.dependencies.prepareCapability).not.toHaveBeenCalled();
    expect(changedInput.activated).toEqual([]);

    const policy = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const changedPolicy = makeFixture({ isPolicyAllowed: policy });
    await changedPolicy.appendToolCall();
    const changedPolicyCompletion = changedPolicy.exchange.request(
      changedPolicy.request,
    );
    await changedPolicy.pendingEntered;
    changedPolicy.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(changedPolicyCompletion).resolves.toEqual({
      kind: "superseded",
    });
    expect(changedPolicy.dependencies.prepareCapability).not.toHaveBeenCalled();
    expect(changedPolicy.activated).toEqual([]);

    const target = vi
      .fn()
      .mockReturnValueOnce(defaultTarget)
      .mockReturnValueOnce({
        ...defaultTarget,
        basis: [{ sourceKind: "event", sourceId: "event-1", version: "v2" }],
      });
    const changedBasis = makeFixture({ readTarget: target });
    await changedBasis.appendToolCall();
    const changedBasisCompletion = changedBasis.exchange.request(
      changedBasis.request,
    );
    await changedBasis.pendingEntered;
    changedBasis.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(changedBasisCompletion).resolves.toEqual({
      kind: "superseded",
    });
    expect(changedBasis.dependencies.prepareCapability).not.toHaveBeenCalled();
    expect(changedBasis.activated).toEqual([]);
    expect(changedBasis.port.readToolCall("run-1", "call-1")).toMatchObject({
      executionState: "failed",
    });
  });

  it("requires bodyWrite for synopsis plans before opening and again on approval", async () => {
    const input = {
      kind: "reorganize",
      ops: [
        {
          op: "create",
          tempId: "tmp:scene-1",
          parentRef: null,
          nodeType: "scene",
          title: "Scene",
          synopsis: "A short synopsis",
        },
        { op: "rename", nodeId: "node-1", title: "Renamed" },
      ],
    };
    const target: AgentApprovalTarget = {
      summary: "Apply the tree plan",
      basis: [{ sourceKind: "tree_node", sourceId: "node-1", version: "v1" }],
      baseVersions: [{ id: "node-1", version: 1 }],
      expected: null,
    };
    const policyOff = makeFixture({
      toolName: "apply_ai_tree_plan",
      input,
      target,
      isPolicyAllowed: vi.fn(
        (_request, additionalPolicy) => additionalPolicy !== "bodyWrite",
      ),
    });
    await policyOff.appendToolCall();
    const policyOffOpen = vi.spyOn(policyOff.port, "openApproval");
    await expect(
      policyOff.exchange.request(policyOff.request),
    ).resolves.toEqual({ kind: "refused", reason: "policy" });
    expect(policyOffOpen).not.toHaveBeenCalled();

    let bodyWriteChecks = 0;
    const policy: AgentApprovalExchangeDependencies<TestGrant>["isPolicyAllowed"] =
      (_request, additionalPolicy) =>
        additionalPolicy !== "bodyWrite" || ++bodyWriteChecks === 1;
    const turnsOffWhilePending = makeFixture({
      toolName: "apply_ai_tree_plan",
      input,
      target,
      isPolicyAllowed: policy,
    });
    await turnsOffWhilePending.appendToolCall();
    const completion = turnsOffWhilePending.exchange.request(
      turnsOffWhilePending.request,
    );
    await turnsOffWhilePending.pendingEntered;
    turnsOffWhilePending.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toEqual({ kind: "superseded" });
    expect(
      turnsOffWhilePending.port.readInteraction("interaction-1")?.status,
    ).toBe("superseded");
  });

  it("compares basis independent of order and refuses unreadable targets before opening", async () => {
    const reorderedTarget = vi
      .fn()
      .mockReturnValueOnce({
        ...defaultTarget,
        basis: [
          { sourceKind: "event", sourceId: "event-2", version: "v2" },
          { sourceKind: "event", sourceId: "event-1", version: "v1" },
        ],
      })
      .mockReturnValueOnce({
        ...defaultTarget,
        basis: [
          { sourceKind: "event", sourceId: "event-1", version: "v1" },
          { sourceKind: "event", sourceId: "event-2", version: "v2" },
        ],
      });
    const reordered = makeFixture({
      input: { eventId: "event-1", title: "Updated" },
      observed: {
        basis: [
          { sourceKind: "event", sourceId: "event-2", version: "v2" },
          { sourceKind: "event", sourceId: "event-1", version: "v1" },
        ],
        baseVersions: defaultTarget.baseVersions,
        expected: defaultTarget.expected,
      },
      readTarget: reorderedTarget,
    });
    await reordered.appendToolCall();
    const reorderedCompletion = reordered.exchange.request(reordered.request);
    await reordered.pendingEntered;
    reordered.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(reorderedCompletion).resolves.toMatchObject({
      kind: "approved",
    });

    const unreadable = makeFixture({ target: null });
    await unreadable.appendToolCall();
    const openApproval = vi.spyOn(unreadable.port, "openApproval");
    await expect(
      unreadable.exchange.request(unreadable.request),
    ).resolves.toEqual({
      kind: "refused",
      reason: "target_unreadable",
    });
    expect(openApproval).not.toHaveBeenCalled();
    expect(unreadable.dependencies.onPending).not.toHaveBeenCalled();
  });

  it("refuses malformed target shapes instead of rejecting the request", async () => {
    const f = makeFixture({
      readTarget: vi.fn(() => ({
        ...defaultTarget,
        basis: {} as unknown as AgentApprovalTarget["basis"],
      })),
    });
    await f.appendToolCall();
    await expect(f.exchange.request(f.request)).resolves.toEqual({
      kind: "refused",
      reason: "target_changed",
    });
  });

  it("does not activate when the issued ledger record fails", async () => {
    const f = makeFixture();
    const updateToolCall = vi
      .spyOn(f.port, "updateToolCall")
      .mockImplementation(async (runId, toolCallId, update) => {
        if (update.capabilityState === "issued")
          throw new Error("ledger write failed");
        return FakeAgentRunApprovalPort.prototype.updateToolCall.call(
          f.port,
          runId,
          toolCallId,
          update,
        );
      });
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toEqual({
      kind: "refused",
      reason: "port_failed",
    });
    expect(f.activated).toEqual([]);
    expect(updateToolCall).toHaveBeenCalled();
  });

  it("keeps the Run handle version aligned when failed-ledger writing fails", async () => {
    const changedTarget = vi
      .fn()
      .mockReturnValueOnce(defaultTarget)
      .mockReturnValueOnce({
        ...defaultTarget,
        basis: [{ sourceKind: "event", sourceId: "event-1", version: "v2" }],
      });
    const f = makeFixture({ readTarget: changedTarget });
    await f.appendToolCall();
    const updateToolCall = vi
      .spyOn(f.port, "updateToolCall")
      .mockImplementation(async (runId, toolCallId, update) => {
        if (update.executionState === "failed")
          throw new Error("ledger write failed");
        return FakeAgentRunApprovalPort.prototype.updateToolCall.call(
          f.port,
          runId,
          toolCallId,
          update,
        );
      });
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toEqual({
      kind: "refused",
      reason: "port_failed",
    });
    expect(updateToolCall).toHaveBeenCalled();
    expect(f.runVersion).toBe(f.port.readRun("run-1").version);
  });

  it("keeps the Run handle version aligned when Stop aborts immediately after invalidation", async () => {
    const changedTarget = vi
      .fn()
      .mockReturnValueOnce(defaultTarget)
      .mockReturnValueOnce({
        ...defaultTarget,
        basis: [{ sourceKind: "event", sourceId: "event-1", version: "v2" }],
      });
    const f = makeFixture({ readTarget: changedTarget });
    await f.appendToolCall();
    const invalidateApproval = vi
      .spyOn(f.port, "invalidateApproval")
      .mockImplementation(async (input) => {
        const state =
          await FakeAgentRunApprovalPort.prototype.invalidateApproval.call(
            f.port,
            input,
          );
        f.signal.abort();
        return state;
      });
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toEqual({ kind: "aborted" });
    expect(invalidateApproval).toHaveBeenCalledOnce();
    expect(f.runVersion).toBe(f.port.readRun("run-1").version);
  });

  it("keeps the request active while approval finishing is in progress", async () => {
    const approvalPolicyEntered = deferred<void>();
    const resumeApprovalPolicy = deferred<boolean>();
    const policy = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        approvalPolicyEntered.resolve();
        return resumeApprovalPolicy.promise;
      });
    const f = makeFixture({ isPolicyAllowed: policy });
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await approvalPolicyEntered.promise;
    await expect(f.exchange.request(f.request)).resolves.toEqual({
      kind: "refused",
      reason: "duplicate",
    });
    resumeApprovalPolicy.resolve(true);
    await expect(completion).resolves.toMatchObject({ kind: "approved" });
  });

  it("settles stop before a late answer and stop during approval without activating", async () => {
    const stopped = makeFixture();
    await stopped.appendToolCall();
    const stoppedCompletion = stopped.exchange.request(stopped.request);
    await stopped.pendingEntered;
    stopped.port.stopRun("run-1");
    stopped.signal.abort();
    await expect(stoppedCompletion).resolves.toEqual({ kind: "aborted" });
    expect(
      stopped.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("unknown");
    expect(stopped.timers[0]?.cancelled).toBe(true);

    const policyEntered = deferred<void>();
    const resumePolicy = deferred<boolean>();
    const policy = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => {
        policyEntered.resolve();
        return resumePolicy.promise;
      });
    const duringApproval = makeFixture({ isPolicyAllowed: policy });
    await duringApproval.appendToolCall();
    const duringApprovalCompletion = duringApproval.exchange.request(
      duringApproval.request,
    );
    await duringApproval.pendingEntered;
    duringApproval.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await policyEntered.promise;
    duringApproval.port.stopRun("run-1");
    duringApproval.signal.abort();
    resumePolicy.resolve(true);
    await expect(duringApprovalCompletion).resolves.toEqual({
      kind: "aborted",
    });
    expect(duringApproval.activated).toEqual([]);
  });

  it.each(["decideApproval", "issued ledger write"] as const)(
    "does not activate when abort arrives during %s",
    async (stage) => {
      const entered = deferred<void>();
      const resume = deferred<void>();
      const f = makeFixture();
      await f.appendToolCall();
      if (stage === "decideApproval") {
        vi.spyOn(f.port, "decideApproval").mockImplementation(async (input) => {
          const state =
            await FakeAgentRunApprovalPort.prototype.decideApproval.call(
              f.port,
              input,
            );
          entered.resolve();
          await resume.promise;
          return state;
        });
      } else {
        vi.spyOn(f.port, "updateToolCall").mockImplementation(
          async (runId, toolCallId, update) => {
            const state =
              await FakeAgentRunApprovalPort.prototype.updateToolCall.call(
                f.port,
                runId,
                toolCallId,
                update,
              );
            if (update.capabilityState === "issued") {
              entered.resolve();
              await resume.promise;
            }
            return state;
          },
        );
      }
      const completion = f.exchange.request(f.request);
      await f.pendingEntered;
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      });
      await entered.promise;
      f.signal.abort();
      resume.resolve();
      await expect(completion).resolves.toEqual({ kind: "aborted" });
      expect(f.activated).toEqual([]);
    },
  );

  it.each(["workspace switch", "quit"] as const)(
    "leaves the nonterminal approval pending on %s without more port calls",
    async () => {
      const f = makeFixture();
      await f.appendToolCall();
      const completion = f.exchange.request(f.request);
      await f.pendingEntered;
      const decide = vi.spyOn(f.port, "decideApproval");
      const invalidate = vi.spyOn(f.port, "invalidateApproval");
      const update = vi.spyOn(f.port, "updateToolCall");
      f.signal.abort();
      await expect(completion).resolves.toEqual({ kind: "aborted" });
      expect(f.port.readRun("run-1").status).toBe("waiting_approval");
      expect(f.port.readInteraction("interaction-1")?.status).toBe("pending");
      expect(decide).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(f.port.readToolCall("run-1", "call-1")).toMatchObject({
        capabilityState: "awaiting_approval",
        executionState: "pending",
      });
    },
  );

  it("treats changes to content hashes and basis length as superseded", async () => {
    for (const basis of [
      [{ sourceKind: "event", sourceId: "event-1", contentHash: "hash-2" }],
      [
        { sourceKind: "event", sourceId: "event-1", version: "v1" },
        { sourceKind: "event", sourceId: "event-2", version: "v2" },
      ],
    ] as const) {
      const readTarget = vi
        .fn<AgentApprovalExchangeDependencies<TestGrant>["readTarget"]>()
        .mockReturnValueOnce(defaultTarget)
        .mockReturnValueOnce({ ...defaultTarget, basis });
      const f = makeFixture({ readTarget });
      await f.appendToolCall();
      const completion = f.exchange.request(f.request);
      await f.pendingEntered;
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      });
      await expect(completion).resolves.toEqual({ kind: "superseded" });
      expect(f.dependencies.prepareCapability).not.toHaveBeenCalled();
      expect(f.activated).toEqual([]);
    }
  });

  it("supersedes if the approval policy throws and refuses an unpreparable grant", async () => {
    const policy = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("policy unavailable");
      });
    const f = makeFixture({ isPolicyAllowed: policy });
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toEqual({ kind: "superseded" });
    expect(f.dependencies.prepareCapability).not.toHaveBeenCalled();
    expect(f.activated).toEqual([]);

    for (const prepareCapability of [
      vi.fn(() => null),
      vi.fn(() => {
        throw new Error("prepare failed");
      }),
    ]) {
      const unprepared = makeFixture({ prepareCapability });
      await unprepared.appendToolCall();
      const pending = unprepared.exchange.request(unprepared.request);
      await unprepared.pendingEntered;
      unprepared.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      });
      await expect(pending).resolves.toEqual({
        kind: "refused",
        reason: "port_failed",
      });
      expect(unprepared.activated).toEqual([]);
      expect(unprepared.port.readToolCall("run-1", "call-1")).toMatchObject({
        capabilityState: "awaiting_approval",
        executionState: "pending",
      });
    }
  });

  it("prepares the frozen request snapshot with the approval-time target", async () => {
    const input = { eventId: "event-1", title: "original" };
    const initialTarget: AgentApprovalTarget = {
      ...defaultTarget,
      basis: [
        ...defaultTarget.basis!,
        { sourceKind: "event", sourceId: "event-2", version: "v2" },
      ],
      baseVersions: [
        { id: "event-1", version: 7 },
        { id: "event-2", version: 9 },
      ],
    };
    const approvalTarget: AgentApprovalTarget = {
      ...initialTarget,
      baseVersions: [...initialTarget.baseVersions!].reverse(),
    };
    const readTarget = vi
      .fn<AgentApprovalExchangeDependencies<TestGrant>["readTarget"]>()
      .mockReturnValueOnce(initialTarget)
      .mockReturnValueOnce(approvalTarget);
    const f = makeFixture({ input, target: initialTarget, readTarget });
    await f.appendToolCall();
    const prepare = vi.spyOn(f.dependencies, "prepareCapability");
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    input.title = "mutated while waiting";
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toMatchObject({ kind: "approved" });
    expect(prepare).toHaveBeenCalledOnce();
    const [preparedRequest, preparedTarget] = prepare.mock.calls[0]!;
    expect(preparedRequest.modelInput).toEqual({
      eventId: "event-1",
      title: "original",
    });
    expect(Object.isFrozen(preparedRequest.modelInput)).toBe(true);
    expect(preparedTarget.baseVersions).toEqual(approvalTarget.baseVersions);
  });

  it.each(["decision failure", "closed interaction"] as const)(
    "refuses without preparing a capability after %s",
    async (failure) => {
      const f = makeFixture();
      await f.appendToolCall();
      const prepare = vi.spyOn(f.dependencies, "prepareCapability");
      const completion = f.exchange.request(f.request);
      await f.pendingEntered;
      if (failure === "decision failure") {
        vi.spyOn(f.port, "decideApproval").mockRejectedValueOnce(
          new Error("decision failed"),
        );
      } else {
        await f.request.run.transact((expectedVersion) =>
          FakeAgentRunApprovalPort.prototype.decideApproval.call(f.port, {
            runId: f.request.run.runId,
            expectedVersion,
            interactionId: "interaction-1",
            interactionVersion: 0,
            decision: "rejected",
          }),
        );
      }
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      });
      await expect(completion).resolves.toEqual({
        kind: "refused",
        reason: "port_failed",
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(f.activated).toEqual([]);
    },
  );

  it.each(["null", "throws", "null basis"] as const)(
    "supersedes without activation when approval target %s",
    async (change) => {
      const readTarget = vi
        .fn<AgentApprovalExchangeDependencies<TestGrant>["readTarget"]>()
        .mockReturnValueOnce(defaultTarget);
      if (change === "null") readTarget.mockReturnValueOnce(null);
      else if (change === "throws")
        readTarget.mockImplementationOnce(() => {
          throw new Error("target read failed");
        });
      else readTarget.mockReturnValueOnce({ ...defaultTarget, basis: null });
      const f = makeFixture({ readTarget });
      await f.appendToolCall();
      const prepare = vi.spyOn(f.dependencies, "prepareCapability");
      const completion = f.exchange.request(f.request);
      await f.pendingEntered;
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      });
      await expect(completion).resolves.toEqual({ kind: "superseded" });
      expect(prepare).not.toHaveBeenCalled();
      expect(f.activated).toEqual([]);
    },
  );

  it.each(["timer", "pending"] as const)(
    "invalidates the opened interaction when %s setup fails",
    async (failure) => {
      const f = makeFixture({
        ...(failure === "timer"
          ? {
              setTimer: vi.fn(() => {
                throw new Error("timer failed");
              }),
            }
          : {
              onPending: vi.fn(() => {
                throw new Error("notify failed");
              }),
            }),
      });
      await f.appendToolCall();
      await expect(f.exchange.request(f.request)).resolves.toEqual({
        kind: "refused",
        reason: "port_failed",
      });
      expect(f.port.readRun("run-1")).toMatchObject({
        status: "running",
        version: 2,
      });
      expect(f.runVersion).toBe(f.port.readRun("run-1").version);
      expect(f.port.readInteraction("interaction-1")?.status).toBe(
        "superseded",
      );
    },
  );

  it("marks the ledger failed when the post-approval capability timer throws", async () => {
    let calls = 0;
    const f = makeFixture({
      setTimer: vi.fn((_ms, _callback) => {
        if (++calls === 2) throw new Error("capability timer failed");
        return () => {};
      }),
    });
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toMatchObject({
      kind: "refused",
      reason: "port_failed",
    });
    expect(f.activated).toEqual([]);
    expect(f.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "issued",
      executionState: "failed",
    });
  });

  it("returns aborted when updateToolCall fails after the signal aborts", async () => {
    const f = makeFixture();
    await f.appendToolCall();
    const originalUpdate = f.port.updateToolCall.bind(f.port);
    const update = vi
      .spyOn(f.port, "updateToolCall")
      .mockImplementation(async (runId, toolCallId, value) => {
        if (value.capabilityState === "issued") {
          f.signal.abort();
          throw new Error("port stopped");
        }
        return originalUpdate(runId, toolCallId, value);
      });
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toEqual({
      kind: "aborted",
    });
    expect(update).toHaveBeenCalled();
  });

  it("skips pending notification when the wait settles during timer setup", async () => {
    const control: { exchange?: TestExchange } = {};
    const f = makeFixture({
      setTimer: (ms) => {
        if (ms === 1_800_000) {
          control.exchange?.resolve({
            interactionId: "interaction-1",
            senderId: 11,
            projectId: "project-1",
            decision: "approved",
          });
        }
        return () => {};
      },
    });
    control.exchange = f.exchange;
    await f.appendToolCall();
    await expect(f.exchange.request(f.request)).resolves.toMatchObject({
      kind: "approved",
    });
    expect(f.dependencies.onPending).not.toHaveBeenCalled();
  });

  it("times out after 30 minutes, interrupts the run, and leaves the interaction pending", async () => {
    const f = makeFixture();
    await f.appendToolCall();
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    expect(AGENT_APPROVAL_WAIT_TIMEOUT_MS).toBe(1_800_000);
    expect(f.timers[0]?.ms).toBe(AGENT_APPROVAL_WAIT_TIMEOUT_MS);
    f.fireTimer();
    await expect(completion).resolves.toEqual({ kind: "timeout" });
    expect(f.port.readRun("run-1").status).toBe("interrupted");
    expect(f.port.readInteraction("interaction-1")?.status).toBe("pending");
    expect(f.dependencies.prepareCapability).not.toHaveBeenCalled();
    expect(f.activated).toEqual([]);
    expect(f.port.readToolCall("run-1", "call-1")).toMatchObject({
      capabilityState: "awaiting_approval",
      executionState: "pending",
    });
    expect(f.timers[0]?.cancelled).toBe(true);
    expect(
      f.exchange.resolve({
        interactionId: "interaction-1",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("unknown");
  });

  it("refuses an oversized UTF-8 summary without truncating or opening", async () => {
    const f = makeFixture({
      target: {
        ...defaultTarget,
        summary: `${"x".repeat(65_533)}😀`,
      },
    });
    await f.appendToolCall();
    const openApproval = vi.spyOn(f.port, "openApproval");
    await expect(f.exchange.request(f.request)).resolves.toEqual({
      kind: "refused",
      reason: "request_too_large",
    });
    expect(openApproval).not.toHaveBeenCalled();
    expect(f.dependencies.onPending).not.toHaveBeenCalled();
  });

  it("does not issue from a saved approved interaction without a live request", async () => {
    const f = makeFixture();
    await f.appendToolCall();
    const opened = await f.request.run.transact((expectedVersion) =>
      f.port.openApproval({
        runId: f.request.run.runId,
        expectedVersion,
        interactionId: "saved-interaction",
        toolCallId: f.request.toolCallId,
        toolName: f.request.toolName,
        argsDigest: "digest-1",
        request: "Saved approved request",
        targetBasis: defaultTarget.basis,
      }),
    );
    await f.request.run.transact((expectedVersion) =>
      f.port.decideApproval({
        runId: f.request.run.runId,
        expectedVersion,
        interactionId: "saved-interaction",
        interactionVersion: opened.interactionVersion,
        decision: "approved",
      }),
    );
    expect(
      f.exchange.resolve({
        interactionId: "saved-interaction",
        senderId: 11,
        projectId: "project-1",
        decision: "approved",
      }),
    ).toBe("unknown");
    expect(f.activated).toEqual([]);
    const completion = f.exchange.request(f.request);
    await f.pendingEntered;
    expect(f.activated).toEqual([]);
    f.exchange.resolve({
      interactionId: "interaction-1",
      senderId: 11,
      projectId: "project-1",
      decision: "approved",
    });
    await expect(completion).resolves.toMatchObject({ kind: "approved" });
    expect(f.activated).toHaveLength(1);
    await expect(f.exchange.request(f.request)).resolves.toEqual({
      kind: "refused",
      reason: "port_failed",
    });
    expect(f.activated).toHaveLength(1);
  });
});
