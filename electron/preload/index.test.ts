/**
 * preload の単体テスト（設計書 §6.4 手順 2 / §5.4、Phase 2 S6）。
 *
 * electron をモックして preload を import し、contextBridge に公開される
 * GrimodexBridge の close veto 応答・ハンドラ登録数通知・resize 通知・
 * イベント多重化を検証する。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC,
  type CaptureCurrentChatInputReceipt,
  type CaptureCurrentChatInputSubmission,
  type Envelope,
} from "../shared/ipcContract.js";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const mocks = vi.hoisted(() => ({
  onHandlers: new Map<string, IpcListener>(),
  send: vi.fn(),
  invoke: vi.fn(),
  exposed: { name: "", bridge: undefined as unknown },
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, bridge: unknown) => {
      mocks.exposed.name = name;
      mocks.exposed.bridge = bridge;
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: IpcListener) => {
      mocks.onHandlers.set(channel, listener);
    },
    send: (...args: unknown[]) => {
      mocks.send(...args);
    },
    invoke: (...args: unknown[]) => mocks.invoke(...args) as Promise<unknown>,
  },
}));

/** preload が公開するブリッジの、このテストで使う部分の構造型。 */
interface BridgeUnderTest {
  shell: string;
  runtimePerformance?: {
    ownerToken: string;
  };
  listen(channel: string, cb: (payload: unknown) => void): () => void;
  emit(channel: string, payload?: unknown): Promise<void>;
  invoke(cmd: string, args?: Record<string, unknown>): Promise<Envelope>;
  dialog: {
    openWebEditorHandoff(): Promise<{
      name: string;
      content: string;
    } | null>;
  };
  panelWindow: {
    existsByLabel(label: string): Promise<boolean>;
  };
  windowControls: {
    toggleFullscreen(): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    onResized(cb: () => void): () => void;
    onCloseRequested(cb: () => boolean): () => void;
  };
}

const runtimePerformanceOwnerTokenEnv =
  "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN";
const originalRuntimePerformanceOwnerToken =
  process.env[runtimePerformanceOwnerTokenEnv];

describe("window fullscreen bridge", () => {
  it("maps fullscreen operations onto the allowlisted window-control channel", async () => {
    const bridge = await loadPreload();
    mocks.invoke
      .mockResolvedValueOnce({ ok: true, value: true })
      .mockResolvedValueOnce({ ok: true, value: false });

    await expect(bridge.windowControls.toggleFullscreen()).resolves.toBe(true);
    await expect(bridge.windowControls.isFullscreen()).resolves.toBe(false);

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      IPC.windowControl,
      "toggleFullscreen",
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.windowControl,
      "isFullscreen",
    );
  });
});

describe("current Human capture invoke bridge", () => {
  it("uses the existing invoke envelope without renderer caller authority", async () => {
    const bridge = await loadPreload();
    const submission: CaptureCurrentChatInputSubmission = {
      submissionId: "capture-submit-1",
      messageId: "capture-message-1",
      chatSessionId: "chat-session-1",
      sceneId: "scene-1",
      content: "local composer text",
      createdAt: "2026-09-28T10:00:00.000Z",
    };
    const receipt: CaptureCurrentChatInputReceipt = {
      status: "accepted",
      projectId: "project-1",
      chatSessionId: submission.chatSessionId,
      sceneId: submission.sceneId,
      messageId: submission.messageId,
    };
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: receipt });

    await expect(
      bridge.invoke("capture_current_chat_input", { submission }),
    ).resolves.toEqual({ ok: true, value: receipt });
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.invoke,
      "capture_current_chat_input",
      { submission },
    );
  });
});

describe("panel window bridge", () => {
  it("maps the read-only existence probe onto its dedicated channel", async () => {
    const bridge = await loadPreload();
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: true });

    await expect(
      bridge.panelWindow.existsByLabel("panel-scenes"),
    ).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.panelExists, "panel-scenes");
  });
});

async function loadPreload(): Promise<BridgeUnderTest> {
  await import("./index.js");
  expect(mocks.exposed.name).toBe("grimodex");
  return mocks.exposed.bridge as BridgeUnderTest;
}

