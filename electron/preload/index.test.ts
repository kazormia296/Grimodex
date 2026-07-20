/**
 * preload の単体テスト（設計書 §6.4 手順 2 / §5.4、Phase 2 S6）。
 *
 * electron をモックして preload を import し、contextBridge に公開される
 * GrimodexBridge の close veto 応答・ハンドラ登録数通知・resize 通知・
 * イベント多重化を検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/ipcContract.js";

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
  listen(channel: string, cb: (payload: unknown) => void): () => void;
  emit(channel: string, payload?: unknown): Promise<void>;
  dialog: {
    openWebEditorHandoff(): Promise<{
      name: string;
      content: string;
    } | null>;
  };
  windowControls: {
    onResized(cb: () => void): () => void;
    onCloseRequested(cb: () => boolean): () => void;
  };
}

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
  mocks.onHandlers.clear();
  mocks.send.mockClear();
  mocks.invoke.mockClear();
  mocks.exposed.name = "";
  mocks.exposed.bridge = undefined;
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
      throw new Error("boom");
    });
    bridge.windowControls.onCloseRequested(after);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fire(IPC.closeRequested);
    errorSpy.mockRestore();
    expect(after).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(IPC.closeReply, { veto: false });
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
