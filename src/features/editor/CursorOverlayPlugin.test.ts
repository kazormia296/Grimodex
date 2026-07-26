// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { createCursorOverlayPlugin } from "./CursorOverlayPlugin";

/**
 * Regression test: cursor overlay must update position during IME composition.
 * Bug: update() used to early-return when the "composing" class was present,
 * freezing the cursor at the composition start position.
 */
describe("CursorOverlayPlugin – IME composition", () => {
  let wrapper: HTMLDivElement;
  let view: EditorView;

  beforeEach(() => {
    wrapper = document.createElement("div");
    wrapper.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(wrapper, "scrollTop", { value: 0, writable: true });
    document.body.appendChild(wrapper);

    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("hello")]),
      ]),
      plugins: [createCursorOverlayPlugin(() => true)],
    });

    view = new EditorView(wrapper, { state });

    // Mock DOM APIs that JSDOM doesn't support
    view.coordsAtPos = vi.fn().mockReturnValue({
      left: 50,
      top: 20,
      bottom: 40,
    });
    view.hasFocus = vi.fn().mockReturnValue(true);
  });

  afterEach(() => {
    view.destroy();
    wrapper.remove();
  });

  function getCursorEl(): HTMLDivElement {
    const el = wrapper.querySelector(".typewriter-cursor") as HTMLDivElement;
    expect(el).not.toBeNull();
    return el;
  }

  it("cursor position updates during composition (not frozen)", () => {
    const cursor = getCursorEl();

    // Trigger compositionstart
    view.dom.dispatchEvent(new Event("compositionstart"));
    expect(cursor.classList.contains("composing")).toBe(true);

    // Move the mock cursor to a new position (simulating text being composed)
    (view.coordsAtPos as ReturnType<typeof vi.fn>).mockReturnValue({
      left: 120,
      top: 20,
      bottom: 40,
    });

    // Simulate a state update (e.g. ProseMirror inserting composed text)
    const { tr } = view.state;
    tr.insertText("あ", 1, 1);
    view.dispatch(tr);

    // Cursor should have moved to the new position, not frozen at 50px
    expect(cursor.style.left).toBe("120px");
  });

  it("compositionend removes composing class and updates cursor", async () => {
    const cursor = getCursorEl();

    view.dom.dispatchEvent(new Event("compositionstart"));
    expect(cursor.classList.contains("composing")).toBe(true);

    view.dom.dispatchEvent(new Event("compositionend"));
    expect(cursor.classList.contains("composing")).toBe(false);
  });
});

/**
 * Regression: TipTap's React EditorContent re-parents `view.dom` (and all
 * its sibling childNodes — including this cursor element) when it remounts
 * across conditional JSX branches (e.g. SceneMeta panel open ↔ closed when
 * switching from a Scene to a Snippet). The plugin used to capture the
 * wrapper reference once in the constructor; after the move that reference
 * pointed to a detached div whose `getBoundingClientRect()` returns 0,0,
 * making the cursor appear at the wrong screen position.
 */
describe("CursorOverlayPlugin – wrapper re-parenting", () => {
  it("re-acquires wrapper when view.dom is moved to a new parent", () => {
    const oldWrapper = document.createElement("div");
    oldWrapper.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(oldWrapper, "scrollTop", {
      value: 0,
      writable: true,
    });
    document.body.appendChild(oldWrapper);

    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("hello")]),
      ]),
      plugins: [createCursorOverlayPlugin(() => true)],
    });
    const view = new EditorView(oldWrapper, { state });
    view.coordsAtPos = vi.fn().mockReturnValue({
      left: 50,
      top: 100,
      bottom: 120,
    });
    view.hasFocus = vi.fn().mockReturnValue(true);

    const cursor = oldWrapper.querySelector(
      ".typewriter-cursor",
    ) as HTMLDivElement;
    expect(cursor).not.toBeNull();

    // Simulate TipTap's remount: move all childNodes of the editor's parent
    // (including view.dom and the cursor element) into a new wrapper that
    // sits at a different viewport offset.
    const newWrapper = document.createElement("div");
    newWrapper.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 50,
        right: 800,
        bottom: 650,
        width: 800,
        height: 600,
        x: 0,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(newWrapper, "scrollTop", {
      value: 0,
      writable: true,
    });
    document.body.appendChild(newWrapper);
    while (oldWrapper.firstChild) {
      newWrapper.appendChild(oldWrapper.firstChild);
    }
    document.body.removeChild(oldWrapper);

    // Trigger an update so the plugin picks up the new parent.
    const { tr } = view.state;
    tr.insertText("!", 6, 6);
    view.dispatch(tr);

    // top should be relative to the NEW wrapper (100 - 50 = 50), not the
    // stale old wrapper (which would give 100).
    expect(cursor.style.top).toBe("50px");
    expect(newWrapper.style.position).toBe("relative");
    expect(cursor.parentElement).toBe(newWrapper);

    view.destroy();
    newWrapper.remove();
  });
});

