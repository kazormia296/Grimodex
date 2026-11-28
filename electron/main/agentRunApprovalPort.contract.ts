import { describe, expect, it } from "vitest";
import type {
  AgentRunApprovalPort,
  AgentRunLedgerEntry,
  AgentRunState,
  AgentRunToolCallKey,
} from "./agentRunRecorderPort.js";
import type { AgentRunInteractionStatus } from "../shared/agentRunTypes.js";
import { parseAgentRunErrorCode } from "../shared/agentRunTypes.js";

export interface AgentRunApprovalPortHarness {
  readonly port: AgentRunApprovalPort;
  createRunningRun(runId: string, rootRunId?: string): AgentRunState;
  readRun(runId: string): AgentRunState;
  stopRun(runId: string): AgentRunState;
  interrupt(runId: string, expectedVersion: number): Promise<AgentRunState>;
  readInteraction(interactionId: string): {
    readonly status: AgentRunInteractionStatus;
    readonly request: string;
    readonly resolution: string;
  } | null;
  readToolCall(
    runId: string,
    key: AgentRunToolCallKey,
  ): AgentRunLedgerEntry | null;
}

export function describeAgentRunApprovalPortContract(
  name: string,
  makeHarness: () => AgentRunApprovalPortHarness,
): void {
  describe(name, () => {
    const seededRuns = new WeakMap<object, Set<string>>();
    const open = async (
      h: AgentRunApprovalPortHarness,
      runId: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const input = {
        runId,
        expectedVersion: 0,
        interactionId: `interaction-${runId}`,
        executionId: "e",
        toolCallId: "tool-call-1",
        toolName: "update_entry",
        argsDigest: "digest",
        request: "Apply the proposed change?",
        targetBasis: null,
        ...overrides,
      } as Parameters<AgentRunApprovalPort["openApproval"]>[0];
      let runIds = seededRuns.get(h.port);
      if (!runIds) seededRuns.set(h.port, (runIds = new Set()));
      if (!runIds.has(runId) && !h.readToolCall(runId, input)) {
        runIds.add(runId);
        try {
          await h.port.appendToolCalls(runId, [ledgerEntry(input)]);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/AGENT_RUN_(NOT_FOUND|TERMINAL)/u.test(error.message)
          )
            throw error;
        }
      }
      return h.port.openApproval(input);
    };
    const ledgerEntry = (
      input: Pick<
        Parameters<AgentRunApprovalPort["openApproval"]>[0],
        "executionId" | "toolCallId" | "toolName" | "argsDigest"
      >,
    ): AgentRunLedgerEntry => ({
      ...input,
      name: input.toolName,
      canonicalArgs: {},
      chatMessageId: "message",
      mainOwnedProvenanceId: "",
      model: "model",
      capabilityState: "not_issued",
      executionState: "pending",
    });
    const expectCode = async (promise: Promise<unknown>, code: string) => {
      let error: unknown;
      try {
        await promise;
      } catch (caught) {
        error = caught;
      }
      expect(parseAgentRunErrorCode(error)).toBe(code);
    };
    const expectRejected = async (promise: Promise<unknown>) => {
      await expect(promise).rejects.toBeDefined();
    };

    it("opens, decides, and invalidates with Native statuses and version increments", async () => {
      const h = makeHarness();
      h.createRunningRun("decide");
      expect(await open(h, "decide")).toEqual({
        runId: "decide",
        version: 1,
        status: "waiting_approval",
        interactionVersion: 0,
      });
      expect(
        await h.port.decideApproval({
          runId: "decide",
          expectedVersion: 1,
          interactionId: "interaction-decide",
          interactionVersion: 0,
          decision: "approved",
        }),
      ).toEqual({ runId: "decide", version: 2, status: "running" });
      expect(h.readInteraction("interaction-decide")).toMatchObject({
        status: "resolved",
        request: "Apply the proposed change?",
        resolution: "approved",
      });

      h.createRunningRun("invalidate");
      await open(h, "invalidate");
      expect(
        await h.port.invalidateApproval({
          runId: "invalidate",
          expectedVersion: 1,
          interactionId: "interaction-invalidate",
          interactionVersion: 0,
          outcome: "superseded",
        }),
      ).toEqual({ runId: "invalidate", version: 2, status: "running" });
      expect(h.readInteraction("interaction-invalidate")).toMatchObject({
        status: "superseded",
        request: "Apply the proposed change?",
        resolution: "",
      });
    });

    it("rejects an approval whose tool call has no ledger row", async () => {
      const h = makeHarness();
      h.createRunningRun("unknown-tool-call");
      await expectCode(
        h.port.openApproval({
          runId: "unknown-tool-call",
          expectedVersion: 0,
          interactionId: "interaction-unknown-tool-call",
          executionId: "e",
          toolCallId: "missing",
          toolName: "update_entry",
          argsDigest: "digest",
          request: "Apply?",
          targetBasis: null,
        }),
        "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
      );
    });

    it("requires the expected run and interaction versions and statuses", async () => {
      const h = makeHarness();
      h.createRunningRun("cas");
      await expectCode(
        open(h, "cas", { expectedVersion: 1 }),
        "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
      );
      await open(h, "cas");
      await expectCode(
        h.port.decideApproval({
          runId: "cas",
          expectedVersion: 0,
          interactionId: "interaction-cas",
          interactionVersion: 0,
          decision: "rejected",
        }),
        "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
      );
      await expectCode(
        h.port.decideApproval({
          runId: "cas",
          expectedVersion: 1,
          interactionId: "interaction-cas",
          interactionVersion: 1,
          decision: "rejected",
        }),
        "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
      );
    });

    it("rejects a second pending interaction, malformed basis, and oversized UTF-8 request", async () => {
      const h = makeHarness();
      h.createRunningRun("limits");
      await open(h, "limits");
      await expectCode(
        open(h, "limits", { expectedVersion: 1, interactionId: "second" }),
        "AGENT_RUN_PENDING_INTERACTION_EXISTS",
      );

      h.createRunningRun("basis");
      await expectCode(
        open(h, "basis", { targetBasis: [] }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      await expectCode(
        open(h, "basis", {
          targetBasis: Array.from({ length: 65 }, () => ({
            sourceKind: "entry",
            sourceId: "1",
            version: "v1",
          })),
        }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      await expectCode(
        open(h, "basis", {
          targetBasis: Array.from({ length: 64 }, () => ({
            sourceKind: "k".repeat(64),
            sourceId: "i".repeat(256),
            version: "v".repeat(256),
          })),
        }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      await expectCode(
        open(h, "basis", {
          targetBasis: [
            { sourceKind: "é".repeat(33), sourceId: "1", version: "v1" },
          ],
        }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      // Native rejects these ambiguous enum shapes during serde deserialization,
      // before it can attach an AGENT_RUN error code.
      await expectRejected(
        open(h, "basis", {
          targetBasis: [
            {
              sourceKind: "entry",
              sourceId: "1",
              version: "v1",
              contentHash: "hash",
            },
          ],
        }),
      );
      await expectRejected(
        open(h, "basis", {
          targetBasis: [{ sourceKind: "entry", sourceId: "1" }],
        }),
      );

      h.createRunningRun("request");
      await expectCode(
        open(h, "request", { request: "é".repeat(32_769) }),
        "AGENT_RUN_REQUEST_TOO_LARGE",
      );
    });

    it("keeps pending on approval timeout and cancels and scrubs it when the run stops", async () => {
      const h = makeHarness();
      h.createRunningRun("timeout");
      await open(h, "timeout");
      expect(await h.interrupt("timeout", 1)).toEqual({
        runId: "timeout",
        version: 2,
        status: "interrupted",
      });
      expect(h.readInteraction("interaction-timeout")).toMatchObject({
        status: "pending",
        request: "Apply the proposed change?",
      });
      expect(await h.port.getPendingApproval("timeout")).toMatchObject({
        interactionId: "interaction-timeout",
        version: 0,
      });

      h.createRunningRun("stop");
      await open(h, "stop");
      expect(h.stopRun("stop")).toEqual({
        runId: "stop",
        version: 3,
        status: "cancelled",
      });
      expect(h.readInteraction("interaction-stop")).toMatchObject({
        status: "cancelled",
        request: "",
      });
      expect(await h.port.getPendingApproval("stop")).toBeNull();
      expect(
        h.readToolCall("stop", {
          executionId: "e",
          toolCallId: "tool-call-1",
        }),
      ).toBeNull();
    });

    it("matches ledger rejection rules without incrementing run version", async () => {
      const h = makeHarness();
      h.createRunningRun("ledger");
      const entry = {
        toolCallId: "tool-call-1",
        name: "tool",
        canonicalArgs: {},
        argsDigest: "d",
        executionId: "e",
        chatMessageId: "m",
        mainOwnedProvenanceId: "",
        model: "model",
        capabilityState: "not_issued" as const,
        executionState: "pending" as const,
      };
      await h.port.appendToolCalls("ledger", [entry]);
      await expectCode(
        h.port.appendToolCalls("ledger", [entry]),
        "AGENT_RUN_DUPLICATE_TOOL_CALL_ID",
      );
      await expectCode(
        h.port.updateToolCall(
          "ledger",
          { executionId: "e", toolCallId: "missing" },
          {
            capabilityState: "issued",
          },
        ),
        "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
      );
      await h.port.updateToolCall(
        "ledger",
        { executionId: "e", toolCallId: "tool-call-1" },
        {
          capabilityState: "issued",
          executionState: "committed",
        },
      );
      await expectCode(
        h.port.updateToolCall(
          "ledger",
          { executionId: "e", toolCallId: "tool-call-1" },
          {
            capabilityState: "awaiting_approval",
          },
        ),
        "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
      );
      await expectCode(
        h.port.updateToolCall(
          "ledger",
          { executionId: "e", toolCallId: "tool-call-1" },
          {
            executionState: "failed",
          },
        ),
        "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
      );
      expect(h.readRun("ledger")).toEqual({
        runId: "ledger",
        version: 0,
        status: "running",
      });
    });

    it("validates batched ledger keys and blocks appends during a pending approval", async () => {
      const h = makeHarness();
      h.createRunningRun("batch");
      const first = ledgerEntry({
        executionId: "e",
        toolCallId: "same-id",
        toolName: "tool",
        argsDigest: "d",
      });
      await expectCode(
        h.port.appendToolCalls("batch", []),
        "AGENT_RUN_EMPTY_TOOL_CALL_BATCH",
      );
      await expectCode(
        h.port.appendToolCalls("batch", [{ ...first, toolCallId: "" }]),
        "AGENT_RUN_TOOL_CALL_ID_INVALID",
      );
      await expectCode(
        h.port.appendToolCalls("batch", [
          first,
          { ...first, executionId: "e2" },
        ]),
        "AGENT_RUN_TOOL_CALL_BATCH_EXECUTION_MISMATCH",
      );
      await h.port.appendToolCalls("batch", [first]);
      await expectCode(
        h.port.appendToolCalls("batch", [first]),
        "AGENT_RUN_DUPLICATE_TOOL_CALL_ID",
      );
      await open(h, "batch", {
        toolCallId: "same-id",
        toolName: "tool",
        argsDigest: "d",
      });
      await expectCode(
        h.port.appendToolCalls("batch", [
          { ...first, executionId: "different-execution" },
        ]),
        "AGENT_RUN_PENDING_INTERACTION_EXISTS",
      );
      h.createRunningRun("execution-scoped-keys");
      await h.port.appendToolCalls("execution-scoped-keys", [first]);
      await h.port.appendToolCalls("execution-scoped-keys", [
        { ...first, executionId: "e2" },
      ]);
    });

    it("rejects ledger appends after interruption but permits updates", async () => {
      const h = makeHarness();
      h.createRunningRun("interrupted-ledger");
      const entry = ledgerEntry({
        executionId: "e",
        toolCallId: "call",
        toolName: "tool",
        argsDigest: "d",
      });
      await h.port.appendToolCalls("interrupted-ledger", [entry]);
      await open(h, "interrupted-ledger", {
        toolCallId: "call",
        toolName: "tool",
        argsDigest: "d",
      });
      await h.interrupt("interrupted-ledger", 1);
      await expectCode(
        h.port.appendToolCalls("interrupted-ledger", [
          { ...entry, toolCallId: "later-call" },
        ]),
        "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
      );
      await h.port.updateToolCall(
        "interrupted-ledger",
        { executionId: "e", toolCallId: "call" },
        { executionState: "failed" },
      );
      expect(h.readToolCall("interrupted-ledger", entry)).toMatchObject({
        executionState: "failed",
      });
    });

    it("opens only the latest matching tool call row and exposes its execution ID", async () => {
      const h = makeHarness();
      h.createRunningRun("latest");
      await open(h, "latest");
      expect(await h.port.getPendingApproval("latest")).toMatchObject({
        executionId: "e",
        toolCallId: "tool-call-1",
      });
      await h.port.decideApproval({
        runId: "latest",
        expectedVersion: 1,
        interactionId: "interaction-latest",
        interactionVersion: 0,
        decision: "rejected",
      });
      await h.port.appendToolCalls("latest", [
        ledgerEntry({
          executionId: "e2",
          toolCallId: "tool-call-1",
          toolName: "update_entry",
          argsDigest: "digest",
        }),
      ]);
      await expectCode(
        open(h, "latest", {
          expectedVersion: 2,
          interactionId: "latest-again",
        }),
        "AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH",
      );
    });

    it("rejects approval when the latest tool name or input digest differs", async () => {
      const h = makeHarness();
      h.createRunningRun("tool-mismatch");
      await open(h, "tool-mismatch");
      await h.port.decideApproval({
        runId: "tool-mismatch",
        expectedVersion: 1,
        interactionId: "interaction-tool-mismatch",
        interactionVersion: 0,
        decision: "rejected",
      });
      await expectCode(
        open(h, "tool-mismatch", {
          expectedVersion: 2,
          interactionId: "wrong-digest",
          argsDigest: "different",
        }),
        "AGENT_RUN_TOOL_CALL_MISMATCH",
      );
      await expectCode(
        open(h, "tool-mismatch", {
          expectedVersion: 2,
          interactionId: "wrong-name",
          toolName: "different",
        }),
        "AGENT_RUN_TOOL_CALL_MISMATCH",
      );
    });

    it("allows ledger updates only with a valid composite key", async () => {
      const h = makeHarness();
      h.createRunningRun("update-key");
      await h.port.appendToolCalls("update-key", [
        ledgerEntry({
          executionId: "e",
          toolCallId: "call",
          toolName: "tool",
          argsDigest: "d",
        }),
      ]);
      await expectCode(
        h.port.updateToolCall(
          "update-key",
          { executionId: "wrong", toolCallId: "call" },
          { capabilityState: "issued" },
        ),
        "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
      );
      await expectCode(
        h.port.updateToolCall(
          "update-key",
          { executionId: "", toolCallId: "call" },
          { capabilityState: "issued" },
        ),
        "AGENT_RUN_EXECUTION_ID_INVALID",
      );
    });

    it("enforces the Native audit execution ID limit", async () => {
      const h = makeHarness();
      h.createRunningRun("audit-limit");
      for (let index = 0; index < 512; index += 1) {
        await h.port.appendToolCalls("audit-limit", [
          ledgerEntry({
            executionId: `e-${index}`,
            toolCallId: `call-${index}`,
            toolName: "tool",
            argsDigest: "d",
          }),
        ]);
      }
      await expectCode(
        h.port.appendToolCalls("audit-limit", [
          ledgerEntry({
            executionId: "e-over-limit",
            toolCallId: "call-over-limit",
            toolName: "tool",
            argsDigest: "d",
          }),
        ]),
        "AGENT_RUN_AUDIT_EXECUTION_IDS_LIMIT",
      );
    });

    it("allows only one pending interaction per root Run", async () => {
      const h = makeHarness();
      h.createRunningRun("root-child-a", "root-run");
      h.createRunningRun("root-child-b", "root-run");
      await open(h, "root-child-a", { interactionId: "pending-a" });
      await expectCode(
        open(h, "root-child-b", { interactionId: "pending-b" }),
        "AGENT_RUN_PENDING_INTERACTION_EXISTS",
      );
    });

    it("never reuses an interaction ID after its first use", async () => {
      const h = makeHarness();
      h.createRunningRun("id-first");
      await open(h, "id-first", { interactionId: "reused-id" });
      await h.port.decideApproval({
        runId: "id-first",
        expectedVersion: 1,
        interactionId: "reused-id",
        interactionVersion: 0,
        decision: "rejected",
      });
      h.createRunningRun("id-second");
      // Native's interaction_id PRIMARY KEY rejects this at SQLite insert.
      await expectRejected(
        open(h, "id-second", { interactionId: "reused-id" }),
      );
    });

    it("reports missing and terminal runs using Native error codes", async () => {
      const h = makeHarness();
      await expectCode(open(h, "missing"), "AGENT_RUN_NOT_FOUND");
      h.createRunningRun("terminal");
      h.stopRun("terminal");
      await expectCode(
        open(h, "terminal", { expectedVersion: 1 }),
        "AGENT_RUN_TERMINAL",
      );
      await expectCode(
        h.port.appendToolCalls("terminal", [
          {
            toolCallId: "x",
            name: "x",
            canonicalArgs: {},
            argsDigest: "d",
            executionId: "e",
            chatMessageId: "m",
            mainOwnedProvenanceId: "",
            model: "m",
            capabilityState: "not_issued",
            executionState: "pending",
          },
        ]),
        "AGENT_RUN_TERMINAL",
      );
    });
  });
}
