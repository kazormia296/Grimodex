// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";

// vi.hoisted ensures these are available when vi.mock factories run
const {
  mockCodexCreate,
  mockCodexUpdate,
  mockRequestSelectEntry,
  mockShowPanel,
  mockSnippetCreate,
  mockToastSuccess,
  mockToastInfo,
  codexEntriesHolder,
} = vi.hoisted(() => ({
  mockCodexCreate: vi.fn(),
  mockCodexUpdate: vi.fn(),
  mockRequestSelectEntry: vi.fn(),
  mockShowPanel: vi.fn(),
  mockSnippetCreate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastInfo: vi.fn(),
  codexEntriesHolder: { entries: [] as Array<Record<string, unknown>> },
}));

// useCodexStore must work as both a hook (selector fn) and have getState()
const { mockUseCodexStore } = vi.hoisted(() => {
  const codexState = {
    get entries() {
      return codexEntriesHolder.entries;
    },
    get create() {
      return mockCodexCreate;
    },
    get update() {
      return mockCodexUpdate;
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

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    info: mockToastInfo,
  },
}));

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
    sel: (s: {
      create: typeof mockSnippetCreate;
      entries: never[];
      loadEntries: () => Promise<void>;
      incrementUsageCount: () => Promise<void>;
    }) => unknown,
  ) =>
    sel({
      create: mockSnippetCreate,
      entries: [],
      loadEntries: async () => {},
      incrementUsageCount: async () => {},
    }),
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
  // Minimal stub: enough for the menu to render and the disable-detector
  // to early-out as "no marks / no block attrs". The detector calls
  // `nodesBetween`, `resolve`, and `isActive`; making them no-ops keeps
  // the test focused on the codex-add behaviour without pulling in a
  // full ProseMirror state.
  return {
    state: {
      selection: { empty: false, from: 0, to: text.length },
      doc: {
        textBetween: () => text,
        nodesBetween: () => undefined,
        resolve: () => ({ marks: () => [] }),
        content: { size: text.length },
      },
    },
    isActive: () => false,
  } as unknown as Editor;
}

function setSemanticLinkPickerOpen(open: boolean) {
  useCursorSettingsStore.setState({ semanticLinkPickerOpen: open } as never);
}

function isSemanticLinkPickerOpen(): boolean {
  return (
    (
      useCursorSettingsStore.getState() as unknown as {
        semanticLinkPickerOpen?: boolean;
      }
    ).semanticLinkPickerOpen === true
  );
}