/**
 * getEnabled が false を返したら native キャレットへ確実に委譲する契約。
 * 縦書きMODE (editor.verticalMode) は useCursorOverlay でこの getter を
 * 実効 OFF に倒すため、caretColor 復帰が漏れると縦書き中にキャレットが
 * 完全に見えなくなる。
 */
describe("CursorOverlayPlugin – disable hands back the native caret", () => {
  it("restores caretColor and hides the overlay when getEnabled flips false", () => {
    const wrapper = document.createElement("div");
    wrapper.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(wrapper, "scrollTop", { value: 0, writable: true });
    document.body.appendChild(wrapper);

    let enabled = true;
    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("hello")]),
      ]),
      plugins: [createCursorOverlayPlugin(() => enabled)],
    });
    const view = new EditorView(wrapper, { state });
    view.coordsAtPos = vi.fn().mockReturnValue({
      left: 50,
      top: 20,
      bottom: 40,
    });
    view.hasFocus = vi.fn().mockReturnValue(true);

    const cursor = wrapper.querySelector(
      ".typewriter-cursor",
    ) as HTMLDivElement;
    expect(cursor).not.toBeNull();

    // Enabled: the overlay owns the caret (native caret made transparent).
    view.dispatch(view.state.tr.insertText("a", 1, 1));
    expect(view.dom.style.caretColor).toBe("transparent");

    // Disabled (e.g. vertical mode toggled on): native caret restored.
    enabled = false;
    view.dispatch(view.state.tr.insertText("b", 1, 1));
    expect(view.dom.style.caretColor).toBe("");
    expect(cursor.style.visibility).toBe("hidden");

    view.destroy();
    wrapper.remove();
  });
});

/**
 * 入力中スライドと大ジャンプ snap の切り分け (距離しきい値 = 行送り 1.5 倍)。
 * 旧実装は docChanged のたびに .no-transition を 200ms 付与し、タイピング中は
 * スムースキャレットが常に無効だった。
 */
