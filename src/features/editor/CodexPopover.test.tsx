// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { CodexPopover } from "./CodexPopover";

/**
 * a11y 配線契約: codex popover が hover に加えて caret（キーボード）でも
 * 開閉できること、role=dialog + entry 名の accessible name を持つこと。
 * 実 TipTap は重いので editor は selectionUpdate emitter のスタブで代替する。
 */

// editor.codexPopoverOnCaret（キャレット経路の有効/無効）をテストごとに切替える
let mockCaretPopoverEnabled = true;
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (
    sel: (s: { getBoolean: (k: string, d: boolean) => boolean }) => unknown,
  ) =>
    sel({
      getBoolean: (k, d) =>
        k === "editor.codexPopoverOnCaret" ? mockCaretPopoverEnabled : d,
    }),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: (
    sel: (s: { entries: unknown[]; completionTargets: unknown[] }) => unknown,
  ) =>
    sel({
      entries: [
        { id: "e1", name: "アリス", type: "character", summary: "主人公" },
      ],
      completionTargets: [
        {
          id: "e1",
          name: "アリス",
          type: "character",
          aliases: "[]",
          excludedAliases: "[]",
        },
        {
          id: "e2",
          name: "ボブ",
          type: "character",
          aliases: "[]",
          excludedAliases: "[]",
        },
      ],
    }),
}));
vi.mock("@/features/editor/codexHighlightStore", () => ({
  useCodexHighlightStore: (
    sel: (s: { typeColorMap: Record<string, never> }) => unknown,
  ) => sel({ typeColorMap: {} }),
}));
vi.mock("@/features/codex/useResolvedCodexStates", () => ({
  useResolvedCodexStates: () => new Map(),
}));
vi.mock("@/features/codex/codexSpoilerFlags", () => ({
  useUnrevealedSecretForeshadows: () => new Map(),
}));
vi.mock("@/features/codex/components/CodexEntryPopoverContent", () => ({
  CodexEntryPopoverContent: ({ entry }: { entry: { name: string } }) => (
    <div>{entry.name}</div>
  ),
}));
vi.mock("@/features/chat/utils/typeLabels", () => ({
  getTypeLabel: () => "キャラクター",
}));
vi.mock("@/features/codex/multiwindow/codexSelectionRouting", () => ({
  requestOpenInCodex: vi.fn(),
}));

type SelectionHandler = (props: {
  editor: Editor;
  transaction: { docChanged: boolean };
}) => void;

function createEditorStub(dom: HTMLElement, getCaretNode: () => Node) {
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
      dom,
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
  span.className = "codex-highlight";
  span.setAttribute("data-codex-entry-id", "e1");
  span.textContent = "アリス";
  container.appendChild(span);
  const outside = document.createElement("p");
  outside.textContent = "ハイライト外";
  container.appendChild(outside);
  document.body.appendChild(container);
  return { container, span, outsideTextNode: outside.firstChild! };
}

function setupOverlappingDom() {
  const container = document.createElement("div");
  const semantic = document.createElement("span");
  semantic.className = "codex-highlight codex-semantic-link";
  semantic.setAttribute("data-codex-entry-id", "e2");
  const automatic = document.createElement("span");
  automatic.className = "codex-highlight";
  automatic.setAttribute("data-codex-entry-id", "e1");
  automatic.textContent = "彼女";
  semantic.appendChild(automatic);
  container.appendChild(semantic);
  document.body.appendChild(container);
  return { automatic, container, semantic };
}

describe("CodexPopover accessibility", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    mockCaretPopoverEnabled = true;
  });

  it("opens on hover with role=dialog named after the entry", () => {
    const { container, span } = setupDom();
    const { stub } = createEditorStub(container, () => span.firstChild!);
    render(<CodexPopover editor={stub} />);

    fireEvent.mouseOver(span);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("アリス");
    expect(dialog.getAttribute("data-testid")).toBe("codex-popover");
  });

  it("prefers the explicit semantic target over an overlapping auto highlight", () => {
    const { automatic, container } = setupOverlappingDom();
    const { stub } = createEditorStub(container, () => automatic.firstChild!);
    render(<CodexPopover editor={stub} />);

    fireEvent.mouseOver(automatic);

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("ボブ");
  });

  it("opens when the caret enters a codex highlight (keyboard access)", () => {
    const { container, span } = setupDom();
    const { stub, emitSelection } = createEditorStub(
      container,
      () => span.firstChild!,
    );
    render(<CodexPopover editor={stub} />);

    act(() => emitSelection());

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "アリス",
    );
  });

  it("editor.codexPopoverOnCaret=false ではキャレット経路で開かない（ホバーは開く）", () => {
    mockCaretPopoverEnabled = false;
    const { container, span } = setupDom();
    const { stub, emitSelection } = createEditorStub(
      container,
      () => span.firstChild!,
    );
    render(<CodexPopover editor={stub} />);

    // キャレットがハイライトに入っても開かない
    act(() => emitSelection());
    expect(screen.queryByRole("dialog")).toBeNull();

    // マウスホバー経路は設定に関わらず有効なまま
    fireEvent.mouseOver(span);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "アリス",
    );
  });

  it("does not open on doc-changing transactions (typing)", () => {
    const { container, span } = setupDom();
    const { stub, emitSelection } = createEditorStub(
      container,
      () => span.firstChild!,
    );
    render(<CodexPopover editor={stub} />);

    act(() => emitSelection(true));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides when the caret leaves the highlight", () => {
    const { container, span, outsideTextNode } = setupDom();
    let caretNode: Node = span.firstChild!;
    const { stub, emitSelection } = createEditorStub(
      container,
      () => caretNode,
    );
    render(<CodexPopover editor={stub} />);

    act(() => emitSelection());
    expect(screen.getByRole("dialog")).toBeTruthy();

    caretNode = outsideTextNode;
    act(() => emitSelection());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and stays closed while the caret stays on the entry", () => {
    const { container, span, outsideTextNode } = setupDom();
    let caretNode: Node = span.firstChild!;
    const { stub, emitSelection } = createEditorStub(
      container,
      () => caretNode,
    );
    render(<CodexPopover editor={stub} />);

    act(() => emitSelection());
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // 同じ entry 上では再表示しない
    act(() => emitSelection());
    expect(screen.queryByRole("dialog")).toBeNull();

    // caret が離れると抑止が解除される
    caretNode = outsideTextNode;
    act(() => emitSelection());
    caretNode = span.firstChild!;
    act(() => emitSelection());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