function fire(channel: string, ...args: unknown[]): void {
  const listener = mocks.onHandlers.get(channel);
  if (!listener) throw new Error(`no ipcRenderer.on listener for ${channel}`);
  listener({}, ...args);
}

beforeEach(() => {
  vi.resetModules();
  delete process.env[runtimePerformanceOwnerTokenEnv];
  mocks.onHandlers.clear();
  mocks.send.mockClear();
  mocks.invoke.mockReset();
  mocks.exposed.name = "";
  mocks.exposed.bridge = undefined;
});

afterAll(() => {
  if (originalRuntimePerformanceOwnerToken === undefined) {
    delete process.env[runtimePerformanceOwnerTokenEnv];
  } else {
    process.env[runtimePerformanceOwnerTokenEnv] =
      originalRuntimePerformanceOwnerToken;
  }
});

describe("runtime performance capability", () => {
  it("is absent from the normal production preload bridge", async () => {
    const bridge = await loadPreload();
    expect(bridge.runtimePerformance).toBeUndefined();
  });

  it("exposes only a valid owner token supplied before preload import", async () => {
    const ownerToken = "11111111-1111-4111-8111-111111111111";
    process.env[runtimePerformanceOwnerTokenEnv] = ownerToken;

    const bridge = await loadPreload();

    expect(bridge.runtimePerformance).toEqual({ ownerToken });
    expect(Object.isFrozen(bridge.runtimePerformance)).toBe(true);
  });

  it("rejects malformed environment values instead of creating a capability", async () => {
    process.env[runtimePerformanceOwnerTokenEnv] = "not-a-benchmark-token";

    const bridge = await loadPreload();

    expect(bridge.runtimePerformance).toBeUndefined();
  });
});

