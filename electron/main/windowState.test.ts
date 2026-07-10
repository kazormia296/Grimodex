/**
 * windowState の単体テスト（設計書 §8 S4 — bounds 補正の純関数 + 永続化）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampBoundsToDisplays,
  createWindowStateStore,
  sanitizeWindowStates,
} from "./windowState.js";
import type { WindowBounds } from "./windowState.js";

const PRIMARY: WindowBounds = { x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY: WindowBounds = { x: 1920, y: 0, width: 1280, height: 1024 };

describe("clampBoundsToDisplays", () => {
  it("ディスプレイ内に収まる bounds はそのまま", () => {
    const b = { x: 100, y: 100, width: 800, height: 600 };
    expect(clampBoundsToDisplays(b, [PRIMARY])).toEqual(b);
  });

  it("セカンダリディスプレイ上の bounds も生きる", () => {
    const b = { x: 2000, y: 50, width: 800, height: 600 };
    expect(clampBoundsToDisplays(b, [PRIMARY, SECONDARY])).toEqual(b);
  });

  it("完全に画面外（外したモニタ跡地）は null → 呼び出し側でデフォルトへ", () => {
    const b = { x: 4000, y: 0, width: 800, height: 600 };
    expect(clampBoundsToDisplays(b, [PRIMARY])).toBeNull();
  });

  it("わずかしか見えていない（掴めない）bounds も null", () => {
    // 右下に 50x20 だけ食い込んでいる
    const b = { x: 1870, y: 1060, width: 800, height: 600 };
    expect(clampBoundsToDisplays(b, [PRIMARY])).toBeNull();
  });

  it("タイトルバー相当が見えていれば許容", () => {
    // 上 300px ぶんが画面内（x 方向はフル可視）
    const b = { x: 200, y: 780, width: 800, height: 600 };
    expect(clampBoundsToDisplays(b, [PRIMARY])).toEqual(b);
  });

  it("ディスプレイ 0 枚（起動レース）は null", () => {
    const b = { x: 0, y: 0, width: 800, height: 600 };
    expect(clampBoundsToDisplays(b, [])).toBeNull();
  });
});

describe("sanitizeWindowStates", () => {
  it("正しいエントリだけ通す", () => {
    const raw = {
      main: { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true },
      "panel-codex": { bounds: { x: 0, y: 0, width: 480, height: 900 } },
      broken1: { bounds: { x: "a", y: 0, width: 1, height: 1 } },
      broken2: { bounds: { x: 0, y: 0, width: 0, height: 100 } },
      broken3: "not-an-object",
      broken4: { bounds: { x: 0, y: 0, width: Number.NaN, height: 100 } },
    };
    expect(sanitizeWindowStates(raw)).toEqual({
      main: { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true },
      "panel-codex": {
        bounds: { x: 0, y: 0, width: 480, height: 900 },
        maximized: false,
      },
    });
  });

  it("非オブジェクトは空", () => {
    expect(sanitizeWindowStates(null)).toEqual({});
    expect(sanitizeWindowStates("x")).toEqual({});
    expect(sanitizeWindowStates(42)).toEqual({});
  });
});

describe("createWindowStateStore", () => {
  let dir: string;

  afterEach(() => {
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("set → 500ms debounce 後に書き出し、再ロードで復元できる", () => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(os.tmpdir(), "grim-ws-state-"));
    const store = createWindowStateStore(dir);
    const entry = {
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      maximized: false,
    };
    store.set("main", entry);
    vi.advanceTimersByTime(600);

    const reloaded = createWindowStateStore(dir);
    expect(reloaded.get("main")).toEqual(entry);
  });

  it("flush は debounce を待たず同期書き出しする", () => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(os.tmpdir(), "grim-ws-state-"));
    const store = createWindowStateStore(dir);
    store.set("main", {
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      maximized: true,
    });
    store.flush();

    const onDisk = JSON.parse(
      readFileSync(path.join(dir, "window-state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk.main).toEqual({
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      maximized: true,
    });
  });

  it("破損 JSON は空 state として立ち上がる", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "grim-ws-state-"));
    writeFileSync(path.join(dir, "window-state.json"), "{oops", "utf8");
    const store = createWindowStateStore(dir);
    expect(store.get("main")).toBeUndefined();
  });
});
