// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// keyup 補正は WebKitGTK 限定（Blink/WKWebView は keyup の modifier state が
// 正しいため）。テストではエンジンを切り替えて両分岐を検証する。
let mockWebKitGtk = false;
vi.mock("@/lib/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/platform")>();
  return { ...mod, isWebKitGtk: () => mockWebKitGtk };
});

import {
  acquireModifierListeners,
  computeModifierMode,
  useReorderModifierStore,
} from "./reorderModifierStore";

beforeEach(() => {
  mockWebKitGtk = false;
});

afterEach(() => {
  // ストアと refcount を素の状態へ。
  useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
});

describe("computeModifierMode", () => {
  it("maps modifier combinations to modes", () => {
    expect(computeModifierMode(false, false)).toBe("none");
    expect(computeModifierMode(false, true)).toBe("none");
    expect(computeModifierMode(true, false)).toBe("alt");
    expect(computeModifierMode(true, true)).toBe("altShift");
  });

  it("excludes Ctrl/Meta chords (AltGr, Cmd+Option) so typography does not trigger", () => {
    // Windows AltGr = Ctrl+Alt
    expect(computeModifierMode(true, false, true, false)).toBe("none");
    expect(computeModifierMode(true, true, true, false)).toBe("none");
    // Cmd+Option
    expect(computeModifierMode(true, false, false, true)).toBe("none");
    expect(computeModifierMode(true, true, false, true)).toBe("none");
  });
});

describe("useReorderModifierStore", () => {
  it("guards no-op writes (same value does not notify)", () => {
    let notifications = 0;
    const unsub = useReorderModifierStore.subscribe(() => {
      notifications += 1;
    });
    const store = useReorderModifierStore.getState();
    store.setMode("alt");
    store.setMode("alt"); // same → no notify
    store.setGranularity("bunsetsu");
    store.setGranularity("bunsetsu"); // same → no notify
    unsub();
    expect(notifications).toBe(2);
    expect(useReorderModifierStore.getState().mode).toBe("alt");
    expect(useReorderModifierStore.getState().granularity).toBe("bunsetsu");
  });
});

describe("acquireModifierListeners", () => {
  it("tracks Alt/Shift held state via window key events and refcounts cleanup", () => {
    const release = acquireModifierListeners();

    window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, shiftKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("altShift");

    // Shift 離す → alt に戻る
    window.dispatchEvent(new KeyboardEvent("keyup", { altKey: true }));
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    // AltGr（Ctrl+Alt）はタイプ入力なので none に落とす
    window.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, ctrlKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("none");
    // Alt 単独に戻す
    window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    // blur で確実に none へ
    window.dispatchEvent(new Event("blur"));
    expect(useReorderModifierStore.getState().mode).toBe("none");

    // 押し直し
    window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    release();

    // 解放後はイベントを無視（mode は none にリセット済み、以降変化しない）
    expect(useReorderModifierStore.getState().mode).toBe("none");
    window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
    expect(useReorderModifierStore.getState().mode).toBe("none");
  });

  it("clears mode on WebKitGTK-style Alt keyup (altKey still true on release)", () => {
    // WebKitGTK (GDK) は Alt 自身の keyup で altKey=true のまま届く。
    // key/code から「離されたキー自身」のフラグを落とせることを gate する。
    mockWebKitGtk = true;
    const release = acquireModifierListeners();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Alt", altKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("none");

    // code のみでも判定できる（key が 'AltGraph' 以外の変種で届く環境向け）
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "", code: "AltLeft", altKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("none");

    release();
  });

  it("drops altShift to alt on WebKitGTK-style Shift keyup", () => {
    mockWebKitGtk = true;
    const release = acquireModifierListeners();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, shiftKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("altShift");

    // WebKitGTK では Shift 離しの keyup にも shiftKey=true が残る
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Shift",
        altKey: true,
        shiftKey: true,
      }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    release();
  });

  it("keeps Blink-style keyup behavior (altKey=false on release) working", () => {
    const release = acquireModifierListeners();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Alt", altKey: false }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("none");

    release();
  });

  it("does not clear modifiers on keydown of the modifier itself", () => {
    mockWebKitGtk = true;
    const release = acquireModifierListeners();

    // keyup 限定の補正であること: keydown {key:'Alt', altKey:true} は alt のまま
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    release();
  });

  it("Blink では keyup 補正を掛けない（左右 Alt 同時押しの片方離しを守る）", () => {
    // Blink/WKWebView の keyup modifier state は正確: 左右 Alt を両方押して
    // 片方だけ離すと altKey=true の keyup が届き、alt は維持されるべき。
    mockWebKitGtk = false;
    const release = acquireModifierListeners();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Alt",
        code: "AltLeft",
        altKey: true, // もう片方の Alt がまだ押下中
      }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("alt");

    release();
  });

  it("shares one listener set across multiple acquirers", () => {
    const r1 = acquireModifierListeners();
    const r2 = acquireModifierListeners();
    r1(); // まだ 1 個生きている
    window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
    expect(useReorderModifierStore.getState().mode).toBe("alt");
    r2(); // 最後の解放でリスナ除去
    window.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, shiftKey: true }),
    );
    expect(useReorderModifierStore.getState().mode).toBe("none");
  });
});
