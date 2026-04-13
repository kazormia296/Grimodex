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
