// NIR-1 DA-1 ST4 (K3/2 `nir1-publication`): the Main side of the six NIR
// commands (Related Scenes R/IR and Evidence navigation, A2 review reads).
//
// Native re-authorizes them at start and at return (publication_guard.rs and
// its node/Rust tests). Main owns three things, pinned here:
//   (1) the invoke-time gate: a Main-issued identity, no activation in flight,
//       not unavailable; unrestricted passes unchecked;
//   (2) the completion check on the identity Main issued, and the release of
//       the pending Related Scenes operation of a result it refuses to publish
//       (so no owner or ticket is left behind, and none reaches the renderer);
//   (3) the identity reaches Native as the trailing wire argument and as no
//       enumerable field of the typed request, whatever the renderer sends.
import { describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/ipcContract.js";
import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
  d2aRouteLedgersForTest,
} from "./profileEgress.js";
import { activateGateForTest } from "./profileActivation.test.support.js";
import { nativeSqlPolicyV2 } from "./d2aSqlPolicyFixture.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      event: { sender: unknown },
      cmd: unknown,
      args: unknown,
    ) => Promise<Envelope>
  >(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: { sender: unknown },
        cmd: unknown,
        args: unknown,
      ) => Promise<Envelope>,
    ) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));
vi.mock("./shellCommands.js", () => ({
  buildShellCommandHandlers: vi.fn(() => ({})),
  registerShellBridgeHandlers: vi.fn(),
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: vi.fn(),
  hasPanelWindow: vi.fn(),
  openPanelWindow: vi.fn(),
}));

const { registerIpcRouter } = await import("./ipc.js");

const NIR_COMMANDS = [
  "related_scenes_begin",
  "related_scenes_continue",
  "related_scenes_graph_continue",
  "nir1_evidence_qualify",
  "nir1_entity_relation_revision_read",
  "nir1_entity_relation_revision_read_current",
  "nir1_entity_relation_revision_restore",
] as const;

const DENIED = (route: string) =>
  new RegExp(`^${D2A_EGRESS_DENIED_MARKER} ${route}:`);

function status(restricted: boolean, overrides: Record<string, unknown> = {}) {
  return {
    profileId: "profile-1",
    callerEpoch: 4,
    restricted,
    handlesInvalidated: restricted,
    inFlightStopped: true,
    sqlPolicy: nativeSqlPolicyV2(),
    ...overrides,
  };
}

function backend(
  restricted: boolean,
  extra: Record<string, unknown> = {},
  activate?: () => Promise<string>,
) {
  return {
    initializeProfileEgress: async () => JSON.stringify(status(restricted)),
    registerProfileEgressCaller: () => undefined,
    invalidateProfileEgressCallers: () => undefined,
    profileActivationCommit:
      activate ??
      (async () =>
        JSON.stringify(
          status(true, { profileId: "profile-2", callerEpoch: 5 }),
        )),
    ...extra,
  } as unknown as NapiBackendLike & {
    profileActivationCommit: () => Promise<string>;
  };
}

