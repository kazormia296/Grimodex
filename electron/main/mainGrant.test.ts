// CB-2 / S3 (K2/4 `graph-target-scene-body-disclosure`): Main's one-time
// confirmation (MG-1). F1-F6 and F8-F10 of the CB-2 acceptance.
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import {
  IPC,
  MAIN_GRANT_SIDECAR,
  NAPI_COMMANDS,
} from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      event: { sender: unknown },
      cmd: unknown,
      args: unknown,
    ) => Promise<Envelope>
  >(),
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showMessageBox: mocks.showMessageBox },
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

const {
  GRANT_REQUIRED_COMMANDS,
  MAIN_GRANT_BUSY,
  MAIN_GRANT_CANCELLED,
  MAIN_GRANT_REQUIRED,
  MAIN_GRANT_REVOKED,
  MAIN_GRANT_SENDER_UNAVAILABLE,
  createMainGrantController,
  isGrantRequiredCommand,
  stripRendererGrantFields,
} = await import("./mainGrant.js");
const { registerIpcRouter } = await import("./ipc.js");

const DECLARE = "narrative_scene_body_declaration_declare";
const REVOKE = "narrative_scene_body_declaration_revoke";
const DISPLAY = "NATIVE-DISPLAY\n対象: 本文の全体";
const GATE_CLOSED = "NEX_BODY_DECLARATION_REFUSED:gate-closed";

const VALUES = {
  story: "independent",
  auto: "independent",
  phase: "independent",
  reveal: "non-secret",
  pov: "independent",
};
const DECLARE_ARGS = () => ({
  expectedWorkspacePath: "/workspace/novel",
  payload: {
    projectId: "project-1",
    sceneId: "scene-1",
    requestId: "request-1",
    expected: {
      scopeVersion: 1,
      scopeToken: "token-1",
      declarationToken: null,
    },
    values: VALUES,
  },
});
const REVOKE_ARGS = () => ({
  expectedWorkspacePath: "/workspace/novel",
  payload: {
    projectId: "project-1",
    sceneId: "scene-1",
    requestId: "request-2",
    declarationToken: "declaration-token",
  },
});

class FakeEmitter extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
}
function fakeSender(id = 7) {
  return Object.assign(new FakeEmitter(), { id });
}
function fakeWindow(id = 11) {
  return Object.assign(new FakeEmitter(), { id });
}

function fakeBackend(overrides: Record<string, unknown> = {}) {
  const backend = {
    mainGrantPreview: vi.fn(async () =>
      JSON.stringify({
        previewId: "preview-secret",
        display: DISPLAY,
        expiresInMs: 60_000,
      }),
    ),
    mainGrantIssue: vi.fn(async () =>
      JSON.stringify({ grantId: "grant-secret" }),
    ),
    mainGrantRevoke: vi.fn(),
    mainGrantRevokeSender: vi.fn(),
    narrativeSceneBodyDeclarationDeclare: vi.fn(async () =>
      JSON.stringify({ outcome: "declared" }),
    ),
    narrativeSceneBodyDeclarationRevoke: vi.fn(async () =>
      JSON.stringify({ outcome: "revoked" }),
    ),
    ...overrides,
  };
  return backend;
}

/** A dialog that stays open until the test settles it. */
function heldDialog() {
  let settle: (response: number) => void = () => undefined;
  mocks.showMessageBox.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = (response) => resolve({ response, checkboxChecked: false });
      }),
  );
  return { settle: (response: number) => settle(response) };
}

function answerDialog(response: number): void {
  mocks.showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
}

