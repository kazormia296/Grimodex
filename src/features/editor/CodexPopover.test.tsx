// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
  waitFor,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { CodexPopover } from "./CodexPopover";

/**
 * a11y 配線契約: codex popover が hover に加えて caret（キーボード）でも
 * 開閉できること、role=dialog + entry 名の accessible name を持つこと。
 * 実 TipTap は重いので editor は selectionUpdate emitter のスタブで代替する。
 */

// editor.codexPopoverOnCaret（キャレット経路の有効/無効）をテストごとに切替える
let mockCaretPopoverEnabled = true;
const {
  mockClearPendingEntry,
  mockCodexState,
  mockGetCodexEntry,
  mockGetCurrentProjectId,
  mockOpenCompactSurface,
  mockRequestOpenInCodex,
  mockRequestSelectEntry,
  mockSetSelectedEntry,
} = vi.hoisted(() => ({
  mockClearPendingEntry: vi.fn(),
  mockCodexState: {
    entries: [
      { id: "e1", name: "アリス", type: "character", summary: "主人公" },
    ] as Array<Record<string, unknown>>,
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
    ] as Array<Record<string, unknown>>,
    pendingEntryId: null as string | null,
    selectedEntry: null as Record<string, unknown> | null,
    requestSelectEntry: undefined as unknown,
    setSelectedEntry: undefined as unknown,
    clearPendingEntry: undefined as unknown,
  },
  mockGetCodexEntry: vi.fn(),
  mockGetCurrentProjectId: vi.fn(() => "project-1"),
  mockOpenCompactSurface: vi.fn(),
  mockRequestOpenInCodex: vi.fn(),
  mockRequestSelectEntry: vi.fn(),
  mockSetSelectedEntry: vi.fn(),
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (
    sel: (s: { getBoolean: (k: string, d: boolean) => boolean }) => unknown,
  ) =>
    sel({
      getBoolean: (k, d) =>
        k === "editor.codexPopoverOnCaret" ? mockCaretPopoverEnabled : d,
    }),
}));