describe("gate: nir1-publication at invoke (K3/2)", () => {
  it("holds the seven NIR commands and routes them nir1-publication", async () => {
    expect([...d2aRouteLedgersForTest().nir1Publication].sort()).toEqual(
      [...NIR_COMMANDS].sort(),
    );
    const gate = await createProfileEgressGate(backend(true));
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of NIR_COMMANDS) {
      expect(() => gate.assertInvoke(command, {}), command).toThrow(
        DENIED("nir1-publication"),
      );
      expect(
        () => gate.assertInvoke(command, { callerIdentity }),
        command,
      ).not.toThrow();
    }
  });

  it("passes unrestricted unchecked, with or without an identity", async () => {
    const gate = await createProfileEgressGate(backend(false));
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of NIR_COMMANDS) {
      expect(() => gate.assertInvoke(command, {}), command).not.toThrow();
      expect(
        () => gate.assertInvoke(command, { callerIdentity }),
        command,
      ).not.toThrow();
      expect(() =>
        gate.assertPlaintextPublication(command, { callerIdentity }),
      ).not.toThrow();
    }
  });

  it("refuses an identity Main did not issue, or issued to another sender or epoch", async () => {
    const gate = await createProfileEgressGate(backend(true));
    const issued = gate.issueCallerIdentity(11);
    gate.issueCallerIdentity(12);
    const forged = { ...issued, callerId: "forged" };
    const wrongSender = { ...issued, senderId: 12 };
    const stale = { ...issued, callerEpoch: issued.callerEpoch - 1 };
    const otherWorkspace = { ...issued, workspaceId: "/elsewhere" };
    for (const callerIdentity of [forged, wrongSender, stale, otherWorkspace]) {
      for (const command of NIR_COMMANDS) {
        expect(
          () => gate.assertInvoke(command, { callerIdentity }),
          command,
        ).toThrow(DENIED("unclassified"));
      }
    }
  });

  it("refuses every NIR command when the Native gate is unavailable", async () => {
    const gate = await createProfileEgressGate(null);
    expect(gate.unavailable).toBe(true);
    for (const command of NIR_COMMANDS) {
      expect(() => gate.assertInvoke(command, {}), command).toThrow(
        DENIED("nir1-publication"),
      );
    }
  });

  it("refuses at invoke while the first activation is in flight, then needs a post-activation identity", async () => {
    let release!: (value: string) => void;
    const settled = new Promise<string>((resolve) => {
      release = resolve;
    });
    const gate = await createProfileEgressGate(
      backend(false, {}, () => settled),
    );
    const before = gate.issueCallerIdentity(11);
    const activation = activateGateForTest(gate);
    for (const args of [{ callerIdentity: before }, {}]) {
      for (const command of NIR_COMMANDS) {
        expect(() => gate.assertInvoke(command, args), command).toThrow(
          DENIED("nir1-publication"),
        );
      }
    }
    release(
      JSON.stringify(status(true, { profileId: "profile-2", callerEpoch: 5 })),
    );
    await activation;
    // the pre-activation identity is gone; a freshly issued one passes
    for (const command of NIR_COMMANDS) {
      expect(() =>
        gate.assertInvoke(command, { callerIdentity: before }),
      ).toThrow(DENIED("unclassified"));
    }
    const after = gate.issueCallerIdentity(11);
    for (const command of NIR_COMMANDS) {
      expect(() =>
        gate.assertInvoke(command, { callerIdentity: after }),
      ).not.toThrow();
    }
  });
});

describe("gate: nir1-publication at completion (K3/2)", () => {
  it("lets a result complete with the identity it was admitted with", async () => {
    const gate = await createProfileEgressGate(backend(true));
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of NIR_COMMANDS) {
      expect(() =>
        gate.assertPlaintextPublication(command, { callerIdentity }),
      ).not.toThrow();
    }
  });

  it("refuses a result admitted before activation and completed after it", async () => {
    let release!: (value: string) => void;
    const settled = new Promise<string>((resolve) => {
      release = resolve;
    });
    const gate = await createProfileEgressGate(
      backend(false, {}, () => settled),
    );
    const admitted = gate.issueCallerIdentity(11);
    gate.assertInvoke("related_scenes_begin", { callerIdentity: admitted });
    const activation = activateGateForTest(gate);
    // activation in flight: the identity is still the issued one, but the
    // profile is being restricted
    for (const command of NIR_COMMANDS) {
      expect(
        () =>
          gate.assertPlaintextPublication(command, {
            callerIdentity: admitted,
          }),
        command,
      ).toThrow(DENIED(`nir1-publication`));
    }
    release(
      JSON.stringify(status(true, { profileId: "profile-2", callerEpoch: 5 })),
    );
    await activation;
    // activation done: the admitted identity is no longer the issued one
    for (const command of NIR_COMMANDS) {
      expect(
        () =>
          gate.assertPlaintextPublication(command, {
            callerIdentity: admitted,
          }),
        command,
      ).toThrow(DENIED("unclassified"));
    }
  });

  it("refuses a result whose identity was rotated by a workspace change", async () => {
    const gate = await createProfileEgressGate(backend(true));
    const admitted = gate.issueCallerIdentity(11);
    gate.observeBackendEvent?.("workspace:opened", { path: "/workspace-next" });
    for (const command of NIR_COMMANDS) {
      expect(
        () =>
          gate.assertPlaintextPublication(command, {
            callerIdentity: admitted,
          }),
        command,
      ).toThrow(DENIED("unclassified"));
    }
  });

  it("keeps the release command out of nir1-publication (it returns no plaintext)", async () => {
    const gate = await createProfileEgressGate(backend(true));
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of [
      "related_scenes_release",
      "related_scenes_release_owner",
    ]) {
      expect(d2aRouteLedgersForTest().nir1Publication).not.toContain(command);
    }
    expect(() =>
      gate.assertInvoke("related_scenes_release", { callerIdentity }),
    ).not.toThrow();
  });
});

