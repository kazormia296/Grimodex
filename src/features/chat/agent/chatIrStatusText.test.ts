import { describe, expect, it } from "vitest";
import {
  CHAT_AGENT_IR_QUERY_UTF16_MAX,
  CHAT_AGENT_IR_STATUSES,
} from "@/../electron/shared/chatAgentIrWire";
import type { ChatIrRendererStatus } from "@/lib/chatIr";
import {
  CHAT_IR_CAP_EXCEEDED_NOTE,
  CHAT_IR_CLASS_NOTE,
  CHAT_IR_QUERY_MAX_UTF16,
  CHAT_IR_STATUS_CLASS,
  chatIrStatusClass,
  chatIrStatusNote,
  type ChatIrRendererStatusName,
  type ChatIrStatusClass,
} from "./chatIrStatusText";

// The local name list and the wrapper's type are the same set (a type-only
// check in this test; no product source imports the wrapper).
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const rendererNamesMatchWrapper: Mutual<
  ChatIrRendererStatusName,
  ChatIrRendererStatus
> = true;

const RENDERER_STATUSES = [
  "disabled",
  "sub-agent",
  "no-current-scene",
  "query-invalid",
  "no-workspace",
  "turn-limit",
  "cap-exceeded",
  "gate-closed",
  "egress-denied",
  "ipc-cancelled",
  "caller-timeout",
  "ipc-error",
  "invalid-response",
] as const satisfies readonly ChatIrRendererStatusName[];

const FAILURE_CLASSES = [
  "transient",
  "unavailable",
  "context",
  "internal",
] as const satisfies readonly ChatIrStatusClass[];

// B2 設計 §5.2 の表を、そのまま期待値として写す（28 件。失敗同士の取り違えを固定する）。
const EXPECTED_CLASS: Record<string, ChatIrStatusClass> = {
  available: "answered",
  "none-above-threshold": "none",
  timeout: "transient",
  "connection-busy": "transient",
  "embedder-cold": "transient",
  busy: "transient",
  "ledger-full": "unavailable",
  "index-unavailable": "unavailable",
  unsupported: "unavailable",
  "no-current-scene": "context",
  "project-unavailable": "context",
  "project-changed": "context",
  "workspace-unavailable": "context",
  "workspace-changed": "context",
  "query-invalid": "query",
  "inference-failed": "transient",
  internal: "internal",
  disabled: "unavailable",
  "sub-agent": "unavailable",
  "no-workspace": "context",
  "turn-limit": "unavailable",
  "cap-exceeded": "unavailable",
  "gate-closed": "unavailable",
  "egress-denied": "unavailable",
  "ipc-cancelled": "context",
  "caller-timeout": "transient",
  "ipc-error": "internal",
  "invalid-response": "internal",
};

describe("chat IR status text", () => {
  it("fixes every status's class to the design table (§5.2)", () => {
    expect(Object.keys(EXPECTED_CLASS)).toHaveLength(28);
    expect({ ...CHAT_IR_STATUS_CLASS }).toEqual(EXPECTED_CLASS);
  });

  it("keeps the wrapper's renderer statuses and the local names equal", () => {
    expect(rendererNamesMatchWrapper).toBe(true);
  });

  it("gives every Native and renderer status a class", () => {
    const all = new Set<string>([
      ...CHAT_AGENT_IR_STATUSES,
      ...RENDERER_STATUSES,
    ]);
    // 17 + 13, with two names on both sides.
    expect(CHAT_AGENT_IR_STATUSES).toHaveLength(17);
    expect(RENDERER_STATUSES).toHaveLength(13);
    expect(all.size).toBe(28);
    expect(Object.keys(CHAT_IR_STATUS_CLASS).sort()).toEqual([...all].sort());
    for (const status of all) {
      const klass = chatIrStatusClass(status as ChatIrRendererStatusName);
      expect(Object.keys(CHAT_IR_CLASS_NOTE)).toContain(klass);
    }
  });

  it("says no note for answered, and only `none` says the search completed", () => {
    expect(chatIrStatusNote("available")).toBeNull();
    const withCompleted = Object.values(CHAT_IR_CLASS_NOTE).filter((note) =>
      note?.includes("completed"),
    );
    expect(withCompleted).toEqual([CHAT_IR_CLASS_NOTE.none]);
    expect(chatIrStatusNote("none-above-threshold")).toContain(
      "The search completed",
    );
    for (const status of [...CHAT_AGENT_IR_STATUSES, ...RENDERER_STATUSES]) {
      if (status === "none-above-threshold") continue;
      expect(chatIrStatusNote(status) ?? "").not.toContain(
        "The search completed",
      );
    }
  });

  it("says a failure is not evidence that nothing exists", () => {
    // `query` is left out on purpose: its note states the query bound instead.
    for (const status of [...CHAT_AGENT_IR_STATUSES, ...RENDERER_STATUSES]) {
      const klass = chatIrStatusClass(status);
      if (!(FAILURE_CLASSES as readonly string[]).includes(klass)) continue;
      expect(chatIrStatusNote(status), status).toContain(
        "not evidence that nothing relevant exists",
      );
    }
    expect(CHAT_IR_CAP_EXCEEDED_NOTE).toContain("not evidence");
  });

  it("gives cap-exceeded its own wording", () => {
    expect(chatIrStatusClass("cap-exceeded")).toBe("unavailable");
    expect(chatIrStatusNote("cap-exceeded")).toBe(CHAT_IR_CAP_EXCEEDED_NOTE);
    expect(CHAT_IR_CAP_EXCEEDED_NOTE).toContain("too large");
    expect(chatIrStatusNote("busy")).not.toBe(CHAT_IR_CAP_EXCEEDED_NOTE);
  });

  it("does not call a timeout an expiry", () => {
    const timeouts = ["timeout", "caller-timeout"] as const;
    for (const status of timeouts) {
      expect(chatIrStatusClass(status)).toBe("transient");
      const note = chatIrStatusNote(status) ?? "";
      expect(note).not.toMatch(/expir|deadline|time(?:d)? out/iu);
      expect(note).toContain("did not complete");
    }
  });

  it("states the query bound from the one constant", () => {
    expect(CHAT_IR_QUERY_MAX_UTF16).toBe(CHAT_AGENT_IR_QUERY_UTF16_MAX);
    expect(CHAT_IR_QUERY_MAX_UTF16).toBe(500);
    expect(chatIrStatusNote("query-invalid")).toContain(
      `${CHAT_AGENT_IR_QUERY_UTF16_MAX} characters (UTF-16)`,
    );
    expect(chatIrStatusClass("query-invalid")).toBe("query");
  });
});
