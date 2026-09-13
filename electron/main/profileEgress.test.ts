import { describe, expect, it } from "vitest";

import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
} from "./profileEgress.js";

function backend(status: Record<string, unknown> = {}) {
  return {
    initializeProfileEgress: async () =>
      JSON.stringify({
        profileId: "profile-1",
        callerEpoch: 4,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
        ...status,
      }),
  } as never;
}

describe("D2a profile egress gate", () => {
  it("issues stable main-owned identities per sender and keeps profile scope", async () => {
    const gate = await createProfileEgressGate(backend());
    const first = gate.issueCallerIdentity(11);
    const sameSender = gate.issueCallerIdentity(11);
    const otherSender = gate.issueCallerIdentity(12);

    expect(sameSender).toEqual(first);
    expect(otherSender).not.toEqual(first);
    expect(first).toMatchObject({
      profileId: "profile-1",
      callerEpoch: 4,
      senderId: 11,
    });
    expect(first.callerId).not.toBe("");
  });

  it("rebinds sender identities when Native announces a different workspace", async () => {
    const gate = await createProfileEgressGate(backend());
    const before = gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", {
      workspace: { workspaceId: "workspace-2" },
    });
    const after = gate.issueCallerIdentity(11);
    expect(after).not.toEqual(before);
    expect(after.workspaceId).toBe("workspace-2");
    expect(after.sessionId).not.toBe(before.sessionId);
  });

  it("uses the existing trusted workspace-open path when no UUID is in the event", async () => {
    const gate = await createProfileEgressGate(backend());
    gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", { path: "/workspace-2" });
    expect(gate.issueCallerIdentity(11).workspaceId).toBe("/workspace-2");
  });

  it.each([
    ["send_chat_message", {}],
    ["send_inline_ai_stream", {}],
    ["send_cli_chat_stream", {}],
    ["codex_app_start_turn", {}],
    ["codex_app_get_status", {}],
    ["nir1_pack_context", {}],
    ["fts_search", {}],
    ["narrative_extraction_get_run_review_bundle", { payload: {} }],
    ["db_execute", { method: "all", sql: "SELECT body FROM messages" }],
    ["db_execute", { method: "all", sql: "SELECT 1" }],
    [
      "db_execute_batch",
      { statements: [{ method: "all", sql: "SELECT 1", params: [] }] },
    ],
    ["unknown_future_external_route", {}],
  ])("denies restricted route %s before dispatch", async (command, args) => {
    const gate = await createProfileEgressGate(backend());
    expect(() => gate.assertInvoke(command, args)).toThrow(
      new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`),
    );
  });

  it("keeps native-only saves and stop controls available", async () => {
    const gate = await createProfileEgressGate(backend());
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT id, title FROM projects ORDER BY id",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "run",
        sql: "UPDATE projects SET name = ?",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("abort_chat_stream", { streamId: "s1" }),
    ).not.toThrow();
  });

  it("fails closed when the Native startup barrier is unavailable", async () => {
    const gate = await createProfileEgressGate(null);
    expect(gate.unavailable).toBe(true);
    expect(() => gate.assertInvoke("get_ai_settings", {})).not.toThrow();
    expect(() => gate.assertInvoke("send_chat_message", {})).toThrow(
      new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`),
    );
  });

  it("allows only classified non-plaintext backend events", async () => {
    const gate = await createProfileEgressGate(backend());
    expect(gate.allowsBackendEvent("workspace:opened")).toBe(true);
    expect(gate.allowsBackendEvent("chat:stream-chunk")).toBe(false);
    expect(gate.allowsBackendEvent("codex-app:event")).toBe(false);
    expect(gate.allowsBackendEvent("unknown:event")).toBe(false);
  });
});