function Wrapper({
  editor,
  canEditCodexSemanticLink,
  onAddSticky,
}: {
  editor: Editor | null;
  canEditCodexSemanticLink?: boolean;
  onAddSticky?: (
    clientX: number,
    clientY: number,
    target: EventTarget | null,
  ) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const semanticLinkProps =
    canEditCodexSemanticLink === undefined ? {} : { canEditCodexSemanticLink };
  return (
    <div ref={ref} data-testid="container">
      <EditorContextMenu
        editor={editor}
        containerRef={ref}
        onAddSticky={onAddSticky}
        {...semanticLinkProps}
      />
    </div>
  );
}

describe("EditorContextMenu - Codexに追加", () => {
  beforeEach(() => {
    mockCodexCreate.mockClear();
    mockCodexUpdate.mockClear();
    mockRequestSelectEntry.mockClear();
    mockShowPanel.mockClear();
    mockToastSuccess.mockClear();
    mockToastInfo.mockClear();
    codexEntriesHolder.entries = [];
    setSemanticLinkPickerOpen(false);
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

  it("DB-backed scene では選択範囲から semantic-link picker を開く", async () => {
    const editor = makeEditor("既存Codexへ結び付ける範囲");
    const { getByTestId } = render(
      <Wrapper editor={editor} canEditCodexSemanticLink />,
    );

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    fireEvent.click(await screen.findByTestId("context-semantic-link"));

    expect(isSemanticLinkPickerOpen()).toBe(true);
  });

  it.each([
    ["omitted", undefined],
    ["false", false],
  ] as const)(
    "semantic-link action is hidden when the capability is %s",
    async (_label, canEditCodexSemanticLink) => {
      const editor = makeEditor("選択範囲");
      const { getByTestId } = render(
        <Wrapper
          editor={editor}
          canEditCodexSemanticLink={canEditCodexSemanticLink}
        />,
      );

      fireEvent.contextMenu(getByTestId("container"), {
        clientX: 100,
        clientY: 100,
      });

      await screen.findByText("コデックスに追加");
      expect(
        screen.queryByTestId("context-semantic-link"),
      ).not.toBeInTheDocument();
      expect(isSemanticLinkPickerOpen()).toBe(false);
    },
  );
});

describe("EditorContextMenu - 付箋", () => {
  it("passes the right-click point and target to the sticky surface", async () => {
    const onAddSticky = vi.fn();
    const editor = makeEditor("");
    const { getByTestId } = render(
      <Wrapper editor={editor} onAddSticky={onAddSticky} />,
    );
    const container = getByTestId("container");

    fireEvent.contextMenu(container, { clientX: 140, clientY: 220 });
    fireEvent.click(await screen.findByText("付箋を追加"));

    expect(onAddSticky).toHaveBeenCalledWith(140, 220, container);
  });
});

describe("EditorContextMenu - 除外エイリアスとして登録", () => {
  beforeEach(() => {
    mockCodexCreate.mockClear();
    mockCodexUpdate.mockClear();
    mockRequestSelectEntry.mockClear();
    mockShowPanel.mockClear();
    mockToastSuccess.mockClear();
    mockToastInfo.mockClear();
    codexEntriesHolder.entries = [];
  });

  it("単一のCodexにマッチする選択時に登録項目が表示される", async () => {
    codexEntriesHolder.entries = [
      {
        id: "e-1",
        name: "リン",
        type: "character",
        aliases: "[]",
        excludedAliases: "[]",
      },
    ];

    const editor = makeEditor("リン");
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 50,
      clientY: 50,
    });

    expect(
      await screen.findByText("「リン」の除外エイリアスに登録"),
    ).toBeTruthy();
  });

  it("複数のCodexにマッチする選択時は登録項目が表示されない", async () => {
    codexEntriesHolder.entries = [
      {
        id: "e-1",
        name: "リン",
        type: "character",
        aliases: "[]",
        excludedAliases: "[]",
      },
      {
        id: "e-2",
        name: "サト",
        type: "character",
        aliases: "[]",
        excludedAliases: "[]",
      },
    ];

    const editor = makeEditor("リンとサトが");
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 50,
      clientY: 50,
    });

    // Add-to-codex always shows (canSetDisable), but our new item shouldn't.
    await screen.findByText("コデックスに追加");
    expect(screen.queryByText(/除外エイリアスに登録$/)).toBeNull();
  });

  it("クリックで update が選択テキストを追加した配列で呼ばれる", async () => {
    codexEntriesHolder.entries = [
      {
        id: "e-1",
        name: "リン",
        type: "character",
        aliases: "[]",
        excludedAliases: "[]",
      },
    ];
    mockCodexUpdate.mockResolvedValue(undefined);

    const editor = makeEditor("リン");
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 50,
      clientY: 50,
    });

    const btn = await screen.findByText("「リン」の除外エイリアスに登録");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockCodexUpdate).toHaveBeenCalledWith("e-1", {
        excludedAliases: JSON.stringify(["リン"]),
      });
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it("既に excludedAliases に含まれていれば matcher 側で除外され項目が出ない", async () => {
    codexEntriesHolder.entries = [
      {
        id: "e-1",
        name: "リン",
        type: "character",
        aliases: "[]",
        excludedAliases: JSON.stringify(["リン"]),
      },
    ];

    const editor = makeEditor("リン");
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 50,
      clientY: 50,
    });

    await screen.findByText("コデックスに追加");
    expect(screen.queryByText(/除外エイリアスに登録$/)).toBeNull();
  });

  it("200文字超の選択では項目が表示されない", async () => {
    codexEntriesHolder.entries = [
      {
        id: "e-1",
        name: "リン",
        type: "character",
        aliases: "[]",
        excludedAliases: "[]",
      },
    ];

    const longText = "リン" + "あ".repeat(250);
    const editor = makeEditor(longText);
    const { getByTestId } = render(<Wrapper editor={editor} />);

    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 50,
      clientY: 50,
    });

    await screen.findByText("コデックスに追加");
    expect(screen.queryByText(/除外エイリアスに登録$/)).toBeNull();
  });
});