vi.mock("@/features/codex/codexStore", () => {
  const useCodexStore = (sel: (s: typeof mockCodexState) => unknown) =>
    sel(mockCodexState);
  useCodexStore.getState = () => mockCodexState;
  return { useCodexStore };
});
vi.mock("@/features/codex/api", () => ({
  getCodexEntry: mockGetCodexEntry,
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: mockGetCurrentProjectId,
}));
vi.mock("@/features/layout/adaptive/compactNavigationStore", () => ({
  useCompactNavigationStore: {
    getState: () => ({ openSurface: mockOpenCompactSurface }),
  },
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
  CodexEntryPopoverContent: ({
    entry,
    onOpenInCodex,
  }: {
    entry: { name: string };
    onOpenInCodex: () => void;
  }) => (
    <div>
      {entry.name}
      <button type="button" onClick={onOpenInCodex}>
        Open in Codex
      </button>
    </div>
  ),
}));
vi.mock("@/features/chat/utils/typeLabels", () => ({
  getTypeLabel: () => "キャラクター",
}));
vi.mock("@/features/codex/multiwindow/codexSelectionRouting", () => ({
  requestOpenInCodex: mockRequestOpenInCodex,
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
  beforeEach(() => {
    mockCodexState.entries = [
      { id: "e1", name: "アリス", type: "character", summary: "主人公" },
    ];
    mockCodexState.completionTargets = [
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
    ];
    mockCodexState.pendingEntryId = null;
    mockCodexState.selectedEntry = null;
    mockRequestSelectEntry.mockImplementation((entryId: string) => {
      mockCodexState.pendingEntryId = entryId;
    });
    mockSetSelectedEntry.mockImplementation(
      (entry: Record<string, unknown> | null) => {
        mockCodexState.selectedEntry = entry;
      },
    );
    mockClearPendingEntry.mockImplementation(() => {
      mockCodexState.pendingEntryId = null;
    });
    mockCodexState.requestSelectEntry = mockRequestSelectEntry;
    mockCodexState.setSelectedEntry = mockSetSelectedEntry;
    mockCodexState.clearPendingEntry = mockClearPendingEntry;
    mockGetCurrentProjectId.mockReturnValue("project-1");
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    mockCaretPopoverEnabled = true;
    mockOpenCompactSurface.mockReset();
    mockRequestOpenInCodex.mockReset();
    mockRequestSelectEntry.mockReset();
    mockSetSelectedEntry.mockReset();
    mockClearPendingEntry.mockReset();
    mockGetCodexEntry.mockReset();
    mockGetCurrentProjectId.mockReset();
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

  it("selects a known full entry directly in the phone Codex surface", () => {
    const { container, span } = setupDom();
    const { stub } = createEditorStub(container, () => span.firstChild!);
    render(
      <WorkspaceViewportProvider profile="phone">
        <CodexPopover editor={stub} />
      </WorkspaceViewportProvider>,
    );

    fireEvent.mouseOver(span);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open in Codex",
      }),
    );

    expect(mockSetSelectedEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1", name: "アリス" }),
    );
    expect(mockClearPendingEntry).toHaveBeenCalledTimes(1);
    expect(mockCodexState.pendingEntryId).toBeNull();
    expect(mockCodexState.selectedEntry).toMatchObject({
      id: "e1",
      name: "アリス",
    });
    expect(mockRequestSelectEntry).not.toHaveBeenCalled();
    expect(mockGetCodexEntry).not.toHaveBeenCalled();
    expect(mockOpenCompactSurface).toHaveBeenCalledWith("codex");
    expect(mockRequestOpenInCodex).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads and selects a filtered-out completion target for direct phone editing", async () => {
    const fullEntry = {
      id: "e2",
      name: "ボブ",
      type: "character",
      summary: "相棒",
    };
    mockCodexState.selectedEntry = mockCodexState.entries[0]!;
    mockGetCodexEntry.mockResolvedValue(fullEntry);
    const { automatic, container } = setupOverlappingDom();
    const { stub } = createEditorStub(container, () => automatic.firstChild!);
    render(
      <WorkspaceViewportProvider profile="phone">
        <CodexPopover editor={stub} />
      </WorkspaceViewportProvider>,
    );

    fireEvent.mouseOver(automatic);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open in Codex",
      }),
    );

    expect(mockSetSelectedEntry).toHaveBeenCalledWith(null);
    expect(mockRequestSelectEntry).toHaveBeenCalledWith("e2");
    expect(mockCodexState.selectedEntry).toBeNull();
    expect(mockCodexState.pendingEntryId).toBe("e2");
    expect(mockOpenCompactSurface).toHaveBeenCalledWith("codex");

    await waitFor(() => {
      expect(mockGetCodexEntry).toHaveBeenCalledWith("project-1", "e2");
      expect(mockCodexState.selectedEntry).toBe(fullEntry);
      expect(mockCodexState.pendingEntryId).toBeNull();
    });
    expect(mockClearPendingEntry).toHaveBeenCalledTimes(1);
  });

  it("does not let a superseded completion-target request replace the selection", async () => {
    let resolveEntry:
      | ((entry: Record<string, unknown> | undefined) => void)
      | undefined;
    mockGetCodexEntry.mockImplementation(
      () =>
        new Promise<Record<string, unknown> | undefined>((resolve) => {
          resolveEntry = resolve;
        }),
    );
    const { automatic, container } = setupOverlappingDom();
    const { stub } = createEditorStub(container, () => automatic.firstChild!);
    render(
      <WorkspaceViewportProvider profile="phone">
        <CodexPopover editor={stub} />
      </WorkspaceViewportProvider>,
    );

    fireEvent.mouseOver(automatic);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open in Codex",
      }),
    );
    mockCodexState.pendingEntryId = "newer-request";

    await act(async () => {
      resolveEntry?.({
        id: "e2",
        name: "ボブ",
        type: "character",
        summary: "相棒",
      });
      await Promise.resolve();
    });

    expect(mockCodexState.selectedEntry).toBeNull();
    expect(mockCodexState.pendingEntryId).toBe("newer-request");
    expect(mockClearPendingEntry).not.toHaveBeenCalled();
  });

  it("does not apply a completion-target response after the project changes", async () => {
    let activeProjectId = "project-1";
    let resolveEntry:
      | ((entry: Record<string, unknown> | undefined) => void)
      | undefined;
    mockGetCurrentProjectId.mockImplementation(() => activeProjectId);
    mockGetCodexEntry.mockImplementation(
      () =>
        new Promise<Record<string, unknown> | undefined>((resolve) => {
          resolveEntry = resolve;
        }),
    );
    const { automatic, container } = setupOverlappingDom();
    const { stub } = createEditorStub(container, () => automatic.firstChild!);
    render(
      <WorkspaceViewportProvider profile="phone">
        <CodexPopover editor={stub} />
      </WorkspaceViewportProvider>,
    );

    fireEvent.mouseOver(automatic);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open in Codex",
      }),
    );
    activeProjectId = "project-2";

    await act(async () => {
      resolveEntry?.({
        id: "e2",
        name: "ボブ",
        type: "character",
        summary: "相棒",
      });
      await Promise.resolve();
    });

    expect(mockGetCodexEntry).toHaveBeenCalledWith("project-1", "e2");
    expect(mockCodexState.selectedEntry).toBeNull();
    expect(mockCodexState.pendingEntryId).toBe("e2");
    expect(mockClearPendingEntry).not.toHaveBeenCalled();
  });

  it("keeps the existing wide Open in Codex routing", () => {
    const { container, span } = setupDom();
    const { stub } = createEditorStub(container, () => span.firstChild!);
    render(
      <WorkspaceViewportProvider profile="wide">
        <CodexPopover editor={stub} />
      </WorkspaceViewportProvider>,
    );

    fireEvent.mouseOver(span);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open in Codex",
      }),
    );

    expect(mockRequestOpenInCodex).toHaveBeenCalledWith("e1");
    expect(mockRequestSelectEntry).not.toHaveBeenCalled();
    expect(mockSetSelectedEntry).not.toHaveBeenCalled();
    expect(mockGetCodexEntry).not.toHaveBeenCalled();
    expect(mockOpenCompactSurface).not.toHaveBeenCalled();
  });
});
