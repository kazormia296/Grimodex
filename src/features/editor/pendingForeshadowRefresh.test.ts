// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("@/features/foreshadow/saveAnchors", () => ({
  refreshForeshadowPayoffMarkVersions: h.refresh,
}));

import {
  COMPOSITION_QUIET_MS,
  applyPendingForeshadowRefresh,
  applyPendingForeshadowRefreshForFlush,
  deferForeshadowRefresh,
  discardPendingForeshadowRefresh,
  hasPendingForeshadowRefresh,
  installCompositionIdleListener,
  isEditorComposing,
} from "./pendingForeshadowRefresh";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import { debugLog } from "@/lib/debugLog";

function row(id: string, version: number): ForeshadowRow {
  return { id, version } as unknown as ForeshadowRow;
}

function makeEditor(options: { composing?: boolean; focused?: boolean } = {}) {
  const dom = document.createElement("div");
  const state = { focused: options.focused ?? false };
  const view = {
    composing: options.composing ?? false,
    dom,
    hasFocus: vi.fn(() => state.focused),
    focus: vi.fn(() => {
      state.focused = true;
    }),
  };
  const blur = vi.spyOn(dom, "blur").mockImplementation(() => {
    state.focused = false;
  });
  const editor = { isDestroyed: false, view } as unknown as Editor;
  return { editor, view, dom, blur, state };
}

/** run は programmatic の囲みの代わり。apply をそのまま呼ぶ。 */
const run = vi.fn((apply: () => void) => apply());

