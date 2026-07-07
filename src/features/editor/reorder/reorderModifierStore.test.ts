// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireModifierListeners,
  computeModifierMode,
  useReorderModifierStore,
} from "./reorderModifierStore";

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