function registerRouter(
  backend: ReturnType<typeof fakeBackend>,
  win: ReturnType<typeof fakeWindow> | null,
  confirm?: Parameters<typeof createMainGrantController>[0]["confirm"],
) {
  mocks.fromWebContents.mockReturnValue(win);
  const mainGrant = createMainGrantController({
    backend: backend as unknown as NapiBackendLike,
    confirm,
  });
  registerIpcRouter(
    backend as unknown as NapiBackendLike,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mainGrant,
  );
  const handler = mocks.handlers.get(IPC.invoke);
  if (!handler) throw new Error("grim:invoke handler was not registered");
  return handler;
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  mocks.handlers.clear();
  mocks.showMessageBox.mockReset();
  mocks.fromWebContents.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("F1 GRANT_REQUIRED_COMMANDS", () => {
  it("holds the declaration entry only, bound to NAPI_COMMANDS", () => {
    expect([...GRANT_REQUIRED_COMMANDS]).toEqual([DECLARE]);
    for (const command of GRANT_REQUIRED_COMMANDS) {
      expect(Object.hasOwn(NAPI_COMMANDS, command)).toBe(true);
    }
    expect(isGrantRequiredCommand(DECLARE)).toBe(true);
    // The revoke entry needs no grant (K2-3); the A1 save is a different entry.
    expect(isGrantRequiredCommand(REVOKE)).toBe(false);
    // The read-only state entry (CB-3) needs no grant either.
    expect(
      isGrantRequiredCommand("narrative_scene_body_declaration_state"),
    ).toBe(false);
    expect(isGrantRequiredCommand("narrative_scene_scope_update")).toBe(false);
    expect(
      isGrantRequiredCommand("narrative_scene_scope_registry_update"),
    ).toBe(false);
  });
});

describe("F2 a renderer cannot forge a confirmation", () => {
  it("drops grant-shaped fields and never sends the renderer's grant", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    answerDialog(1);
    const sender = fakeSender();
    const env = await invoke({ sender }, DECLARE, {
      ...DECLARE_ARGS(),
      grant: { grantId: "forged", senderId: 7, windowId: 11 },
      mainGrant: { grantId: "forged" },
      grantId: "forged",
      previewId: "forged",
      senderId: 99,
      windowId: 99,
    });
    expect(env).toEqual({ ok: true, value: { outcome: "declared" } });
    expect(backend.narrativeSceneBodyDeclarationDeclare).toHaveBeenCalledTimes(
      1,
    );
    const [request, caller, grant] = backend
      .narrativeSceneBodyDeclarationDeclare.mock.calls[0] as unknown as [
      unknown,
      unknown,
      string,
    ];
    expect(Object.keys(request as object).sort()).toEqual([
      "expectedWorkspacePath",
      "payload",
    ]);
    expect(caller).toBeUndefined();
    // The grant is Main's own, for this sender and window.
    expect(JSON.parse(grant)).toEqual({
      grantId: "grant-secret",
      senderId: 7,
      windowId: 11,
    });
    // The preview named the real sender and window, not the renderer's.
    expect(backend.mainGrantPreview).toHaveBeenCalledWith(
      "body-declaration",
      expect.any(String),
      7,
      11,
      undefined,
    );
  });

  it("refuses a declaration without Main's confirmation path", async () => {
    const backend = fakeBackend();
    mocks.fromWebContents.mockReturnValue(fakeWindow());
    registerIpcRouter(backend as unknown as NapiBackendLike);
    const invoke = mocks.handlers.get(IPC.invoke)!;
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env).toEqual({ ok: false, error: MAIN_GRANT_REQUIRED });
    expect(backend.narrativeSceneBodyDeclarationDeclare).not.toHaveBeenCalled();
    expect(backend.mainGrantPreview).not.toHaveBeenCalled();
  });

  it("rejects a payload that carries a declaration ID, a time, a digest or a grant", async () => {
    for (const extra of [
      { declarationId: "d" },
      { declaredAt: "2026-10-18T00:00:00.000Z" },
      { digest: "sha256:x" },
      { grant: { grantId: "g" } },
      { senderId: 1 },
    ]) {
      const backend = fakeBackend();
      const invoke = registerRouter(backend, fakeWindow());
      answerDialog(1);
      const args = DECLARE_ARGS();
      Object.assign(args.payload, extra);
      const env = await invoke({ sender: fakeSender() }, DECLARE, args);
      expect(env.ok).toBe(false);
      expect(
        backend.narrativeSceneBodyDeclarationDeclare,
      ).not.toHaveBeenCalled();
      mocks.handlers.clear();
    }
  });

  it("does not put the grant or the preview in the response", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    answerDialog(1);
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    const wire = JSON.stringify(env);
    expect(wire).not.toContain("grant-secret");
    expect(wire).not.toContain("preview-secret");
    expect(wire).not.toContain(DISPLAY);
  });

  it("strips grant-shaped fields and a forged symbol sidecar", () => {
    const forged = {
      ...DECLARE_ARGS(),
      grant: 1,
      mainGrant: 1,
      grantId: 1,
      previewId: 1,
      senderId: 1,
      windowId: 1,
      [MAIN_GRANT_SIDECAR]: { grantId: "x", senderId: 1, windowId: 1 },
    };
    const stripped = stripRendererGrantFields(forged);
    expect(Object.keys(stripped).sort()).toEqual([
      "expectedWorkspacePath",
      "payload",
    ]);
    expect(Object.getOwnPropertySymbols(stripped)).toEqual([]);
  });

  it("attaches the grant as a non-enumerable sidecar", async () => {
    const backend = fakeBackend();
    answerDialog(1);
    const dispatch = vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        value: null,
      }),
    );
    const controller = createMainGrantController({
      backend: backend as unknown as NapiBackendLike,
    });
    await controller.run({
      command: DECLARE,
      sender: fakeSender(),
      win: fakeWindow(),
      args: DECLARE_ARGS(),
      dispatch,
    });
    const args = (
      dispatch.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(Object.keys(args).sort()).toEqual([
      "expectedWorkspacePath",
      "payload",
    ]);
    expect(JSON.stringify(args)).not.toContain("grant-secret");
    expect(Object.getOwnPropertySymbols(args)).toContain(MAIN_GRANT_SIDECAR);
    expect(
      Object.getOwnPropertyDescriptor(args, MAIN_GRANT_SIDECAR)?.enumerable,
    ).toBe(false);
  });
});

