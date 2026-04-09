// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { Editor } from "@tiptap/react";

// vi.hoisted ensures these are available when vi.mock factories run
const {
  mockCodexCreate,
  mockRequestSelectEntry,
  mockShowPanel,
  mockSnippetCreate,
} = vi.hoisted(() => ({
  mockCodexCreate: vi.fn(),
  mockRequestSelectEntry: vi.fn(),
  mockShowPanel: vi.fn(),
  mockSnippetCreate: vi.fn(),
}));

// useCodexStore must work as both a hook (selector fn) and have getState()
const { mockUseCodexStore } = vi.hoisted(() => {
  const codexState = {
    get create() {
      return mockCodexCreate;
    },
    get requestSelectEntry() {
      return mockRequestSelectEntry;
    },
  };
  const store = Object.assign(
    (sel: (s: typeof codexState) => unknown) => sel(codexState),
    { getState: () => codexState },
  );
  return { mockUseCodexStore: store };
});

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: mockUseCodexStore,
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: {
    getState: () => ({ showPanel: mockShowPanel }),
  },
}));

vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: (
    sel: (s: { create: typeof mockSnippetCreate }) => unknown,
  ) => sel({ create: mockSnippetCreate }),
}));

vi.mock("@/features/tree/store", () => ({
  useSceneStore: (sel: (s: { activeSceneId: string }) => unknown) =>
    sel({ activeSceneId: "scene-1" }),
}));

vi.mock("@/features/codex/api", () => ({
  BUILTIN_CODEX_TYPES: ["character"],
}));

import { EditorContextMenu } from "./EditorContextMenu";

function makeEditor(text: string): Editor {
  return {
    state: {
      selection: { empty: false, from: 0, to: text.length },
      doc: { textBetween: () => text },
    },
  } as unknown as Editor;
}

function Wrapper({ editor }: { editor: Editor | null }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="container">
      <EditorContextMenu editor={editor} containerRef={ref} />
    </div>
  );
}

describe("EditorContextMenu - Codexに追加", () => {
  beforeEach(() => {
    mockCodexCreate.mockClear();
    mockRequestSelectEntry.mockClear();
    mockShowPanel.mockClear();
  });

  it("Codex追加後にshowPanel('codex')とrequestSelectEntryを呼ぶ", async () => {
    const newEntry = { id: "entry-new-1" };
    mockCodexCreate.mockResolvedValue(newEntry);

    const editor = makeEditor("テスト選択テキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });

    const btn = await screen.findByText("コデックスに追加");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockCodexCreate).toHaveBeenCalledWith({
        type: "character",
        name: "テスト選択テキスト",
        summary: "",
      });
      expect(mockShowPanel).toHaveBeenCalledWith("codex");
      expect(mockRequestSelectEntry).toHaveBeenCalledWith("entry-new-1");
    });
  });

  it("Codex追加が失敗（undefined返却）した場合はshowPanel/requestSelectEntryを呼ばない", async () => {
    mockCodexCreate.mockResolvedValue(undefined);

    const editor = makeEditor("テスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });

    const btn = await screen.findByText("コデックスに追加");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockCodexCreate).toHaveBeenCalled();
    });

    expect(mockShowPanel).not.toHaveBeenCalled();
    expect(mockRequestSelectEntry).not.toHaveBeenCalled();
  });
});