describe("close veto プロトコル（§6.4 手順 2）", () => {
  it("ハンドラ未登録でも close-requested には veto:false で即応答する", async () => {
    await loadPreload();
    fire(IPC.closeRequested);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeReply, { veto: false });
  });

  it("登録ハンドラが true を返したら veto:true を返す", async () => {
    const bridge = await loadPreload();
    bridge.windowControls.onCloseRequested(() => true);
    fire(IPC.closeRequested);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeReply, { veto: true });
  });

  it("複数ハンドラは OR 合成（1 つでも veto なら veto）", async () => {
    const bridge = await loadPreload();
    bridge.windowControls.onCloseRequested(() => false);
    bridge.windowControls.onCloseRequested(() => true);
    bridge.windowControls.onCloseRequested(() => false);
    fire(IPC.closeRequested);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeReply, { veto: true });
  });

  it("ハンドラ例外は veto しない側に倒し、他のハンドラも実行される", async () => {
    const bridge = await loadPreload();
    const after = vi.fn(() => false);
    bridge.windowControls.onCloseRequested(() => {
      throw new Error("private manuscript path: /home/user/secret.gri");
    });
    bridge.windowControls.onCloseRequested(after);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fire(IPC.closeRequested);
    expect(after).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeReply, { veto: false });
    expect(errorSpy).toHaveBeenCalledWith(
      "[grimodex] close-requested handler failed",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "private manuscript",
    );
    errorSpy.mockRestore();
  });

  it("登録 / 解除でハンドラ数を main に通知する（§6.4 手順 4 の判定材料）", async () => {
    const bridge = await loadPreload();
    const unlisten = bridge.windowControls.onCloseRequested(() => false);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeHandlerChanged, 1);
    const second = bridge.windowControls.onCloseRequested(() => false);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeHandlerChanged, 2);
    unlisten();
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeHandlerChanged, 1);
    second();
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeHandlerChanged, 0);
    // 二重解除では再通知しない
    mocks.send.mockClear();
    unlisten();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("resize 通知（§6.3）", () => {
  it("grim:window-resized を登録済み cb 全員へ配る", async () => {
    const bridge = await loadPreload();
    const a = vi.fn();
    const b = vi.fn();
    bridge.windowControls.onResized(a);
    const unlistenB = bridge.windowControls.onResized(b);
    fire(IPC.windowResized);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unlistenB();
    fire(IPC.windowResized);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("resize handler の例外内容を console へ漏らさず、後続 handler を実行する", async () => {
    const bridge = await loadPreload();
    const after = vi.fn();
    bridge.windowControls.onResized(() => {
      throw new Error("SECRET_NOVEL_SENTINEL");
    });
    bridge.windowControls.onResized(after);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fire(IPC.windowResized);

    expect(after).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith("[grimodex] resize handler failed");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "SECRET_NOVEL_SENTINEL",
    );
    errorSpy.mockRestore();
  });
});

describe("イベント多重化（§7.2 — grim:event 1 本）", () => {
  it("チャネル別に払い出し、unlisten で解除される", async () => {
    const bridge = await loadPreload();
    const cb = vi.fn();
    const unlisten = bridge.listen("codex:data-changed", cb);
    fire(IPC.event, "codex:data-changed", { rev: 1 });
    fire(IPC.event, "codex:lock-event", { rev: 2 }); // 別チャネルは届かない
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ rev: 1 });
    unlisten();
    fire(IPC.event, "codex:data-changed", { rev: 3 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("listener の例外内容を console へ漏らさず、同一 channel の後続 listener を実行する", async () => {
    const bridge = await loadPreload();
    const after = vi.fn();
    bridge.listen("codex:data-changed", () => {
      throw new Error("SECRET_NOVEL_SENTINEL");
    });
    bridge.listen("codex:data-changed", after);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fire(IPC.event, "codex:data-changed", { rev: 1 });

    expect(after).toHaveBeenCalledWith({ rev: 1 });
    expect(errorSpy).toHaveBeenCalledWith(
      "[grimodex] event listener failed (codex:data-changed)",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "SECRET_NOVEL_SENTINEL",
    );
    errorSpy.mockRestore();
  });

  it("allowlist 外チャネルは listen / emit とも拒否する（§5.4）", async () => {
    const bridge = await loadPreload();
    expect(() => bridge.listen("evil:channel", vi.fn() as () => void)).toThrow(
      "EVENT_CHANNEL_NOT_ALLOWED",
    );
    // emit は同期検証で throw する（contextBridge 越しでは reject に翻訳される）
    expect(() => bridge.emit("evil:channel")).toThrow(
      "EVENT_CHANNEL_NOT_ALLOWED",
    );
    expect(mocks.send).not.toHaveBeenCalledWith(
      IPC.emit,
      "evil:channel",
      undefined,
    );
  });

  it.each([
    "chat:stream-done",
    "license:state_changed",
    "backend:ready",
    "updater:download-progress",
  ])("renderer は %s を emit できない", async (channel) => {
    const bridge = await loadPreload();
    expect(() => bridge.emit(channel)).toThrow("EVENT_CHANNEL_NOT_ALLOWED");
    expect(mocks.send).not.toHaveBeenCalledWith(IPC.emit, channel, undefined);
  });

  it("listen は backend / main event を受信できる", async () => {
    const bridge = await loadPreload();
    const backendCb = vi.fn();
    const mainCb = vi.fn();
    bridge.listen("chat:stream-done", backendCb);
    bridge.listen("updater:download-progress", mainCb);

    fire(IPC.event, "chat:stream-done", { messageId: "m1" });
    fire(IPC.event, "updater:download-progress", { downloaded: 1 });

    expect(backendCb).toHaveBeenCalledWith({ messageId: "m1" });
    expect(mainCb).toHaveBeenCalledWith({ downloaded: 1 });
  });
});

describe("Web Editor handoff bridge", () => {
  it("専用のbounded main読込チャネルだけを呼ぶ", async () => {
    const picked = {
      name: "draft.grimodex-handoff",
      content: "{}",
    };
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: picked });
    const bridge = await loadPreload();

    await expect(bridge.dialog.openWebEditorHandoff()).resolves.toEqual(picked);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC.dialogOpenWebEditorHandoff,
    );
  });
});