describe("F3 the dialog text comes only from Native", () => {
  it("shows Native's display, defaults to Cancel, and ignores renderer text", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    answerDialog(0);
    const env = await invoke({ sender: fakeSender() }, DECLARE, {
      ...DECLARE_ARGS(),
      title: "FORGED TITLE",
      message: "FORGED MESSAGE",
      detail: "FORGED DETAIL",
    });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    const [parent, options] = mocks.showMessageBox.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(parent).toBeDefined();
    expect(options.message).toBe(DISPLAY);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    const buttons = options.buttons as string[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBe("キャンセル");
    expect(JSON.stringify(options)).not.toContain("FORGED");
    // Cancel is a closed refusal; nothing is issued or dispatched.
    expect(env).toEqual({ ok: false, error: MAIN_GRANT_CANCELLED });
    expect(backend.mainGrantIssue).not.toHaveBeenCalled();
    expect(backend.narrativeSceneBodyDeclarationDeclare).not.toHaveBeenCalled();
    expect(backend.mainGrantRevoke).toHaveBeenCalledWith("preview-secret");
  });

  it("closing the dialog (the cancel id) is not an approval", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    answerDialog(0);
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env.ok).toBe(false);
    expect(backend.mainGrantIssue).not.toHaveBeenCalled();
  });
});

