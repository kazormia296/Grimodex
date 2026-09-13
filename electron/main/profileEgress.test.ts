import { describe, expect, it, vi } from "vitest";

import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
  D2A_TYPED_RESULT_POLICY,
} from "./profileEgress.js";
import { NAPI_COMMANDS } from "../shared/ipcContract.js";

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
    registerProfileEgressCaller: () => undefined,
    invalidateProfileEgressCallers: () => undefined,
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

  it("registers the exact issued identity with Native", async () => {
    const registerProfileEgressCaller = vi.fn();
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });
    const identity = gate.issueCallerIdentity(11);
    expect(registerProfileEgressCaller).toHaveBeenCalledWith(
      JSON.stringify(identity),
    );
  });

  it("rejects a structurally forged identity before a safe route dispatch", async () => {
    const gate = await createProfileEgressGate(backend());
    const issued = gate.issueCallerIdentity(11);
    const forged = { ...issued, sessionId: "forged-session" };
    expect(() =>
      gate.assertInvoke("save_global_settings", { callerIdentity: forged }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
  });

  it("rejects an identity copied from another renderer sender", async () => {
    const gate = await createProfileEgressGate(backend());
    const first = gate.issueCallerIdentity(11);
    gate.issueCallerIdentity(12);
    const copied = { ...first, senderId: 12 };
    expect(() =>
      gate.assertInvoke("save_global_settings", { callerIdentity: copied }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
  });

  it("fails the sender closed when Native rejects identity registration", async () => {
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller: () => {
        throw new Error("stale process generation");
      },
    });
    const identity = gate.issueCallerIdentity(11);
    expect(() =>
      gate.assertInvoke("save_global_settings", { callerIdentity: identity }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
  });

  it("rebinds sender identities when Native announces a different workspace", async () => {
    const gate = await createProfileEgressGate(backend());
    const before = gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", {
      workspace: { workspaceId: "workspace-2" },
    });
    expect(() =>
      gate.assertInvoke("save_global_settings", { callerIdentity: before }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
    const after = gate.issueCallerIdentity(11);
    expect(after).not.toEqual(before);
    expect(after.workspaceId).toBe("workspace-2");
    expect(after.sessionId).not.toBe(before.sessionId);
  });

  it("invalidates Native registrations before rebinding a workspace", async () => {
    const invalidateProfileEgressCallers = vi.fn();
    const gate = await createProfileEgressGate({
      ...backend(),
      invalidateProfileEgressCallers,
    });
    gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", {
      workspace: { workspaceId: "workspace-2" },
    });
    expect(invalidateProfileEgressCallers).toHaveBeenCalledOnce();
  });

  it("does not re-register a stale identity before the workspace event rotates it", async () => {
    const registerProfileEgressCaller = vi.fn();
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });
    const before = gate.issueCallerIdentity(11);
    gate.issueCallerIdentity(11);
    expect(registerProfileEgressCaller).toHaveBeenCalledTimes(1);
    gate.observeBackendEvent?.("workspace:opened", {
      workspace: { workspaceId: "workspace-1" },
    });
    gate.issueCallerIdentity(11);
    expect(registerProfileEgressCaller).toHaveBeenCalledTimes(2);
    const registrations = registerProfileEgressCaller.mock.calls.map(
      ([serialized]) => JSON.parse(serialized as string) as { callerId: string },
    );
    expect(registrations[1]?.callerId).not.toBe(before.callerId);
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
    ["project_snapshot_restore_context", {}],
    ["lint_ignore_list", {}],
    ["lint_ignore_list_scene", {}],
    ["lint_term_dictionary_list", {}],
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

  it("keeps every typed plaintext-result exception tied to a current NAPI command", () => {
    for (const command of Object.keys(D2A_TYPED_RESULT_POLICY)) {
      expect(Object.hasOwn(NAPI_COMMANDS, command), command).toBe(true);
      expect(
        D2A_TYPED_RESULT_POLICY[
          command as keyof typeof D2A_TYPED_RESULT_POLICY
        ],
      ).toBe("plaintext-publication");
    }
  });

  it("denies every typed plaintext result when Native startup is unavailable", async () => {
    const gate = await createProfileEgressGate(null);
    for (const command of Object.keys(D2A_TYPED_RESULT_POLICY)) {
      expect(() => gate.assertInvoke(command, {}), command).toThrow(
        new RegExp(`${D2A_EGRESS_DENIED_MARKER} plaintext-publication`),
      );
    }
  });

  it("keeps native-only saves and stop controls available", async () => {
    const gate = await createProfileEgressGate(backend());
    for (const command of [
      "save_scene_body_bundle",
      "agent_snippet_create",
      "save_global_settings",
      "project_patch",
    ]) {
      expect(() => gate.assertInvoke(command, {})).not.toThrow();
    }
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT key, value FROM app_settings ORDER BY key",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "run",
        sql: "UPDATE app_settings SET value = ? WHERE key = ?",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT id, title FROM projects ORDER BY id",
      }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
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
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT value FROM app_settings",
      }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
  });

  it("allows only classified non-plaintext backend events", async () => {
    const gate = await createProfileEgressGate(backend());
    expect(gate.allowsBackendEvent("workspace:opened")).toBe(true);
    expect(gate.allowsBackendEvent("chat:stream-chunk")).toBe(false);
    expect(gate.allowsBackendEvent("codex-app:event")).toBe(false);
    expect(gate.allowsBackendEvent("unknown:event")).toBe(false);
  });
});
