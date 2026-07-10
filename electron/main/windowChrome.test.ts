/**
 * windowChrome の単体テスト（設計書 §8 S6）。
 * - buildMainWindowOptions: §6.1 パリティ表 + §6.7 window-state 復元優先
 * - applicationMenuPolicy: §6.1 メニュー方針（zoom ロールなし）
 * - createCloseVetoController: §6.4 の 4 手順 + 1,500ms タイマ満了パス
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applicationMenuPolicy,
  buildMainWindowOptions,
  CLOSE_VETO_TIMEOUT_MS,
  createCloseVetoController,
  MAIN_WINDOW_DEFAULTS,
  TRAFFIC_LIGHT_POSITION,
} from "./windowChrome.js";
import type { CloseVetoController } from "./windowChrome.js";
import type { WindowBounds } from "./windowState.js";

const PRIMARY: WindowBounds = { x: 0, y: 0, width: 1920, height: 1080 };

describe("buildMainWindowOptions (§6.1 パリティ表)", () => {
  it("linux: frame:false + tauri.conf.json と同値のサイズ / transparent", () => {
    const { options, startMaximized } = buildMainWindowOptions({
      platform: "linux",
      savedState: undefined,
      displayWorkAreas: [PRIMARY],
    });
    expect(options.frame).toBe(false);
    expect(options.titleBarStyle).toBeUndefined();
    expect(options.trafficLightPosition).toBeUndefined();
    expect(options.width).toBe(800);
    expect(options.height).toBe(600);
    expect(options.minWidth).toBe(600);
    expect(options.minHeight).toBe(400);
    expect(options.transparent).toBe(true);
    expect(options.backgroundColor).toBe("#00000000");
    expect(options.show).toBe(false);
    expect(startMaximized).toBe(false);
  });

  it("win32: frame:false（linux と同じ decorations:false 写像）", () => {
    const { options } = buildMainWindowOptions({
      platform: "win32",
      savedState: undefined,
      displayWorkAreas: [PRIMARY],
    });
    expect(options.frame).toBe(false);
    expect(options.titleBarStyle).toBeUndefined();
  });

  it("darwin: titleBarStyle hidden + trafficLightPosition（frame は残す）", () => {
    const { options } = buildMainWindowOptions({
      platform: "darwin",
      savedState: undefined,
      displayWorkAreas: [PRIMARY],
    });
    expect(options.frame).toBeUndefined();
    expect(options.titleBarStyle).toBe("hidden");
    expect(options.trafficLightPosition).toEqual(TRAFFIC_LIGHT_POSITION);
  });

  it("保存済み bounds（画面内）はデフォルトより優先して復元される（§6.7）", () => {
    const { options } = buildMainWindowOptions({
      platform: "linux",
      savedState: {
        bounds: { x: 120, y: 80, width: 1280, height: 720 },
        maximized: false,
      },
      displayWorkAreas: [PRIMARY],
    });
    expect(options.x).toBe(120);
    expect(options.y).toBe(80);
    expect(options.width).toBe(1280);
    expect(options.height).toBe(720);
  });

  it("画面外の保存 bounds は捨ててデフォルト位置に落とす", () => {
    const { options } = buildMainWindowOptions({
      platform: "linux",
      savedState: {
        bounds: { x: 4000, y: 4000, width: 1280, height: 720 },
        maximized: false,
      },
      displayWorkAreas: [PRIMARY],
    });
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
    expect(options.width).toBe(MAIN_WINDOW_DEFAULTS.width);
    expect(options.height).toBe(MAIN_WINDOW_DEFAULTS.height);
  });

  it("最小サイズ未満の保存 bounds は min 600x400 へクランプ", () => {
    const { options } = buildMainWindowOptions({
      platform: "linux",
      savedState: {
        bounds: { x: 10, y: 10, width: 320, height: 200 },
        maximized: false,
      },
      displayWorkAreas: [PRIMARY],
    });
    expect(options.width).toBe(600);
    expect(options.height).toBe(400);
  });

  it("maximized:true の保存 state は startMaximized で復元される", () => {
    const { options, startMaximized } = buildMainWindowOptions({
      platform: "linux",
      savedState: {
        bounds: { x: 120, y: 80, width: 1280, height: 720 },
        maximized: true,
      },
      displayWorkAreas: [PRIMARY],
    });
    expect(startMaximized).toBe(true);
    // unmaximize 後に戻る normal bounds も同時に復元される
    expect(options.width).toBe(1280);
  });

  it("画面外 bounds でも maximized は現ディスプレイで復元する", () => {
    const { options, startMaximized } = buildMainWindowOptions({
      platform: "linux",
      savedState: {
        bounds: { x: 4000, y: 4000, width: 1280, height: 720 },
        maximized: true,
      },
      displayWorkAreas: [PRIMARY],
    });
    expect(startMaximized).toBe(true);
    expect(options.x).toBeUndefined();
  });
});

describe("applicationMenuPolicy (§6.1 メニュー方針)", () => {
  it("win/linux は null メニュー（Menu.setApplicationMenu(null)）", () => {
    expect(applicationMenuPolicy("linux")).toEqual({ kind: "null" });
    expect(applicationMenuPolicy("win32")).toEqual({ kind: "null" });
  });

  it("macOS は appMenu/editMenu/windowMenu の最小ロール構成", () => {
    const policy = applicationMenuPolicy("darwin");
    expect(policy.kind).toBe("roles");
    if (policy.kind !== "roles") return;
    expect(policy.roles).toContain("editMenu");
    expect(policy.roles).toContain("windowMenu");
  });

  it("zoomHotkeysEnabled:false パリティ: zoom 系ロールを載せない", () => {
    const policy = applicationMenuPolicy("darwin");
    if (policy.kind !== "roles") throw new Error("expected roles policy");
    const roles = policy.roles as readonly string[];
    expect(roles).not.toContain("viewMenu");
    expect(roles).not.toContain("zoomIn");
    expect(roles).not.toContain("zoomOut");
    expect(roles).not.toContain("resetZoom");
  });
});

describe("createCloseVetoController (§6.4 close veto プロトコル)", () => {
  let requestClose: ReturnType<typeof vi.fn>;
  let forceClose: ReturnType<typeof vi.fn>;
  let controller: CloseVetoController;

  beforeEach(() => {
    vi.useFakeTimers();
    requestClose = vi.fn();
    forceClose = vi.fn();
    controller = createCloseVetoController({
      requestClose: requestClose as () => void,
      forceClose: forceClose as () => void,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("手順 4: ハンドラ未登録の窓は問い合わせなしで即 close", () => {
    expect(controller.onCloseEvent()).toBe(true);
    expect(requestClose).not.toHaveBeenCalled();
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("手順 1: 登録済みなら preventDefault + close-requested 送信 + タイマ開始", () => {
    controller.setHandlerRegistered(true);
    expect(controller.onCloseEvent()).toBe(false);
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("手順 3: veto=false 応答で close を再発行し、以後は素通し", () => {
    controller.setHandlerRegistered(true);
    controller.onCloseEvent();
    controller.onReply(false);
    expect(forceClose).toHaveBeenCalledTimes(1);
    // 再発行された close イベントは preventDefault しない
    expect(controller.onCloseEvent()).toBe(true);
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("veto=true 応答では閉じず、次の close 要求で改めて問い合わせる", () => {
    controller.setHandlerRegistered(true);
    controller.onCloseEvent();
    controller.onReply(true);
    expect(forceClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CLOSE_VETO_TIMEOUT_MS * 2);
    expect(forceClose).not.toHaveBeenCalled(); // veto でタイマも破棄済み
    expect(controller.onCloseEvent()).toBe(false); // 再問い合わせ
    expect(requestClose).toHaveBeenCalledTimes(2);
  });

  it("タイマ満了（renderer ハング）で close を強制再発行する", () => {
    controller.setHandlerRegistered(true);
    controller.onCloseEvent();
    vi.advanceTimersByTime(CLOSE_VETO_TIMEOUT_MS - 1);
    expect(forceClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(controller.onCloseEvent()).toBe(true);
  });

  it("タイマ満了後の遅延 reply は無視される（二重 close なし）", () => {
    controller.setHandlerRegistered(true);
    controller.onCloseEvent();
    vi.advanceTimersByTime(CLOSE_VETO_TIMEOUT_MS);
    expect(forceClose).toHaveBeenCalledTimes(1);
    controller.onReply(false);
    expect(forceClose).toHaveBeenCalledTimes(1);
    controller.onReply(true);
    expect(controller.onCloseEvent()).toBe(true); // veto 遅延 reply でも素通しのまま
  });

  it("問い合わせ中の二重 close 要求は再送しない", () => {
    controller.setHandlerRegistered(true);
    expect(controller.onCloseEvent()).toBe(false);
    expect(controller.onCloseEvent()).toBe(false);
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("問い合わせ前の reply（迷子 reply）は無視される", () => {
    controller.setHandlerRegistered(true);
    controller.onReply(false);
    expect(forceClose).not.toHaveBeenCalled();
    expect(controller.onCloseEvent()).toBe(false); // 状態は汚れていない
  });

  it("dispose で進行中タイマを破棄する（closed 後の close 発行なし）", () => {
    controller.setHandlerRegistered(true);
    controller.onCloseEvent();
    controller.dispose();
    vi.advanceTimersByTime(CLOSE_VETO_TIMEOUT_MS * 2);
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("setHandlerRegistered(false) へ戻すと再び即 close になる", () => {
    controller.setHandlerRegistered(true);
    controller.setHandlerRegistered(false);
    expect(controller.onCloseEvent()).toBe(true);
    expect(requestClose).not.toHaveBeenCalled();
  });

  it("タイムアウト既定値は 1,500ms（§6.4）で、timeoutMs で上書きできる", () => {
    expect(CLOSE_VETO_TIMEOUT_MS).toBe(1500);
    const shortForce = vi.fn();
    const short = createCloseVetoController({
      requestClose: vi.fn() as () => void,
      forceClose: shortForce as () => void,
      timeoutMs: 100,
    });
    short.setHandlerRegistered(true);
    short.onCloseEvent();
    vi.advanceTimersByTime(100);
    expect(shortForce).toHaveBeenCalledTimes(1);
  });
});