describe("F4 a confirmation ends when its owner goes away", () => {
  const cases: Array<
    [
      string,
      (
        sender: ReturnType<typeof fakeSender>,
        win: ReturnType<typeof fakeWindow>,
      ) => void,
    ]
  > = [
    ["the sender is destroyed", (s) => s.emit("destroyed")],
    [
      "the renderer navigates",
      (s) => s.emit("did-start-navigation", { isMainFrame: true }),
    ],
    ["the render process is gone", (s) => s.emit("render-process-gone")],
    ["the window closes", (_s, w) => w.emit("closed")],
  ];

  for (const [name, trigger] of cases) {
    it(`revokes when ${name}, and a late approval is not honored`, async () => {
      const backend = fakeBackend();
      const sender = fakeSender();
      const win = fakeWindow();
      const invoke = registerRouter(backend, win);
      const dialog = heldDialog();
      const pending = invoke({ sender }, DECLARE, DECLARE_ARGS());
      await flush();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      trigger(sender, win);
      expect(backend.mainGrantRevokeSender).toHaveBeenCalledWith(7);
      expect(backend.mainGrantRevoke).toHaveBeenCalledWith("preview-secret");
      const signal = (
        mocks.showMessageBox.mock.calls[0][1] as { signal: AbortSignal }
      ).signal;
      expect(signal.aborted).toBe(true);
      dialog.settle(1);
      const env = await pending;
      expect(env).toEqual({ ok: false, error: MAIN_GRANT_REVOKED });
      expect(backend.mainGrantIssue).not.toHaveBeenCalled();
      expect(
        backend.narrativeSceneBodyDeclarationDeclare,
      ).not.toHaveBeenCalled();
    });
  }

  it("does not revoke for a subframe navigation", async () => {
    const backend = fakeBackend();
    const sender = fakeSender();
    const invoke = registerRouter(backend, fakeWindow());
    const dialog = heldDialog();
    const pending = invoke({ sender }, DECLARE, DECLARE_ARGS());
    await flush();
    sender.emit("did-start-navigation", { isMainFrame: false });
    expect(backend.mainGrantRevokeSender).not.toHaveBeenCalled();
    dialog.settle(1);
    expect((await pending).ok).toBe(true);
  });

  it("revokes when the preview's time runs out", async () => {
    vi.useFakeTimers();
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    const dialog = heldDialog();
    const pending = invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(backend.mainGrantRevoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.mainGrantRevoke).toHaveBeenCalledWith("preview-secret");
    const signal = (
      mocks.showMessageBox.mock.calls[0][1] as { signal: AbortSignal }
    ).signal;
    expect(signal.aborted).toBe(true);
    dialog.settle(1);
    expect(await pending).toEqual({ ok: false, error: MAIN_GRANT_REVOKED });
    expect(backend.mainGrantIssue).not.toHaveBeenCalled();
  });

  it("refuses at once when the sender or the window is already gone", async () => {
    const backend = fakeBackend();
    const sender = fakeSender();
    sender.destroyed = true;
    const invoke = registerRouter(backend, fakeWindow());
    expect(await invoke({ sender }, DECLARE, DECLARE_ARGS())).toEqual({
      ok: false,
      error: MAIN_GRANT_SENDER_UNAVAILABLE,
    });
    mocks.handlers.clear();
    const noWindow = registerRouter(fakeBackend(), null);
    expect(
      await noWindow({ sender: fakeSender() }, DECLARE, DECLARE_ARGS()),
    ).toEqual({
      ok: false,
      error: MAIN_GRANT_SENDER_UNAVAILABLE,
    });
    expect(backend.mainGrantPreview).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("revokes the preview Native creates after the sender went away", async () => {
    let resolvePreview: (json: string) => void = () => undefined;
    const backend = fakeBackend({
      mainGrantPreview: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvePreview = resolve;
          }),
      ),
    });
    const sender = fakeSender();
    const invoke = registerRouter(backend, fakeWindow());
    const pending = invoke({ sender }, DECLARE, DECLARE_ARGS());
    await flush();
    sender.emit("destroyed");
    // Nothing existed in Native's slot yet, so this revoke found no preview.
    expect(backend.mainGrantRevoke).not.toHaveBeenCalled();
    resolvePreview(
      JSON.stringify({
        previewId: "late-preview",
        display: DISPLAY,
        expiresInMs: 60_000,
      }),
    );
    expect(await pending).toEqual({ ok: false, error: MAIN_GRANT_REVOKED });
    expect(backend.mainGrantRevoke).toHaveBeenCalledWith("late-preview");
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(backend.mainGrantIssue).not.toHaveBeenCalled();
  });

  it("revokes the grant when the writer answers with a failure envelope", async () => {
    const backend = fakeBackend({
      narrativeSceneBodyDeclarationDeclare: vi.fn(async () => {
        throw new Error("D2A_EGRESS_DENIED: admission");
      }),
    });
    const invoke = registerRouter(backend, fakeWindow());
    answerDialog(1);
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env.ok).toBe(false);
    expect(backend.mainGrantRevoke).toHaveBeenCalledWith("preview-secret");
    expect(backend.mainGrantRevokeSender).toHaveBeenCalledWith(7);
  });

  it("removes its listeners when the confirmation ends", async () => {
    const backend = fakeBackend();
    const sender = fakeSender();
    const win = fakeWindow();
    const invoke = registerRouter(backend, win);
    answerDialog(1);
    await invoke({ sender }, DECLARE, DECLARE_ARGS());
    for (const event of [
      "destroyed",
      "render-process-gone",
      "did-start-navigation",
    ]) {
      expect(sender.listenerCount(event), event).toBe(0);
    }
    expect(win.listenerCount("closed")).toBe(0);
  });
});

