// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "@tiptap/pm/schema-basic";
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
