import { describe, expect, it } from "vitest";
import type {
  AgentRunApprovalPort,
  AgentRunState,
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
}

export function describeAgentRunApprovalPortContract(
  name: string,
  makeHarness: () => AgentRunApprovalPortHarness,
): void {
  describe(name, () => {
    const open = (
      port: AgentRunApprovalPort,
      runId: string,
      overrides: Record<string, unknown> = {},
    ) =>
      port.openApproval({
        runId,
        expectedVersion: 0,
        interactionId: `interaction-${runId}`,
        toolCallId: "tool-call-1",
        toolName: "update_entry",
        argsDigest: "digest",
        request: "Apply the proposed change?",
        targetBasis: null,
        ...overrides,
      } as Parameters<AgentRunApprovalPort["openApproval"]>[0]);
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
      expect(await open(h.port, "decide")).toEqual({
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
      await open(h.port, "invalidate");
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

    it("requires the expected run and interaction versions and statuses", async () => {
      const h = makeHarness();
      h.createRunningRun("cas");
      await expectCode(
        open(h.port, "cas", { expectedVersion: 1 }),
        "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
      );
      await open(h.port, "cas");
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
      await open(h.port, "limits");
      await expectCode(
        open(h.port, "limits", { expectedVersion: 1, interactionId: "second" }),
        "AGENT_RUN_PENDING_INTERACTION_EXISTS",
      );

      h.createRunningRun("basis");
      await expectCode(
        open(h.port, "basis", { targetBasis: [] }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      await expectCode(
        open(h.port, "basis", {
          targetBasis: Array.from({ length: 65 }, () => ({
            sourceKind: "entry",
            sourceId: "1",
            version: "v1",
          })),
        }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      await expectCode(
        open(h.port, "basis", {
          targetBasis: Array.from({ length: 64 }, () => ({
            sourceKind: "k".repeat(64),
            sourceId: "i".repeat(256),
            version: "v".repeat(256),
          })),
        }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      await expectCode(
        open(h.port, "basis", {
          targetBasis: [
            { sourceKind: "é".repeat(33), sourceId: "1", version: "v1" },
          ],
        }),
        "AGENT_RUN_TARGET_BASIS_INVALID",
      );
      // Native rejects these ambiguous enum shapes during serde deserialization,
      // before it can attach an AGENT_RUN error code.
      await expectRejected(
        open(h.port, "basis", {
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
        open(h.port, "basis", {
          targetBasis: [{ sourceKind: "entry", sourceId: "1" }],
        }),
      );

      h.createRunningRun("request");
      await expectCode(
        open(h.port, "request", { request: "é".repeat(32_769) }),
        "AGENT_RUN_REQUEST_TOO_LARGE",
      );
    });

    it("keeps pending on approval timeout and cancels and scrubs it when the run stops", async () => {
      const h = makeHarness();
      h.createRunningRun("timeout");
      await open(h.port, "timeout");
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
      await open(h.port, "stop");
      expect(h.stopRun("stop").status).toBe("cancelled");
      expect(h.readInteraction("interaction-stop")).toMatchObject({
        status: "cancelled",
        request: "",
      });
      expect(await h.port.getPendingApproval("stop")).toBeNull();
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
      await h.port.appendToolCall("ledger", entry);
      await expectCode(
        h.port.appendToolCall("ledger", entry),
        "AGENT_RUN_DUPLICATE_TOOL_CALL_ID",
      );
      await expectCode(
        h.port.updateToolCall("ledger", "missing", {
          capabilityState: "issued",
        }),
        "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
      );
      await h.port.updateToolCall("ledger", "tool-call-1", {
        capabilityState: "issued",
        executionState: "committed",
      });
      await expectCode(
        h.port.updateToolCall("ledger", "tool-call-1", {
          capabilityState: "awaiting_approval",
        }),
        "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
      );
      await expectCode(
        h.port.updateToolCall("ledger", "tool-call-1", {
          executionState: "failed",
        }),
        "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
      );
      expect(h.readRun("ledger")).toEqual({
        runId: "ledger",
        version: 0,
        status: "running",
      });
    });

    it("allows only one pending interaction per root Run", async () => {
      const h = makeHarness();
      h.createRunningRun("root-child-a", "root-run");
      h.createRunningRun("root-child-b", "root-run");
      await open(h.port, "root-child-a", { interactionId: "pending-a" });
      await expectCode(
        open(h.port, "root-child-b", { interactionId: "pending-b" }),
        "AGENT_RUN_PENDING_INTERACTION_EXISTS",
      );
    });

    it("never reuses an interaction ID after its first use", async () => {
      const h = makeHarness();
      h.createRunningRun("id-first");
      await open(h.port, "id-first", { interactionId: "reused-id" });
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
        open(h.port, "id-second", { interactionId: "reused-id" }),
      );
    });

    it("reports missing and terminal runs using Native error codes", async () => {
      const h = makeHarness();
      await expectCode(open(h.port, "missing"), "AGENT_RUN_NOT_FOUND");
      h.createRunningRun("terminal");
      h.stopRun("terminal");
      await expectCode(
        open(h.port, "terminal", { expectedVersion: 1 }),
        "AGENT_RUN_TERMINAL",
      );
      await expectCode(
        h.port.appendToolCall("terminal", {
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
        }),
        "AGENT_RUN_TERMINAL",
      );
    });
  });
}