describe("F5 a second confirmation is refused, not queued", () => {
  it("answers MAIN_GRANT_BUSY while a dialog is open, then recovers", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    const dialog = heldDialog();
    const first = invoke({ sender: fakeSender(7) }, DECLARE, DECLARE_ARGS());
    await flush();
    const second = await invoke(
      { sender: fakeSender(8) },
      DECLARE,
      DECLARE_ARGS(),
    );
    expect(second).toEqual({ ok: false, error: MAIN_GRANT_BUSY });
    // The second request never reached Native or the dialog.
    expect(backend.mainGrantPreview).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    dialog.settle(1);
    expect((await first).ok).toBe(true);
    answerDialog(1);
    expect(
      (await invoke({ sender: fakeSender(9) }, DECLARE, DECLARE_ARGS())).ok,
    ).toBe(true);
  });

  it("passes Native's busy refusal through as the closed code", async () => {
    const backend = fakeBackend({
      mainGrantPreview: vi.fn(async () => {
        throw new Error("Error: MAIN_GRANT_BUSY");
      }),
    });
    const invoke = registerRouter(backend, fakeWindow());
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env).toEqual({ ok: false, error: MAIN_GRANT_BUSY });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});

describe("F6 a closed gate means no dialog", () => {
  it("refuses with Native's closed code and shows nothing", async () => {
    const backend = fakeBackend({
      mainGrantPreview: vi.fn(async () => {
        throw new Error(`Error: ${GATE_CLOSED} /secret/workspace/path`);
      }),
    });
    const invoke = registerRouter(backend, fakeWindow());
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env).toEqual({ ok: false, error: GATE_CLOSED });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(backend.mainGrantIssue).not.toHaveBeenCalled();
    expect(backend.narrativeSceneBodyDeclarationDeclare).not.toHaveBeenCalled();
  });

  it("maps an unknown Native failure to a closed code without its text", async () => {
    const backend = fakeBackend({
      mainGrantPreview: vi.fn(async () => {
        throw new Error("sqlite: /home/author/secret title 'Chapter'");
      }),
    });
    const invoke = registerRouter(backend, fakeWindow());
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env.ok).toBe(false);
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("revokes when issue fails and does not dispatch", async () => {
    const backend = fakeBackend({
      mainGrantIssue: vi.fn(async () => {
        throw new Error("MAIN_GRANT_STATE_CHANGED");
      }),
    });
    const invoke = registerRouter(backend, fakeWindow());
    answerDialog(1);
    const env = await invoke({ sender: fakeSender() }, DECLARE, DECLARE_ARGS());
    expect(env).toEqual({ ok: false, error: "MAIN_GRANT_STATE_CHANGED" });
    expect(backend.mainGrantRevoke).toHaveBeenCalledWith("preview-secret");
    expect(backend.narrativeSceneBodyDeclarationDeclare).not.toHaveBeenCalled();
  });
});