describe("CursorOverlayPlugin – typing slide vs long-jump snap", () => {
  function setup() {
    const wrapper = document.createElement("div");
    wrapper.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(wrapper, "scrollTop", { value: 0, writable: true });
    document.body.appendChild(wrapper);

    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("hello")]),
      ]),
      plugins: [createCursorOverlayPlugin(() => true)],
    });
    const view = new EditorView(wrapper, { state });
    // 行高 20px (top=20, bottom=40) → snap しきい値 = 30px
    const coords = vi.fn().mockReturnValue({ left: 50, top: 20, bottom: 40 });
    view.coordsAtPos = coords;
    view.hasFocus = vi.fn().mockReturnValue(true);
    const cursor = wrapper.querySelector(
      ".typewriter-cursor",
    ) as HTMLDivElement;
    return { wrapper, view, coords, cursor };
  }

  it("打鍵 (docChanged) でもしきい値以下の移動はスライドする", () => {
    const { wrapper, view, coords, cursor } = setup();

    // 初回描画は prevBox が無いので snap
    view.dispatch(view.state.tr.insertText("a", 1, 1));
    expect(cursor.classList.contains("no-transition")).toBe(true);

    // 1 文字ぶん (12px < 30px) の移動 → transition 有効のまま位置更新
    coords.mockReturnValue({ left: 62, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("b", 2, 2));
    expect(cursor.style.left).toBe("62px");
    expect(cursor.classList.contains("no-transition")).toBe(false);

    view.destroy();
    wrapper.remove();
  });

  it("行送り 1.5 倍を超える移動 (ペースト等) は snap する", () => {
    const { wrapper, view, coords, cursor } = setup();

    view.dispatch(view.state.tr.insertText("a", 1, 1));
    coords.mockReturnValue({ left: 62, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("b", 2, 2));
    expect(cursor.classList.contains("no-transition")).toBe(false);

    // 238px の大ジャンプ → snap
    coords.mockReturnValue({ left: 300, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("長い貼り付け", 3, 3));
    expect(cursor.style.left).toBe("300px");
    expect(cursor.classList.contains("no-transition")).toBe(true);

    view.destroy();
    wrapper.remove();
  });

  it("非表示からの再表示は snap する (古い位置からの滑り防止)", () => {
    const { wrapper, view, coords, cursor } = setup();

    view.dispatch(view.state.tr.insertText("a", 1, 1));
    coords.mockReturnValue({ left: 62, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("b", 2, 2));
    expect(cursor.classList.contains("no-transition")).toBe(false);

    // blur → hide (prevBox クリア) → focus 再表示は近距離でも snap
    view.dom.dispatchEvent(new Event("blur"));
    expect(cursor.style.visibility).toBe("hidden");
    coords.mockReturnValue({ left: 70, top: 20, bottom: 40 });
    view.dom.dispatchEvent(new Event("focus"));
    expect(cursor.style.visibility).toBe("visible");
    expect(cursor.classList.contains("no-transition")).toBe(true);

    view.destroy();
    wrapper.remove();
  });
});

/**
 * 高速連続入力 (キー長押しのオートリピート / スライド時間より短い連打) では
 * スライドが完了せずキャレットが入力に遅れて追従する。閾値を超えた速さの間だけ
 * snap して追いつかせ、緩めばスライドへ戻すことを検証する。
 * 閾値 = スライド時間 (テストでは既定 80ms)。
 */
describe("CursorOverlayPlugin – 高速連続入力中は snap する", () => {
  function setup() {
    const wrapper = document.createElement("div");
    wrapper.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(wrapper, "scrollTop", { value: 0, writable: true });
    document.body.appendChild(wrapper);

    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("hello")]),
      ]),
      plugins: [createCursorOverlayPlugin(() => true)],
    });
    const view = new EditorView(wrapper, { state });
    // 行高 20px → snap しきい値 (距離) = 30px。以降の移動はすべて 12px で
    // 距離 snap には掛からない → snap の有無は「速度」だけで決まる。
    const coords = vi.fn().mockReturnValue({ left: 50, top: 20, bottom: 40 });
    view.coordsAtPos = coords;
    view.hasFocus = vi.fn().mockReturnValue(true);
    const cursor = wrapper.querySelector(
      ".typewriter-cursor",
    ) as HTMLDivElement;
    return { wrapper, view, coords, cursor };
  }

  // ProseMirror が capture-phase で呼ぶ handleKeyDown プロップを直接発火する
  // (実 DOM keydown 配線に依存しない)。
  const fireKey = (view: EditorView, init: KeyboardEventInit) =>
    view.someProp("handleKeyDown", (f) =>
      (f as (v: EditorView, e: KeyboardEvent) => boolean)(
        view,
        new KeyboardEvent("keydown", init),
      ),
    );

  let nowSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    nowSpy?.mockRestore();
  });

  it("打鍵間隔がスライド時間より短い連打は snap し、緩めばスライドへ戻る", () => {
    nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValue(1000);
    const { wrapper, view, coords, cursor } = setup();

    // 1打鍵目: 初回描画は prevBox 無しで snap
    fireKey(view, { key: "a" });
    view.dispatch(view.state.tr.insertText("a", 1, 1));

    // 2打鍵目: 200ms 後 (>= 80ms) → 低速なので通常スライド
    nowSpy.mockReturnValue(1200);
    fireKey(view, { key: "b" });
    coords.mockReturnValue({ left: 62, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("b", 2, 2));
    expect(cursor.classList.contains("no-transition")).toBe(false);

    // 3打鍵目: 30ms 後 (< 80ms) → 高速なので snap
    nowSpy.mockReturnValue(1230);
    fireKey(view, { key: "c" });
    coords.mockReturnValue({ left: 74, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("c", 3, 3));
    expect(cursor.classList.contains("no-transition")).toBe(true);

    // 4打鍵目: 170ms 後 (>= 80ms) → 打鍵が緩んだのでスライドへ復帰
    nowSpy.mockReturnValue(1400);
    fireKey(view, { key: "d" });
    coords.mockReturnValue({ left: 86, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("d", 4, 4));
    expect(cursor.classList.contains("no-transition")).toBe(false);

    view.destroy();
    wrapper.remove();
  });

  it("キー長押し (event.repeat) は間隔が長くても snap する", () => {
    nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValue(5000);
    const { wrapper, view, coords, cursor } = setup();

    // 低速スライドの基準を作る
    fireKey(view, { key: "a" });
    view.dispatch(view.state.tr.insertText("a", 1, 1));
    nowSpy.mockReturnValue(5500); // 500ms 後 = 低速
    fireKey(view, { key: "b" });
    coords.mockReturnValue({ left: 62, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("b", 2, 2));
    expect(cursor.classList.contains("no-transition")).toBe(false);

    // 間隔 1000ms (>= 80ms) と長いが repeat=true (オートリピート) なので snap
    nowSpy.mockReturnValue(6500);
    fireKey(view, { key: "c", repeat: true });
    coords.mockReturnValue({ left: 74, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("c", 3, 3));
    expect(cursor.classList.contains("no-transition")).toBe(true);

    view.destroy();
    wrapper.remove();
  });

  it("修飾キー単独 (Shift 長押し) は高速 snap を誘発しない", () => {
    nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValue(2000);
    const { wrapper, view, coords, cursor } = setup();

    fireKey(view, { key: "a" });
    view.dispatch(view.state.tr.insertText("a", 1, 1));

    // Shift の長押し (repeat=true) はキャレットを動かさない。ここで
    // pendingFastSnap を立ててしまうと、次の実キー入力が誤って snap する。
    nowSpy.mockReturnValue(2005);
    fireKey(view, { key: "Shift", repeat: true });

    // 十分あとに 1 文字 (低速) → Shift のリピートに引きずられずスライドすべき
    nowSpy.mockReturnValue(3000);
    fireKey(view, { key: "z" });
    coords.mockReturnValue({ left: 62, top: 20, bottom: 40 });
    view.dispatch(view.state.tr.insertText("z", 2, 2));
    expect(cursor.classList.contains("no-transition")).toBe(false);

    view.destroy();
    wrapper.remove();
  });
});
