import { describe, expect, it, vi } from "vitest";

import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
  d2aRouteLedgersForTest,
} from "./profileEgress.js";
import { nativeSqlPolicyV2 } from "./d2aSqlPolicyFixture.js";
import { createLicenseValidationScheduler } from "./licenseValidation.js";
import { NAPI_COMMANDS, type NapiBackendLike } from "../shared/ipcContract.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function backend(status: Record<string, unknown> = {}) {
  return {
    initializeProfileEgress: async () =>
      JSON.stringify({
        profileId: "profile-1",
        callerEpoch: 4,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
        sqlPolicy: nativeSqlPolicyV2(),
        ...status,
      }),
    registerProfileEgressCaller: () => undefined,
    invalidateProfileEgressCallers: () => undefined,
  } as unknown as NapiBackendLike;
}

describe("D2a profile egress gate", () => {
  it("does not expose main-only activation through renderer commands", () => {
    expect(Object.hasOwn(NAPI_COMMANDS, "activate_profile_egress")).toBe(false);
  });

  it("passes through a valid unrestricted startup without registering callers", async () => {
    const registerProfileEgressCaller = vi.fn();
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      registerProfileEgressCaller,
    });

    expect(gate.restricted).toBe(false);
    expect(gate.unavailable).toBe(false);
    expect(() => gate.assertInvoke("send_chat_message", {})).not.toThrow();
    for (const [command, args] of [
      ["activate_license", { key: "arbitrary-plaintext-license-key" }],
      ["revalidate_license", {}],
      ["deactivate_license", {}],
      ["vivliostyle_build", {}],
      ["vivliostyle_preview_start", {}],
      ["vivliostyle_detect", {}],
    ] as const) {
      expect(() => gate.assertInvoke(command, args), command).not.toThrow();
    }
    expect(() => gate.assertInvoke("db_execute", {})).not.toThrow();
    expect(gate.allowsBackendEvent("chat:stream-chunk")).toBe(true);
    expect(() => gate.assertExternalUrl()).not.toThrow();
    gate.issueCallerIdentity(11);
    expect(registerProfileEgressCaller).not.toHaveBeenCalled();
  });

  it("closes egress immediately, coalesces activation, and rotates old callers", async () => {
    const nativeStatus = JSON.parse(
      await backend().initializeProfileEgress!(),
    ) as Record<string, unknown>;
    let resolveActivation: (value: string) => void = () => {};
    const activateProfileEgress = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveActivation = resolve;
        }),
    );
    const registerProfileEgressCaller = vi.fn();
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress,
      registerProfileEgressCaller,
    });
    const oldIdentity = gate.issueCallerIdentity(11);

    const first = gate.activateFirstRestrictedPublication!();
    const second = gate.activateFirstRestrictedPublication!();
    expect(activateProfileEgress).toHaveBeenCalledOnce();
    expect(gate.restricted).toBe(true);
    expect(() => gate.assertInvoke("send_chat_message", {})).toThrow(
      new RegExp(`${D2A_EGRESS_DENIED_MARKER} old-external-ai`),
    );
    expect(gate.allowsBackendEvent("chat:stream-chunk")).toBe(false);
    expect(() => gate.assertExternalUrl()).toThrow(
      new RegExp(`${D2A_EGRESS_DENIED_MARKER} external-url`),
    );

    resolveActivation(
      JSON.stringify({
        ...nativeStatus,
        profileId: "profile-activated",
        callerEpoch: 5,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
      }),
    );
    await Promise.all([first, second]);
    expect(gate.unavailable).toBe(false);
    const newIdentity = gate.issueCallerIdentity(11);
    expect(newIdentity.callerId).not.toBe(oldIdentity.callerId);
    expect(newIdentity.callerEpoch).toBe(5);
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: oldIdentity,
      }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} unclassified`));
    expect(registerProfileEgressCaller).toHaveBeenCalledOnce();
  });

  it("awaits every main-owned transport drain before Native activation", async () => {
    const nativeStatus = JSON.parse(
      await backend().initializeProfileEgress!(),
    ) as Record<string, unknown>;
    let releaseDrain!: () => void;
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    const activateProfileEgress = vi.fn(async () =>
      JSON.stringify({
        ...nativeStatus,
        profileId: "profile-activated",
        callerEpoch: 5,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
      }),
    );
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress,
    });

    gate.registerMainEgressParticipant?.("cli", drain);
    const activation = gate.activateFirstRestrictedPublication!();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(gate.restricted).toBe(true);
    expect(activateProfileEgress).not.toHaveBeenCalled();

    releaseDrain();
    await activation;
    expect(activateProfileEgress).toHaveBeenCalledOnce();
    expect(gate.unavailable).toBe(false);
    expect(() =>
      gate.registerMainEgressParticipant?.("late", async () => {}),
    ).toThrow("already completed");
  });

  it("waits for admitted manual license operations before Native activation", async () => {
    const initialStatus = JSON.parse(
      await backend({
        restricted: false,
        handlesInvalidated: false,
      }).initializeProfileEgress!(),
    ) as Record<string, unknown>;
    const activateProfileEgress = vi.fn(async () =>
      JSON.stringify({
        ...initialStatus,
        profileId: "profile-activated",
        callerEpoch: 5,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
      }),
    );
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress,
    });
    const scheduler = createLicenseValidationScheduler(null, vi.fn());
    const manualOperations = [
      deferred<string>(),
      deferred<string>(),
      deferred<string>(),
    ];
    gate.registerMainEgressParticipant("license-validation", () =>
      scheduler.quiesceForProfileEgress(),
    );
    const admitted = manualOperations.map((operation) =>
      scheduler.runManualOperation(() => operation.promise),
    );

    const activation = gate.activateFirstRestrictedPublication!();
    await vi.waitFor(() => expect(gate.restricted).toBe(true));
    expect(activateProfileEgress).not.toHaveBeenCalled();

    for (const [index, operation] of manualOperations.entries()) {
      operation.resolve(`manual-${index}`);
    }
    await expect(Promise.all(admitted)).resolves.toEqual([
      "manual-0",
      "manual-1",
      "manual-2",
    ]);
    await activation;
    expect(activateProfileEgress).toHaveBeenCalledOnce();
    expect(gate.unavailable).toBe(false);
  });

  it("closes participant registration before a drain callback can re-enter", async () => {
    const nativeStatus = JSON.parse(
      await backend().initializeProfileEgress!(),
    ) as Record<string, unknown>;
    const activateProfileEgress = vi.fn(async () =>
      JSON.stringify({
        ...nativeStatus,
        profileId: "profile-activated",
        callerEpoch: 5,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
      }),
    );
    let registrationError: unknown;
    const drain = vi.fn(async () => {
      try {
        gate.registerMainEgressParticipant("late", async () => {});
      } catch (error) {
        registrationError = error;
      }
    });
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress,
    });
    gate.registerMainEgressParticipant("first", drain);

    await gate.activateFirstRestrictedPublication!();

    expect(registrationError).toBeInstanceOf(Error);
    expect(registrationError).toMatchObject({
      message: expect.stringMatching(/started|completed/),
    });
    expect(activateProfileEgress).toHaveBeenCalledOnce();
  });

  it("waits for every participant before failing activation", async () => {
    let releaseSecond!: () => void;
    const first = vi.fn(async () => {
      throw new Error("first drain failed");
    });
    const second = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        }),
    );
    const activateProfileEgress = vi.fn(async () => "never-called");
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress,
    });
    gate.registerMainEgressParticipant?.("first", first);
    gate.registerMainEgressParticipant?.("second", second);

    const activation = gate.activateFirstRestrictedPublication!();
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(activateProfileEgress).not.toHaveBeenCalled();
    releaseSecond();

    await expect(activation).rejects.toThrow("first drain failed");
    expect(activateProfileEgress).not.toHaveBeenCalled();
    expect(gate.unavailable).toBe(true);
  });

  it("fails closed when a main-owned transport cannot drain", async () => {
    const activateProfileEgress = vi.fn(async () => "never-called");
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress,
    });
    gate.registerMainEgressParticipant?.("codex-app-server", async () => {
      throw new Error("Codex drain failed");
    });

    await expect(gate.activateFirstRestrictedPublication!()).rejects.toThrow(
      "Codex drain failed",
    );
    expect(activateProfileEgress).not.toHaveBeenCalled();
    expect(gate.restricted).toBe(true);
    expect(gate.unavailable).toBe(true);
  });

  it("stays fail-closed when main-only activation fails", async () => {
    const gate = await createProfileEgressGate({
      ...backend({ restricted: false, handlesInvalidated: false }),
      activateProfileEgress: vi.fn(async () => {
        throw new Error("native activation failed");
      }),
    });

    await expect(gate.activateFirstRestrictedPublication!()).rejects.toThrow(
      "native activation failed",
    );
    expect(gate.restricted).toBe(true);
    expect(gate.unavailable).toBe(true);
    expect(() => gate.assertInvoke("send_chat_message", {})).toThrow(
      new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`),
    );
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT 1",
      }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
    expect(gate.allowsBackendEvent("workspace:opened")).toBe(true);
    expect(() => gate.assertExternalUrl()).toThrow();
  });

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

  it("binds the typed cold reader to the issued caller and workspace epoch", async () => {
    const gate = await createProfileEgressGate(backend());
    const issued = gate.issueCallerIdentity(11);
    const request = {
      expectedWorkspacePath: "/workspace-1",
      projectId: "project-1",
      revisionId: "revision-1",
      callerIdentity: issued,
    };
    // nir1-publication (K3/2): the issued identity of a restricted profile
    // passes at invoke; Native re-authorizes it at start and at return.
    expect(() =>
      gate.assertInvoke("nir1_entity_relation_revision_read", request),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("nir1_entity_relation_revision_read", {
        ...request,
        callerIdentity: undefined,
      }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} nir1-publication`));

    const forged = { ...issued, senderId: 12 };
    expect(() =>
      gate.assertInvoke("nir1_entity_relation_revision_read", {
        ...request,
        callerIdentity: forged,
      }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} unclassified`));
  });

  it("keeps typed prepare available as a Native mutation while the readers are nir1-publication", async () => {
    const gate = await createProfileEgressGate(backend());
    const issued = gate.issueCallerIdentity(11);
    expect(() =>
      gate.assertInvoke("nir1_entity_relation_revision_prepare", {
        callerIdentity: issued,
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertPlaintextPublication("nir1_entity_relation_revision_prepare", {
        callerIdentity: issued,
      }),
    ).not.toThrow();
    for (const command of [
      "nir1_entity_relation_revision_read",
      "nir1_entity_relation_revision_read_current",
      "nir1_entity_relation_revision_restore",
    ]) {
      expect(() =>
        gate.assertInvoke(command, { callerIdentity: issued }),
      ).not.toThrow();
      expect(() =>
        gate.assertPlaintextPublication(command, { callerIdentity: issued }),
      ).not.toThrow();
      expect(() => gate.assertInvoke(command, {})).toThrow(
        new RegExp(`${D2A_EGRESS_DENIED_MARKER} nir1-publication`),
      );
    }
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
      ([serialized]) =>
        JSON.parse(serialized as string) as { callerId: string },
    );
    expect(registrations[1]?.callerId).not.toBe(before.callerId);
  });

  it("uses the existing trusted workspace-open path when no UUID is in the event", async () => {
    const gate = await createProfileEgressGate(backend());
    gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", { path: "/workspace-2" });
    expect(gate.issueCallerIdentity(11).workspaceId).toBe("/workspace-2");
  });

  it("keeps the trusted workspace id across the terminal Ready lifecycle view", async () => {
    const gate = await createProfileEgressGate(backend());
    gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", {
      workspace: { workspaceId: "workspace-2" },
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 4,
      status: "ready",
      bindingToken: "bnd-ready",
      activation: "ready",
    });
    expect(gate.issueCallerIdentity(11).workspaceId).toBe("workspace-2");
  });

  it("does not invalidate Ready callers for a same-token revision-only snapshot", async () => {
    const invalidateProfileEgressCallers = vi.fn();
    const gate = await createProfileEgressGate({
      ...backend(),
      invalidateProfileEgressCallers,
    });
    gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 4,
      status: "ready",
      bindingToken: "bnd-ready",
      activation: "ready",
    });
    const currentIdentity = gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 5,
      status: "ready",
      bindingToken: "bnd-ready",
      activation: "ready",
    });
    expect(invalidateProfileEgressCallers).toHaveBeenCalledOnce();
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: currentIdentity,
      }),
    ).not.toThrow();
  });

  describe("successful Open result and queued Native notifications", () => {
    const ready = {
      schemaVersion: 1,
      revision: 6,
      status: "ready",
      bindingToken: "opened-binding",
      activation: "ready",
    };
    const result = { status: "ready", lifecycle: ready };

    it.each(["result-first", "opened-first", "events-first"])(
      "keeps new target readers alive for %s delivery",
      async (order) => {
        const invalidateProfileEgressCallers = vi.fn();
        const gate = await createProfileEgressGate({
          ...backend(),
          invalidateProfileEgressCallers,
        });
        const old = gate.issueCallerIdentity(11);
        if (order !== "result-first") {
          gate.observeBackendEvent?.("workspace:opened", { path: "/target" });
        }
        if (order === "events-first") {
          gate.observeBackendEvent?.("workspace:lifecycle-state", ready);
        }
        gate.observeWorkspaceOpenResult?.(JSON.stringify(result), "/target");
        const current = gate.issueCallerIdentity(11);
        expect(current.workspaceId).toBe("/target");
        expect(current.callerId).not.toBe(old.callerId);
        expect(() =>
          gate.assertInvoke("save_global_settings", {
            callerIdentity: old,
          }),
        ).toThrow(D2A_EGRESS_DENIED_MARKER);
        const revocationsBeforeRead =
          invalidateProfileEgressCallers.mock.calls.length;
        if (order === "result-first") {
          // This callback arrives while the new target DB reader is active.
          gate.observeBackendEvent?.("workspace:opened", { path: "/target" });
        }
        gate.observeBackendEvent?.("workspace:lifecycle-state", ready);
        expect(invalidateProfileEgressCallers).toHaveBeenCalledTimes(
          revocationsBeforeRead,
        );
        expect(gate.issueCallerIdentity(11)).toEqual(current);
        expect(() =>
          gate.assertInvoke("save_global_settings", {
            callerIdentity: current,
          }),
        ).not.toThrow();

        // A real subsequent Open at the same path must still revoke readers.
        gate.observeBackendEvent?.("workspace:lifecycle-state", {
          ...ready,
          revision: 7,
          status: "transition",
          activation: "none",
        });
        gate.observeBackendEvent?.("workspace:opened", { path: "/target" });
        expect(() =>
          gate.assertInvoke("save_global_settings", {
            callerIdentity: current,
          }),
        ).toThrow(D2A_EGRESS_DENIED_MARKER);
      },
    );

    it.each([
      { ...result, status: "recovery-required" },
      { ...result, lifecycle: { ...ready, revision: -1 } },
      { ...result, lifecycle: { ...ready, bindingToken: "" } },
      { ...result, lifecycle: { ...ready, schemaVersion: 2 } },
      { ...result, lifecycle: { ...ready, activation: "requires-open" } },
    ])(
      "does not bind malformed or non-Ready Open results: %j",
      async (invalid) => {
        const gate = await createProfileEgressGate(backend());
        const before = gate.issueCallerIdentity(11);
        gate.observeWorkspaceOpenResult?.(invalid, "/target");
        expect(gate.issueCallerIdentity(11)).toEqual(before);
        gate.observeBackendEvent?.("workspace:opened", { path: "/target" });
        expect(gate.issueCallerIdentity(11).callerId).not.toBe(before.callerId);
      },
    );

    it("cannot resurrect an old result after a newer Closed lifecycle", async () => {
      const gate = await createProfileEgressGate(backend());
      gate.observeWorkspaceOpenResult?.(result, "/target");
      gate.observeBackendEvent?.("workspace:lifecycle-state", {
        ...ready,
        revision: 8,
        status: "closed",
        activation: "none",
        bindingToken: null,
      });
      gate.observeWorkspaceOpenResult?.(result, "/target");
      expect(gate.issueCallerIdentity(11).workspaceId).toBeNull();
    });

    it("does not acknowledge a different workspace or a restore-only notification", async () => {
      const gate = await createProfileEgressGate(backend());
      gate.observeWorkspaceOpenResult?.(result, "/target");
      const before = gate.issueCallerIdentity(11);
      gate.observeBackendEvent?.("workspace:opened", {
        path: "/other",
        restoreOnly: true,
      });
      expect(gate.issueCallerIdentity(11).workspaceId).toBe("/other");
      expect(() =>
        gate.assertInvoke("save_global_settings", {
          callerIdentity: before,
        }),
      ).toThrow(D2A_EGRESS_DENIED_MARKER);
    });
  });

  it("retains the Native recovery binding through requires-open", async () => {
    const gate = await createProfileEgressGate(backend());
    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-recovery",
      restoreOnly: true,
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 5,
      status: "recovery-required",
      bindingToken: null,
      activation: "requires-open",
    });
    expect(gate.issueCallerIdentity(11).workspaceId).toBe(
      "/workspace-recovery",
    );
  });

  it("retains the Safe Mode recovery binding across restore Transition and explicit Open", async () => {
    const registerProfileEgressCaller = vi.fn((serialized: string) => {
      const identity = JSON.parse(serialized) as {
        workspaceId: string | null;
      };
      if (identity.workspaceId !== "/workspace-recovery") {
        throw new Error("Native recovery binding mismatch");
      }
    });
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });
    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-recovery",
      restoreOnly: true,
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 5,
      status: "recovery-required",
      bindingToken: "bnd-recovery-1",
      activation: "requires-open",
    });
    const beforeRestore = gate.issueCallerIdentity(11);
    expect(beforeRestore.workspaceId).toBe("/workspace-recovery");
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: beforeRestore,
      }),
    ).not.toThrow();

    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 6,
      status: "transition",
      bindingToken: "bnd-recovery-transition",
      activation: "none",
    });
    const duringRestore = gate.issueCallerIdentity(11);
    expect(duringRestore.workspaceId).toBe("/workspace-recovery");
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: duringRestore,
      }),
    ).not.toThrow();

    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 7,
      status: "recovery-required",
      bindingToken: "bnd-recovery-2",
      activation: "requires-open",
    });
    const afterRestore = gate.issueCallerIdentity(11);
    expect(afterRestore.workspaceId).toBe("/workspace-recovery");
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: afterRestore,
      }),
    ).not.toThrow();

    // The successful explicit Open rotates the normal binding and retires the
    // recovery-only slot; it still uses the same trusted workspace target.
    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-recovery",
      restoreOnly: false,
    });
    const opened = gate.issueCallerIdentity(11);
    expect(opened.workspaceId).toBe("/workspace-recovery");
    expect(registerProfileEgressCaller).toHaveBeenCalledTimes(4);
  });

  it("restores the normal Ready authorization only from an exact Unchanged proof", async () => {
    const registerProfileEgressCaller = vi.fn((serialized: string) => {
      const identity = JSON.parse(serialized) as {
        workspaceId: string | null;
      };
      if (identity.workspaceId !== "/workspace-normal") {
        throw new Error("Native normal binding mismatch");
      }
    });
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });

    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-normal",
      restoreOnly: false,
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 1,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });
    const beforeRestore = gate.issueCallerIdentity(11);
    expect(beforeRestore.workspaceId).toBe("/workspace-normal");
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: beforeRestore,
      }),
    ).not.toThrow();

    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 2,
      status: "transition",
      bindingToken: "bnd-restore-transition",
      activation: "none",
    });
    const unchanged = {
      status: "unchanged",
      operationOutcome: "failed",
      contentEffect: "none",
      lifecycle: {
        schemaVersion: 1,
        revision: 3,
        status: "ready",
        bindingToken: "bnd-normal-ready",
        activation: "ready",
      },
    } as const;
    gate.observeWorkspaceLifecycleResult?.(unchanged);

    // The proof may arrive before the terminal lifecycle event.  It must be
    // held until Native publishes the exact old token at the proof revision.
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 3,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });
    const afterRestore = gate.issueCallerIdentity(11);
    expect(afterRestore.workspaceId).toBe("/workspace-normal");
    expect(() =>
      gate.assertInvoke("save_global_settings", {
        callerIdentity: afterRestore,
      }),
    ).not.toThrow();
    expect(registerProfileEgressCaller).toHaveBeenLastCalledWith(
      expect.stringContaining('"workspaceId":"/workspace-normal"'),
    );
  });

  it("does not restore the normal authorization from a NotAdmitted result", async () => {
    const registerProfileEgressCaller = vi.fn((serialized: string) => {
      const identity = JSON.parse(serialized) as {
        workspaceId: string | null;
      };
      if (identity.workspaceId !== "/workspace-normal") {
        throw new Error("Native normal binding mismatch");
      }
    });
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });

    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-normal",
      restoreOnly: false,
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 1,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 2,
      status: "transition",
      bindingToken: "bnd-restore-transition",
      activation: "none",
    });
    gate.observeWorkspaceLifecycleResult?.({
      status: "not-admitted",
      operationOutcome: "unknown",
      contentEffect: "none",
      lifecycle: {
        schemaVersion: 1,
        revision: 2,
        status: "transition",
        bindingToken: "bnd-restore-transition",
        activation: "none",
      },
      reasonCode: "workspace-operation-busy",
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 3,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });

    const identity = gate.issueCallerIdentity(11);
    expect(identity.workspaceId).toBeNull();
    expect(() =>
      gate.assertInvoke("save_global_settings", { callerIdentity: identity }),
    ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
  });

  it("applies an unchanged proof when the terminal Ready event arrives first", async () => {
    const registerProfileEgressCaller = vi.fn((serialized: string) => {
      const identity = JSON.parse(serialized) as {
        workspaceId: string | null;
      };
      if (identity.workspaceId !== "/workspace-normal") {
        throw new Error("Native normal binding mismatch");
      }
    });
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });
    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-normal",
      restoreOnly: false,
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 1,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 2,
      status: "transition",
      bindingToken: "bnd-restore-transition",
      activation: "none",
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 3,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });

    gate.observeWorkspaceLifecycleResult?.({
      status: "unchanged",
      operationOutcome: "unknown",
      contentEffect: "none",
      lifecycle: {
        schemaVersion: 1,
        revision: 3,
        status: "ready",
        bindingToken: "bnd-normal-ready",
        activation: "ready",
      },
    });
    expect(gate.issueCallerIdentity(11).workspaceId).toBe("/workspace-normal");
  });

  it("keeps an unchanged proof pending across a delayed Transition and Ready event", async () => {
    const registerProfileEgressCaller = vi.fn((serialized: string) => {
      const identity = JSON.parse(serialized) as {
        workspaceId: string | null;
      };
      if (identity.workspaceId !== "/workspace-normal") {
        throw new Error("Native normal binding mismatch");
      }
    });
    const gate = await createProfileEgressGate({
      ...backend(),
      registerProfileEgressCaller,
    });

    gate.observeBackendEvent?.("workspace:opened", {
      path: "/workspace-normal",
      restoreOnly: false,
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 1,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });
    gate.issueCallerIdentity(11);

    // Native's result callback can beat its nonblocking lifecycle events. The
    // old Ready observation must not be treated as the terminal proof.
    gate.observeWorkspaceLifecycleResult?.({
      status: "unchanged",
      operationOutcome: "failed",
      contentEffect: "none",
      lifecycle: {
        schemaVersion: 1,
        revision: 3,
        status: "ready",
        bindingToken: "bnd-normal-ready",
        activation: "ready",
      },
    });
    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 2,
      status: "transition",
      bindingToken: "bnd-restore-transition",
      activation: "none",
    });
    expect(gate.issueCallerIdentity(11).workspaceId).toBeNull();

    gate.observeBackendEvent?.("workspace:lifecycle-state", {
      schemaVersion: 1,
      revision: 3,
      status: "ready",
      bindingToken: "bnd-normal-ready",
      activation: "ready",
    });
    const restored = gate.issueCallerIdentity(11);
    expect(restored.workspaceId).toBe("/workspace-normal");
    expect(registerProfileEgressCaller).toHaveBeenLastCalledWith(
      expect.stringContaining('"workspaceId":"/workspace-normal"'),
    );
  });

  it.each([
    ["send_chat_message", {}],
    ["send_inline_ai_stream", {}],
    ["send_cli_chat_stream", {}],
    ["codex_app_start_turn", {}],
    ["codex_app_get_status", {}],
    ["vivliostyle_build", {}],
    ["vivliostyle_preview_start", {}],
    ["vivliostyle_detect", {}],
    ["nir1_pack_context", {}],
    ["fts_search", {}],
    ["narrative_extraction_claim_task", { payload: {} }],
    ["narrative_extraction_get_run_review_bundle", { payload: {} }],
    ["project_snapshot_restore_context", {}],
    ["lint_ignore_list", {}],
    ["lint_ignore_list_scene", {}],
    ["lint_term_dictionary_list", {}],
    ["nir1_entity_relation_revision_read", {}],
    ["nir1_entity_relation_revision_read_current", {}],
    ["nir1_entity_relation_revision_restore", {}],
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

  describe("license-control (K3/2 L-1)", () => {
    const LICENSE_COMMANDS = [
      [
        "activate_license",
        { key: "GRIM-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3" },
      ],
      ["revalidate_license", {}],
      ["deactivate_license", {}],
    ] as const;

    it.each(LICENSE_COMMANDS)(
      "passes %s in a restricted profile with a main-issued identity",
      async (command, args) => {
        const gate = await createProfileEgressGate(backend());
        expect(gate.restricted).toBe(true);
        expect(gate.unavailable).toBe(false);
        const callerIdentity = gate.issueCallerIdentity(11);
        expect(() =>
          gate.assertInvoke(command, { ...args, callerIdentity }),
        ).not.toThrow();
      },
    );

    it.each(LICENSE_COMMANDS)(
      "passes %s while a first activation is in flight",
      async (command, args) => {
        const release = deferred<string>();
        const gate = await createProfileEgressGate({
          ...backend({ restricted: false, handlesInvalidated: false }),
          activateProfileEgress: vi.fn(() => release.promise),
        });
        const activation = gate.activateFirstRestrictedPublication!();
        expect(gate.restricted).toBe(true);
        expect(() => gate.assertInvoke(command, args)).not.toThrow();
        release.resolve(await backend().initializeProfileEgress!());
        await activation;
      },
    );

    it.each(LICENSE_COMMANDS)(
      "denies %s when the Native profile gate is unavailable",
      async (command, args) => {
        const gate = await createProfileEgressGate(null);
        expect(gate.unavailable).toBe(true);
        expect(() => gate.assertInvoke(command, args)).toThrow(
          new RegExp(`^${D2A_EGRESS_DENIED_MARKER} license-control:`),
        );
      },
    );

    it("keeps get_license_state internal and the three mutations out of every other ledger", async () => {
      const gate = await createProfileEgressGate(null);
      expect(() => gate.assertInvoke("get_license_state", {})).not.toThrow();
      const ledgers = d2aRouteLedgersForTest();
      expect(ledgers.licenseControl).toEqual([
        "activate_license",
        "revalidate_license",
        "deactivate_license",
      ]);
      for (const [command] of LICENSE_COMMANDS) {
        expect(ledgers.denied).not.toContain(command);
        expect(ledgers.internal).not.toContain(command);
      }
      expect(ledgers.internal).toContain("get_license_state");
    });
  });

  it("closes the Vivliostyle CLI probe as external-url in a restricted profile", async () => {
    const gate = await createProfileEgressGate(backend());
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of [
      "vivliostyle_build",
      "vivliostyle_preview_start",
      "vivliostyle_detect",
    ]) {
      expect(
        () => gate.assertInvoke(command, { callerIdentity }),
        command,
      ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER} external-url:`));
    }
    // Abort/save of an already-admitted build stay internal.
    expect(() =>
      gate.assertInvoke("vivliostyle_abort_build", { callerIdentity }),
    ).not.toThrow();
  });

  it("keeps the route ledgers disjoint (K3/2 Negative (20))", () => {
    const ledgers = d2aRouteLedgersForTest();
    const names = ["denied", "internal", "licenseControl"] as const;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const overlap = ledgers[names[i]].filter((command) =>
          ledgers[names[j]].includes(command),
        );
        expect(overlap, `${names[i]} / ${names[j]}`).toEqual([]);
      }
    }
    for (const name of names) {
      expect(new Set(ledgers[name]).size, name).toBe(ledgers[name].length);
    }
    // The license ledger is compile-time bound to NAPI_COMMANDS; check it at
    // run time too.
    for (const command of ledgers.licenseControl) {
      expect(Object.hasOwn(NAPI_COMMANDS, command), command).toBe(true);
    }
  });

  it("allows the typed foreshadow anchor projection and the own-data foreshadow read while denying plaintext publication", async () => {
    const gate = await createProfileEgressGate(backend());
    const callerIdentity = gate.issueCallerIdentity(11);

    expect(() =>
      gate.assertInvoke("foreshadow_load_anchors_for_scene", {
        callerIdentity,
        sceneId: "scene-1",
      }),
    ).not.toThrow();
    // `foreshadow_get` is an own-data-read command: it passes once the opening
    // is on, while the plaintext-publication commands stay denied.
    expect(() =>
      gate.assertInvoke("foreshadow_get", {
        callerIdentity,
        payload: { id: "foreshadow-1" },
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("nir1_pack_context", { callerIdentity }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} plaintext-publication`));
  });

  it.each([
    ["chat_summaries", "summary", true],
    ["chat_message_chunks", "text", true],
    ["generation_logs", "prompt_full", true],
    ["idempotency_requests", "tombstone_json", false],
    ["ab_comparisons", "response_a", true],
    ["ab_comparison_runs", "slots", true],
  ])(
    "consumes the Native inventory for %s",
    async (table, column, readOpen) => {
      const gate = await createProfileEgressGate(backend());
      const callerIdentity = gate.issueCallerIdentity(11);
      const read = () =>
        gate.assertInvoke("db_execute", {
          callerIdentity,
          method: "all",
          sql: `SELECT ${column} FROM ${table}`,
        });
      // The read-open class is readable as own-data-read; the closed class stays
      // plaintext-publication.
      if (readOpen) {
        expect(read).not.toThrow();
      } else {
        expect(read).toThrow(
          new RegExp(`${D2A_EGRESS_DENIED_MARKER} plaintext-publication`),
        );
      }
      // Writes to either class are never own-data-read.
      expect(() =>
        gate.assertInvoke("db_execute", {
          callerIdentity,
          method: "run",
          sql: `DELETE FROM ${table}`,
        }),
      ).toThrow(
        new RegExp(`${D2A_EGRESS_DENIED_MARKER} plaintext-publication`),
      );
    },
  );

  it.each([
    [
      { sqlPolicy: nativeSqlPolicyV2({ version: 3 }) },
      "unknown policy version",
    ],
    [
      { sqlPolicy: nativeSqlPolicyV2({ version: 1 }) },
      "the previous policy version",
    ],
    [{ sqlPolicy: undefined }, "missing table inventory"],
    [
      { sqlPolicy: nativeSqlPolicyV2({ extraSet: ["chat_messages"] }) },
      "unknown policy key",
    ],
    [
      {
        sqlPolicy: nativeSqlPolicyV2({
          protectedTables: ["chat_messages"],
        }),
      },
      "the version 1 table key",
    ],
    [
      {
        sqlPolicy: nativeSqlPolicyV2({
          closedTables: ["messages", "messages"],
        }),
      },
      "duplicate closed table",
    ],
    [
      {
        sqlPolicy: nativeSqlPolicyV2({
          readOpenTables: ["chat_messages", "chat_messages"],
        }),
      },
      "duplicate read-open table",
    ],
    [
      {
        sqlPolicy: nativeSqlPolicyV2({
          closedTables: ["messages", "chat_messages"],
          readOpenTables: ["chat_messages"],
        }),
      },
      "a table declared in both classes",
    ],
    [
      { sqlPolicy: nativeSqlPolicyV2({ closedTables: [] }) },
      "an empty closed class",
    ],
    [
      { sqlPolicy: nativeSqlPolicyV2({ readOpenTables: [] }) },
      "an empty read-open class",
    ],
    [
      {
        sqlPolicy: nativeSqlPolicyV2({
          readOpenColumns: [{ table: "change_events" }],
        }),
      },
      "a malformed read-open column",
    ],
    [
      {
        sqlPolicy: nativeSqlPolicyV2({
          readOpenColumns: [
            { table: "change_events", column: "payload" },
            { table: "CHANGE_EVENTS", column: "Payload" },
          ],
        }),
      },
      "a duplicate read-open column",
    ],
  ])("fails closed for %s", async (status, _description) => {
    const gate = await createProfileEgressGate(backend(status));
    expect(gate.unavailable).toBe(true);
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT id FROM projects",
      }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} unclassified`));
  });

  it("allows capture-only locally while continuing to deny the legacy AI send", async () => {
    const gate = await createProfileEgressGate(backend());
    const callerIdentity = gate.issueCallerIdentity(11);

    expect(() =>
      gate.assertInvoke("capture_current_chat_input", { callerIdentity }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("cancel_current_chat_input", { callerIdentity }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("retire_current_chat_input", { callerIdentity }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("send_chat_message", { callerIdentity }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} old-external-ai`));
    expect(() =>
      gate.assertInvoke("unknown_capture_variant", { callerIdentity }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} unclassified`));
  });

  it("classifies the body declaration entries and the state read as internal (CB-2/CB-3, K3/2 宣言 UI)", async () => {
    const ledgers = d2aRouteLedgersForTest();
    const entries = [
      "narrative_scene_body_declaration_declare",
      "narrative_scene_body_declaration_revoke",
      "narrative_scene_body_declaration_state",
    ];
    for (const command of entries) {
      expect(Object.hasOwn(NAPI_COMMANDS, command), command).toBe(true);
      expect(ledgers.internal, command).toContain(command);
      for (const other of [
        "denied",
        "licenseControl",
        "ownDataRead",
        "nir1Publication",
        "nir1RestrictedOnly",
      ] as const) {
        expect(ledgers[other], `${other} / ${command}`).not.toContain(command);
      }
    }
    // Restricted: the gate itself passes both (Native checks the registered
    // caller and workspace); an unrestricted gate checks the workspace only.
    const gate = await createProfileEgressGate(backend());
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of entries) {
      expect(() =>
        gate.assertInvoke(command, { callerIdentity }),
      ).not.toThrow();
    }
  });

  it("keeps native-only saves and stop controls available", async () => {
    const gate = await createProfileEgressGate(backend());
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of [
      "save_scene_body_bundle",
      "agent_snippet_create",
      "save_global_settings",
      "project_patch",
      "narrative_scene_scope_read",
      "narrative_scene_scope_update",
      "narrative_scene_scope_registry_update",
      "foreshadow_load_anchors_for_scene",
    ]) {
      expect(() => gate.assertInvoke(command, {})).not.toThrow();
    }
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "all",
        sql: "SELECT key, value FROM app_settings ORDER BY key",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "run",
        sql: "UPDATE app_settings SET value = ? WHERE key = ?",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "all",
        sql: "SELECT id, title FROM projects ORDER BY id",
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertInvoke("abort_chat_stream", { streamId: "s1" }),
    ).not.toThrow();
  });

  it("allows trusted Electron project listing while denying egress routes", async () => {
    const gate = await createProfileEgressGate(backend());
    const callerIdentity = gate.issueCallerIdentity(11);

    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "all",
        sql: `
          SELECT "projects"."id"
          FROM "projects"
          WHERE NOT EXISTS (
            SELECT "project_settings"."project_id"
            FROM "project_settings"
            WHERE "project_settings"."project_id" = "projects"."id"
          )
        `,
      }),
    ).not.toThrow();

    // `fts_search` is an own-data-read command and passes once opened.
    expect(() =>
      gate.assertInvoke("fts_search", { callerIdentity }),
    ).not.toThrow();

    for (const [command, args] of [
      ["send_chat_message", {}],
      ["send_cli_chat_stream", {}],
      ["get_mcp_config", {}],
      ["nir1_pack_context", {}],
      ["db_execute", { method: "all", sql: "SELECT body FROM messages" }],
      ["db_execute", { method: "all", sql: "SELECT 1" }],
    ] as const) {
      expect(() =>
        gate.assertInvoke(command, { ...args, callerIdentity }),
      ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));
    }
  });

  it("requires the main-issued identity for generic DB operations", async () => {
    const gate = await createProfileEgressGate(backend());
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT id FROM projects",
      }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} unclassified`));
    const callerIdentity = gate.issueCallerIdentity(11);
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "all",
        sql: "SELECT 1",
      }),
    ).toThrow(new RegExp(`${D2A_EGRESS_DENIED_MARKER} unclassified`));
  });

  it("keeps the DB-only annotation reply mutation available while restricted", async () => {
    const gate = await createProfileEgressGate(backend());
    expect(() =>
      gate.assertInvoke("reply_to_annotation", {
        args: {
          parent_id: "a1",
          content: "返信",
          author_role: "user",
          project_id: "p1",
        },
      }),
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