describe("the revoke entry needs no confirmation (K2-3)", () => {
  it("dispatches without a preview, a dialog or a grant", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    const env = await invoke({ sender: fakeSender() }, REVOKE, REVOKE_ARGS());
    expect(env).toEqual({ ok: true, value: { outcome: "revoked" } });
    expect(backend.mainGrantPreview).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(backend.narrativeSceneBodyDeclarationRevoke).toHaveBeenCalledTimes(
      1,
    );
    // Exactly the request and no trailing grant.
    expect(
      backend.narrativeSceneBodyDeclarationRevoke.mock.calls[0],
    ).toHaveLength(1);
  });

  it("rejects a revoke request that carries a grant-shaped field", async () => {
    const backend = fakeBackend();
    const invoke = registerRouter(backend, fakeWindow());
    const env = await invoke({ sender: fakeSender() }, REVOKE, {
      ...REVOKE_ARGS(),
      grant: { grantId: "forged" },
    });
    expect(env.ok).toBe(false);
    expect(backend.narrativeSceneBodyDeclarationRevoke).not.toHaveBeenCalled();
  });
});

describe("F8 the Main-only calls are not reachable from IPC", () => {
  it("keeps the grant and gate calls out of NAPI_COMMANDS", () => {
    const names = Object.keys(NAPI_COMMANDS);
    for (const forbidden of [
      "main_grant_preview",
      "main_grant_issue",
      "main_grant_revoke",
      "main_grant_revoke_sender",
      "main_open_pre_publication_gate",
      "mainGrantPreview",
      "mainGrantIssue",
      "mainGrantRevoke",
      "mainGrantRevokeSender",
      "mainOpenPrePublicationGate",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("answers an unknown command for each Main-only call", async () => {
    const openGate = vi.fn();
    const backend = fakeBackend({ mainOpenPrePublicationGate: openGate });
    const invoke = registerRouter(backend, fakeWindow());
    for (const command of [
      "main_grant_preview",
      "main_grant_issue",
      "main_grant_revoke",
      "main_grant_revoke_sender",
      "main_open_pre_publication_gate",
      "mainOpenPrePublicationGate",
    ]) {
      const env = await invoke({ sender: fakeSender() }, command, {
        kind: "body-declaration",
      });
      expect(env.ok, command).toBe(false);
    }
    expect(backend.mainGrantPreview).not.toHaveBeenCalled();
    expect(backend.mainGrantIssue).not.toHaveBeenCalled();
    expect(backend.mainGrantRevoke).not.toHaveBeenCalled();
    expect(backend.mainGrantRevokeSender).not.toHaveBeenCalled();
    expect(openGate).not.toHaveBeenCalled();
  });
});

describe("F10 the A1 save never opens a dialog", () => {
  it("rejects a declaration field on narrative_scene_scope_update", async () => {
    const update = vi.fn(async () => "{}");
    const backend = fakeBackend({ narrativeSceneScopeUpdate: update });
    const invoke = registerRouter(backend, fakeWindow());
    const env = await invoke(
      { sender: fakeSender() },
      "narrative_scene_scope_update",
      {
        expectedWorkspacePath: "/workspace/novel",
        payload: {
          projectId: "project-1",
          sceneId: "scene-1",
          requestId: "r",
          sessionId: "s",
          eventUid: "e",
          baseVersion: 1,
          updatedAt: "2026-10-18T00:00:00.000Z",
          scope: {},
          bodyDeclaration: VALUES,
        },
        declare: true,
      },
    );
    expect(env.ok).toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(backend.mainGrantPreview).not.toHaveBeenCalled();
  });
});