beforeEach(() => {
  h.refresh.mockReset();
  run.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pendingForeshadowRefresh", () => {
  it("rows を積み、同じ foreshadowId は新しい version で上書きし、古い version では巻き戻さない", () => {
    const { editor } = makeEditor();
    deferForeshadowRefresh(editor, [row("a", 2), row("b", 5)]);
    deferForeshadowRefresh(editor, [row("a", 3), row("b", 4)]);
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(true);
    const rows = h.refresh.mock.calls[0]![1] as ForeshadowRow[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.version]))).toEqual({
      a: 3,
      b: 5,
    });
  });

  it("変換中でなければ直ちに適用し、pending を空にする（従来と同じ即時の経路）", () => {
    const { editor } = makeEditor();
    deferForeshadowRefresh(editor, [row("a", 2)]);
    expect(hasPendingForeshadowRefresh(editor)).toBe(true);
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
  });

  it("変換中は適用せず false を返して pending に残す（捨てない）。変換が終われば適用できる", () => {
    const { editor, view } = makeEditor({ composing: true });
    deferForeshadowRefresh(editor, [row("a", 2)]);
    expect(isEditorComposing(editor)).toBe(true);
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(hasPendingForeshadowRefresh(editor)).toBe(true);

    view.composing = false;
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
  });

  it("pending が無ければ何もせず true（適用すべきものが無い。通常の経路は変わらない）", () => {
    const { editor } = makeEditor({ composing: true });
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("editor が破棄・再ロードされたら pending を捨てる（古い token で巻き戻さない）", () => {
    const { editor } = makeEditor();
    deferForeshadowRefresh(editor, [row("a", 2)]);
    discardPendingForeshadowRefresh(editor);
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(true);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("(d) flush：変換中でも延期せず、DOM を blur して変換が終われば 1 回だけ適用する", () => {
    const { editor, view, blur } = makeEditor({ composing: true });
    blur.mockImplementation(() => {
      view.composing = false;
    });
    deferForeshadowRefresh(editor, [row("a", 2)]);
    applyPendingForeshadowRefreshForFlush(editor, run);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
  });

  it("(d) flush：blur しても変換が続くなら composition を捨てて適用する", () => {
    const { editor, blur } = makeEditor({ composing: true });
    deferForeshadowRefresh(editor, [row("a", 2)]);
    applyPendingForeshadowRefreshForFlush(editor, run);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
  });

  it("(d) flush：変換中でなければ blur せずに適用する", () => {
    const { editor, blur } = makeEditor();
    deferForeshadowRefresh(editor, [row("a", 2)]);
    applyPendingForeshadowRefreshForFlush(editor, run);
    expect(blur).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("EAR-20 flush：focus 中に変換を確定させるため blur したら、適用の後に focus を戻す（editor を閉じない flush で作者の focus を奪わない）", () => {
    const { editor, view, blur, state } = makeEditor({
      composing: true,
      focused: true,
    });
    deferForeshadowRefresh(editor, [row("a", 2)]);
    applyPendingForeshadowRefreshForFlush(editor, run);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(view.focus).toHaveBeenCalledTimes(1);
    expect(state.focused).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("EAR-20 flush：もともと focus が無ければ focus を足さない", () => {
    const { editor, view } = makeEditor({ composing: true, focused: false });
    deferForeshadowRefresh(editor, [row("a", 2)]);
    applyPendingForeshadowRefreshForFlush(editor, run);
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("EAR-20 flush：適用の途中で editor が破棄されたら focus を戻さない", () => {
    const { editor, view } = makeEditor({ composing: true, focused: true });
    deferForeshadowRefresh(editor, [row("a", 2)]);
    const destroyingRun = vi.fn((apply: () => void) => {
      apply();
      (editor as unknown as { isDestroyed: boolean }).isDestroyed = true;
    });
    applyPendingForeshadowRefreshForFlush(editor, destroyingRun);
    expect(view.focus).not.toHaveBeenCalled();
  });
});

describe("EAR-21／EAR-26 固着した変換（compositionend を取りこぼした）は証拠があるときだけ固着と見なす", () => {
  it("listener 無しの editor は composing が真なら、時間が経っても変換中のまま", () => {
    const { editor } = makeEditor({ composing: true });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(isEditorComposing(editor)).toBe(true);
  });

  it("証拠が無い（compositionstart の後に compositionend を見ていない）composing は、何時間静止しても変換中のまま。診断も出さない", () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => undefined);
    const { editor, dom } = makeEditor({ composing: true });
    installCompositionIdleListener(editor, vi.fn());
    dom.dispatchEvent(new Event("compositionstart"));
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(isEditorComposing(editor)).toBe(true);
    // 遅い変換（更新が続く）でも同じ。
    dom.dispatchEvent(new Event("compositionupdate"));
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(isEditorComposing(editor)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("compositionend を見たのに composing が真のまま（ProseMirror が取りこぼした）なら固着と見なし、診断を 1 回だけ残す", () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => undefined);
    const { editor, dom } = makeEditor({ composing: true });
    installCompositionIdleListener(editor, vi.fn());
    dom.dispatchEvent(new Event("compositionstart"));
    expect(isEditorComposing(editor)).toBe(true);
    dom.dispatchEvent(new Event("compositionend"));
    expect(isEditorComposing(editor)).toBe(false);
    expect(isEditorComposing(editor)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // 本文は出さず、operation だけ。
    expect(warn.mock.calls[0]?.[2]).toMatchObject({
      fields: { operation: "composition-stale" },
    });
    warn.mockRestore();
  });

  it("listener を付ける前に始まった変換の途中で compositionend を見た場合も、証拠になる", () => {
    const { editor, dom } = makeEditor({ composing: true });
    installCompositionIdleListener(editor, vi.fn());
    dom.dispatchEvent(new Event("compositionend"));
    expect(isEditorComposing(editor)).toBe(false);
  });

  it("固着と見なした後は pending を適用できる。新しい compositionstart があれば再び変換中として扱う", () => {
    const { editor, dom } = makeEditor({ composing: true });
    installCompositionIdleListener(editor, vi.fn());
    dom.dispatchEvent(new Event("compositionstart"));
    deferForeshadowRefresh(editor, [row("a", 2)]);
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(false);

    dom.dispatchEvent(new Event("compositionend"));
    expect(applyPendingForeshadowRefresh(editor, run)).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    dom.dispatchEvent(new Event("compositionstart"));
    expect(isEditorComposing(editor)).toBe(true);
  });
});

describe("installCompositionIdleListener", () => {
  it("EAR-19 compositionend の後、COMPOSITION_QUIET_MS 静止してから onIdle を呼ぶ（次の task では呼ばない）", () => {
    const { editor, dom } = makeEditor();
    const onIdle = vi.fn();
    installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("compositionend"));
    vi.advanceTimersByTime(0);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("EAR-19 連続入力：静止の間に次の compositionstart が来れば適用しない（変換の直前に doc を変えない）", () => {
    const { editor, view, dom } = makeEditor();
    const onIdle = vi.fn();
    installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("compositionend"));
    vi.advanceTimersByTime(20);
    dom.dispatchEvent(new Event("compositionstart"));
    view.composing = true;
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS * 2);
    expect(onIdle).not.toHaveBeenCalled();
    // 次の変換が終わって静止すれば適用する。
    view.composing = false;
    dom.dispatchEvent(new Event("compositionend"));
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("EAR-19 打鍵（keydown）があれば静止を数え直す", () => {
    const { editor, dom } = makeEditor();
    const onIdle = vi.fn();
    installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("compositionend"));
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS - 10);
    dom.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("静止の時点でまた変換中なら onIdle を呼ばない（新しい変換が始まれば見張りは取り消される）", () => {
    const { editor, view, dom } = makeEditor();
    const onIdle = vi.fn();
    installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("compositionend"));
    // 次の変換が始まった（ProseMirror も composing を立てる）。
    dom.dispatchEvent(new Event("compositionstart"));
    view.composing = true;
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS * 4);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("EAR-26 compositionend の後も composing が固着したままなら、idle の見張りが onIdle を呼ぶ（peer の処理し直しが取り残されない）", () => {
    const { editor, view, dom } = makeEditor({ composing: true });
    const onIdle = vi.fn();
    installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("compositionstart"));
    dom.dispatchEvent(new Event("compositionend"));
    // PM は compositionend を取りこぼしたので composing は真のまま。
    expect(view.composing).toBe(true);
    vi.advanceTimersByTime(COMPOSITION_QUIET_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // 呼んだ後は見張りを続けない。
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("blur でも変換中でなければ onIdle を呼び、変換中なら呼ばない", () => {
    const { editor, view, dom } = makeEditor();
    const onIdle = vi.fn();
    installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("blur"));
    expect(onIdle).toHaveBeenCalledTimes(1);
    view.composing = true;
    dom.dispatchEvent(new Event("blur"));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("解除関数で listener と待機中の timer が消える", () => {
    const { editor, dom } = makeEditor();
    const onIdle = vi.fn();
    const dispose = installCompositionIdleListener(editor, onIdle);
    dom.dispatchEvent(new Event("compositionend"));
    dispose();
    vi.runAllTimers();
    dom.dispatchEvent(new Event("blur"));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("view が未 mount（dom が throw）の editor には何も付けない", () => {
    const editor = {
      isDestroyed: false,
      get view(): never {
        throw new Error("view not mounted");
      },
    } as unknown as Editor;
    const dispose = installCompositionIdleListener(editor, vi.fn());
    expect(() => dispose()).not.toThrow();
    expect(isEditorComposing(editor)).toBe(false);
  });
});
