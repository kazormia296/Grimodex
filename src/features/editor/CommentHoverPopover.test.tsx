// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { CommentHoverPopover } from "./CommentHoverPopover";
import { useCursorSettingsStore } from "./cursorSettingsStore";

/**
 * a11y 配線契約: hover popover が role=dialog + accessible name を持ち、
 * キーボード（caret がコメント装飾内に入る / Escape）でも開閉できること。
 * 実 TipTap は重いので editor は selectionUpdate emitter のスタブで代替する。
 */

type SelectionHandler = (props: {
  editor: Editor;
  transaction: { docChanged: boolean };
}) => void;

function createEditorStub(getCaretNode: () => Node) {
  const handlers = new Set<SelectionHandler>();
  const stub = {
    isDestroyed: false,
    on: (event: string, fn: SelectionHandler) => {
      if (event === "selectionUpdate") handlers.add(fn);
    },
    off: (event: string, fn: SelectionHandler) => {
      if (event === "selectionUpdate") handlers.delete(fn);
    },
    state: { selection: { empty: true, from: 2 } },
    view: {
      dom: document.createElement("div"),
      composing: false,
      domAtPos: () => ({ node: getCaretNode(), offset: 1 }),
    },
  } as unknown as Editor;
  const emitSelection = (docChanged = false) => {
    handlers.forEach((fn) => fn({ editor: stub, transaction: { docChanged } }));
  };
  return { stub, emitSelection };
}

function setupDom() {
  const container = document.createElement("div");
  const span = document.createElement("span");
  span.setAttribute("data-comment-text", "ここ要確認");
  span.setAttribute("data-comment-from", "1");
  span.setAttribute("data-comment-to", "6");
  span.textContent = "対象テキスト";
  container.appendChild(span);
  document.body.appendChild(container);
  const outside = document.createElement("p");
  outside.textContent = "コメント外";
  container.appendChild(outside);
  return { container, span, outsideTextNode: outside.firstChild! };
}

describe("CommentHoverPopover accessibility", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({ showComments: true });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("shows a role=dialog popover with accessible name on hover", () => {
    const { container, span } = setupDom();
    render(
      <CommentHoverPopover
        editor={null}
        containerRef={{ current: container }}
      />,
    );

    fireEvent.mouseOver(span);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBeTruthy();
    expect(dialog.textContent).toContain("ここ要確認");
  });

  it("opens when the caret enters a comment decoration (keyboard access)", () => {
    const { container, span } = setupDom();
    const { stub, emitSelection } = createEditorStub(() => span.firstChild!);
    render(
      <CommentHoverPopover
        editor={stub}
        containerRef={{ current: container }}
      />,
    );

    act(() => emitSelection());

    expect(screen.getByRole("dialog").textContent).toContain("ここ要確認");
  });

  it("does not open on doc-changing transactions (typing)", () => {
    const { container, span } = setupDom();
    const { stub, emitSelection } = createEditorStub(() => span.firstChild!);
    render(
      <CommentHoverPopover
        editor={stub}
        containerRef={{ current: container }}
      />,
    );

    act(() => emitSelection(true));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and stays closed while the caret remains in range", () => {
    const { container, span, outsideTextNode } = setupDom();
    let caretNode: Node = span.firstChild!;
    const { stub, emitSelection } = createEditorStub(() => caretNode);
    render(
      <CommentHoverPopover
        editor={stub}
        containerRef={{ current: container }}
      />,
    );

    act(() => emitSelection());
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // 同じコメント範囲では再表示しない
    act(() => emitSelection());
    expect(screen.queryByRole("dialog")).toBeNull();

    // caret が範囲外に出ると抑止が解除される
    caretNode = outsideTextNode;
    act(() => emitSelection());
    caretNode = span.firstChild!;
    act(() => emitSelection());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