describe("router: the identity reaches Native as a trailing argument only", () => {
  const event = (id = 11) => ({
    sender: { id, isDestroyed: () => false, once: vi.fn() },
  });

  async function routerWith(
    restricted: boolean,
    methods: Record<string, unknown>,
  ) {
    mocks.handlers.clear();
    const nativeBackend = backend(restricted, methods);
    const gate = await createProfileEgressGate(nativeBackend);
    registerIpcRouter(
      nativeBackend,
      {},
      undefined,
      undefined,
      { active: false },
      gate,
    );
    return { invoke: mocks.handlers.get(IPC.invoke)!, gate };
  }

  it("sends the Main-issued identity, never the renderer's, outside the request", async () => {
    const relatedScenesBegin = vi.fn(
      async (..._args: unknown[]) => '{"status":"raw-ready"}',
    );
    const relatedScenesContinue = vi.fn(
      async (..._args: unknown[]) => '{"status":"unavailable"}',
    );
    const relatedScenesGraphContinue = vi.fn(
      async (..._args: unknown[]) => '{"status":"unavailable"}',
    );
    const nir1EvidenceQualify = vi.fn(
      async (..._args: unknown[]) => '{"status":"unavailable"}',
    );
    const read = vi.fn(async (..._args: unknown[]) => '{"status":"available"}');
    const { invoke, gate } = await routerWith(true, {
      relatedScenesBegin,
      relatedScenesContinue,
      relatedScenesGraphContinue,
      nir1EvidenceQualify,
      nir1EntityRelationRevisionRead: read,
    });
    const issued = gate.issueCallerIdentity(11);
    const wire = JSON.stringify(issued);
    const forged = { ...issued, callerId: "renderer-forged" };

    await invoke(event(), "related_scenes_begin", {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s",
      query: "q",
      callerIdentity: forged,
    });
    await invoke(event(), "related_scenes_continue", {
      ownerKey: "x",
      operationTicket: "t",
      callerIdentity: forged,
    });
    await invoke(event(), "related_scenes_graph_continue", {
      operationTicket: "t",
      rawSceneIds: ["s1"],
      callerIdentity: forged,
    });
    await invoke(event(), "related_scenes_graph_continue", {
      operationTicket: "t",
      settle: "unused",
      callerIdentity: forged,
    });
    await invoke(event(), "nir1_evidence_qualify", {
      ownerKey: "x",
      navigationIdentity: "n",
      callerIdentity: forged,
    });
    await invoke(event(), "nir1_entity_relation_revision_read", {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      revisionId: "r",
      callerIdentity: forged,
    });
    for (const call of [
      relatedScenesBegin.mock.calls[0],
      relatedScenesContinue.mock.calls[0],
      relatedScenesGraphContinue.mock.calls[0],
      relatedScenesGraphContinue.mock.calls[1],
      nir1EvidenceQualify.mock.calls[0],
      read.mock.calls[0],
    ]) {
      expect(call?.at(-1)).toBe(wire);
      // no enumerable identity inside the typed request
      for (const arg of call?.slice(0, -1) ?? []) {
        if (arg !== null && typeof arg === "object") {
          expect(Object.keys(arg)).not.toContain("callerIdentity");
        }
      }
    }
    expect(JSON.stringify(relatedScenesBegin.mock.calls[0])).not.toContain(
      "renderer-forged",
    );
  });

  it("never reaches Native while the profile gate is unavailable", async () => {
    mocks.handlers.clear();
    const relatedScenesBegin = vi.fn(
      async (..._args: unknown[]) => '{"status":"raw-ready"}',
    );
    const nativeBackend = {
      relatedScenesBegin,
    } as unknown as NapiBackendLike;
    const gate = await createProfileEgressGate(null);
    expect(gate.unavailable).toBe(true);
    registerIpcRouter(
      nativeBackend,
      {},
      undefined,
      undefined,
      { active: false },
      gate,
    );
    const result = await mocks.handlers.get(IPC.invoke)!(
      event(),
      "related_scenes_begin",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "p",
        currentSceneId: "s",
        query: "q",
      },
    );
    expect(result.ok).toBe(false);
    expect(relatedScenesBegin).not.toHaveBeenCalled();
  });

  it("releases the pending operation of a begin result the completion check refuses, and leaks no owner or ticket", async () => {
    const relatedScenesRelease = vi.fn(
      async (..._args: unknown[]) => '{"status":"released"}',
    );
    let owner = "";
    const relatedScenesBegin = vi.fn(async (...args: unknown[]) => {
      owner = (args[0] as { ownerKey: string }).ownerKey;
      return JSON.stringify({
        status: "raw-ready",
        denseHits: [],
        ir: { status: "pending", operationTicket: "ticket-secret" },
      });
    });
    const { invoke, gate } = await routerWith(true, {
      relatedScenesBegin,
      relatedScenesRelease,
    });
    // The identity rotates while Native works: the completion check refuses.
    const origin = relatedScenesBegin.getMockImplementation()!;
    relatedScenesBegin.mockImplementation(async (...args: unknown[]) => {
      const value = await origin(...args);
      gate.observeBackendEvent?.("workspace:opened", { path: "/workspace-b" });
      return value;
    });
    const result = await invoke(event(), "related_scenes_begin", {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s",
      query: "q",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ticket-secret");
    expect(JSON.stringify(result)).not.toContain(owner);
    expect(relatedScenesRelease).toHaveBeenCalledExactlyOnceWith(
      owner,
      "ticket-secret",
    );
  });

  it("does not release anything when a published begin result passes the completion check", async () => {
    const relatedScenesRelease = vi.fn(
      async (..._args: unknown[]) => '{"status":"released"}',
    );
    const relatedScenesBegin = vi.fn(async () =>
      JSON.stringify({
        status: "raw-ready",
        denseHits: [],
        ir: { status: "pending", operationTicket: "ticket-1" },
      }),
    );
    const { invoke } = await routerWith(true, {
      relatedScenesBegin,
      relatedScenesRelease,
    });
    const result = await invoke(event(), "related_scenes_begin", {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s",
      query: "q",
    });
    expect(result.ok).toBe(true);
    expect(relatedScenesRelease).not.toHaveBeenCalled();
  });

  it("binds the Graph wait and settle to Main's owner and refuses a result whose identity rotated while Native worked", async () => {
    const calls: unknown[][] = [];
    const relatedScenesGraphContinue = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return JSON.stringify({
        status: "available",
        queryBinding: "binding-secret",
        pathAttachments: [],
        graphOnly: null,
      });
    });
    const relatedScenesRelease = vi.fn(
      async (..._args: unknown[]) => '{"status":"released"}',
    );
    const { invoke, gate } = await routerWith(true, {
      relatedScenesGraphContinue,
      relatedScenesRelease,
    });
    // the router issues the identity itself; the renderer's owner is replaced
    const original = relatedScenesGraphContinue.getMockImplementation()!;
    let rotate = false;
    relatedScenesGraphContinue.mockImplementation(
      async (...args: unknown[]) => {
        const value = await original(...args);
        if (rotate) {
          gate.observeBackendEvent?.("workspace:opened", {
            path: "/workspace-b",
          });
        }
        return value;
      },
    );
    const ok = await invoke(event(), "related_scenes_graph_continue", {
      ownerKey: "renderer-forged-owner",
      operationTicket: "t",
      rawSceneIds: ["s1"],
    });
    expect(ok.ok).toBe(true);
    const request = calls.at(-1)!;
    expect(request[0]).toMatch(/^related-scenes-owner:/);
    expect(request[0]).not.toBe("renderer-forged-owner");
    expect(request[1]).toEqual({ operationTicket: "t", rawSceneIds: ["s1"] });

    // the identity rotates while Native works: the completion check refuses
    // the plaintext, and nothing of it reaches the renderer
    rotate = true;
    const refused = await invoke(event(), "related_scenes_graph_continue", {
      operationTicket: "t",
      rawSceneIds: ["s1"],
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("binding-secret");
    expect(JSON.stringify(refused)).not.toContain(String(request[0]));
    // a Graph wait is not a begin: the router releases nothing on its own
    expect(relatedScenesRelease).not.toHaveBeenCalled();
  });

  it("lets the settle form complete under the same identity and carries no plaintext", async () => {
    const relatedScenesGraphContinue = vi.fn(
      async (..._args: unknown[]) => '{"status":"settled"}',
    );
    const { invoke, gate } = await routerWith(true, {
      relatedScenesGraphContinue,
    });
    expect(gate.issueCallerIdentity(11)).toBeDefined();
    const result = await invoke(event(), "related_scenes_graph_continue", {
      operationTicket: "t",
      settle: "cancelled",
    });
    expect(result).toEqual({ ok: true, value: { status: "settled" } });
    expect(relatedScenesGraphContinue.mock.calls[0]?.[1]).toEqual({
      operationTicket: "t",
      settle: "cancelled",
    });
  });
});
