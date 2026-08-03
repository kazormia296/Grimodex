// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/ui/animated-popover", () => ({
  AnimatedPopover: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
    onClose: () => void;
  }) => (open ? <div data-testid="popover">{children}</div> : null),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        entries: [],
        loadEntries: vi.fn(),
        sortOrder: "recent",
        setSort: vi.fn(),
      }),
    ),
    { getState: vi.fn(() => ({ entries: [], loadEntries: vi.fn() })) },
  ),
}));

vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({ entries: [], loadEntries: vi.fn() }),
    ),
    { getState: vi.fn(() => ({ entries: [], loadEntries: vi.fn() })) },
  ),
}));

vi.mock("@/features/codex/childrenBudget", () => ({
  getChildrenFromArray: vi.fn(() => []),
}));

vi.mock("@/features/codex/components/EntryCard", () => ({
  EntryCardBody: ({ entry }: { entry: { name: string } }) => (
    <span>{entry.name}</span>
  ),
  parseTags: vi.fn(() => []),
}));

vi.mock("@/features/snippets/components/SnippetCardBody", () => ({
  SnippetCardBody: () => null,
}));

vi.mock("@/features/chat/utils/typeLabels", () => ({
  getTypeLabel: (t: string) => t,
}));

vi.mock("@/features/codex/codexSort", () => ({
  sortEntries: (entries: unknown[]) => entries,
  CODEX_SORT_OPTIONS: [{ value: "recent", key: "codex.sortRecent" }],
}));

vi.mock("@/features/codex/components/TagFilterBar", () => ({
  TagFilterBar: () => null,
}));

vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn().mockResolvedValue([]),
  ensureBuiltinTypes: vi.fn().mockResolvedValue(undefined),
}));

import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { PinEntryDialog } from "../PinEntryDialog";

const mockCodexStore = useCodexStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};
const mockSnippetStore = useSnippetStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
  getState: { mockReturnValue: (value: unknown) => void };
};

const noop = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockCodexStore.mockImplementation((sel) =>
    sel({
      entries: [],
      loadEntries: vi.fn(),
      sortOrder: "recent",
      setSort: vi.fn(),
    }),
  );
  (
    useCodexStore as unknown as {
      getState: { mockReturnValue: (v: unknown) => void };
    }
  ).getState.mockReturnValue({ entries: [], loadEntries: vi.fn() });
  mockSnippetStore.mockImplementation((sel) =>
    sel({ entries: [], loadEntries: vi.fn() }),
  );
  mockSnippetStore.getState.mockReturnValue({
    entries: [],
    loadEntries: vi.fn(),
  });
});

describe("PinEntryDialog", () => {
  it("open=false → コンテンツを表示しない", () => {
    render(
      <PinEntryDialog
        open={false}
        pinnedIds={new Set()}
        onPin={noop}
        onUnpin={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByTestId("popover")).toBeNull();
  });

  it("open=true → ダイアログが表示される", () => {
    render(
      <PinEntryDialog
        open={true}
        pinnedIds={new Set()}
        onPin={noop}
        onUnpin={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("popover")).toBeDefined();
  });

  it("title prop → カスタムタイトルを表示する", () => {
    render(
      <PinEntryDialog
        open={true}
        pinnedIds={new Set()}
        onPin={noop}
        onUnpin={noop}
        onClose={noop}
        title="Codex を紐付け"
      />,
    );
    expect(screen.getByText("Codex を紐付け")).toBeDefined();
  });

  it("tabs=['codex'] → タブバーを表示しない（シングルタブ）", () => {
    render(
      <PinEntryDialog
        open={true}
        pinnedIds={new Set()}
        onPin={noop}
        onUnpin={noop}
        onClose={noop}
        tabs={["codex"]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Snippet" })).toBeNull();
  });

  it("tabs=['codex','snippet'] → Codex / Snippet タブバーを表示", () => {
    render(
      <PinEntryDialog
        open={true}
        pinnedIds={new Set()}
        onPin={noop}
        onUnpin={noop}
        onClose={noop}
        tabs={["codex", "snippet"]}
      />,
    );
    expect(screen.getByRole("button", { name: "Codex" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Snippet" })).toBeDefined();
  });

  it("entries あり → エントリ名をリスト表示", () => {
    const entry = {
      id: "e1",
      name: "アリス",
      type: "character",
      tagsCache: null,
    };
    mockCodexStore.mockImplementation((sel) =>
      sel({
        entries: [entry],
        loadEntries: vi.fn(),
        sortOrder: "recent",
        setSort: vi.fn(),
      }),
    );
    (
      useCodexStore as unknown as {
        getState: { mockReturnValue: (v: unknown) => void };
      }
    ).getState.mockReturnValue({ entries: [entry], loadEntries: vi.fn() });

    render(
      <PinEntryDialog
        open={true}
        pinnedIds={new Set()}
        onPin={noop}
        onUnpin={noop}
        onClose={noop}
        tabs={["codex"]}
      />,
    );
    expect(screen.getByText("アリス")).toBeDefined();
  });

  it("lockedIds の Codex/Snippet は checked + disabled で変更できない", () => {
    const codexEntry = {
      id: "e1",
      name: "アリス",
      type: "character",
      tagsCache: null,
    };
    const snippet = {
      id: "s1",
      title: "冒頭メモ",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceChatMessageId: null,
      sceneId: null,
    };
    mockCodexStore.mockImplementation((sel) =>
      sel({
        entries: [codexEntry],
        loadEntries: vi.fn(),
        sortOrder: "recent",
        setSort: vi.fn(),
      }),
    );
    (
      useCodexStore as unknown as {
        getState: { mockReturnValue: (value: unknown) => void };
      }
    ).getState.mockReturnValue({
      entries: [codexEntry],
      loadEntries: vi.fn(),
    });
    mockSnippetStore.mockImplementation((sel) =>
      sel({ entries: [snippet], loadEntries: vi.fn() }),
    );
    mockSnippetStore.getState.mockReturnValue({
      entries: [snippet],
      loadEntries: vi.fn(),
    });
    const onPin = vi.fn();
    const onUnpin = vi.fn();

    render(
      <PinEntryDialog
        open
        pinnedIds={new Set()}
        pinnedSnippetIds={new Set()}
        lockedIds={new Set(["e1", "s1"])}
        onPin={onPin}
        onUnpin={onUnpin}
        onClose={noop}
      />,
    );

    const codexCheckbox = screen.getByRole("checkbox", { name: /アリス/ });
    expect(codexCheckbox).toBeChecked();
    expect(codexCheckbox).toBeDisabled();
    fireEvent.click(codexCheckbox);

    fireEvent.click(screen.getByRole("button", { name: "Snippet" }));
    const snippetCheckbox = screen.getByRole("checkbox", { name: /冒頭メモ/ });
    expect(snippetCheckbox).toBeChecked();
    expect(snippetCheckbox).toBeDisabled();
    fireEvent.click(snippetCheckbox);

    expect(onPin).not.toHaveBeenCalled();
    expect(onUnpin).not.toHaveBeenCalled();
  });

  describe("selectionMode='single'", () => {
    const seedEntries = () => {
      const entry = {
        id: "e1",
        name: "アリス",
        type: "character",
        tagsCache: null,
      };
      mockCodexStore.mockImplementation((sel) =>
        sel({
          entries: [entry],
          loadEntries: vi.fn(),
          sortOrder: "recent",
          setSort: vi.fn(),
        }),
      );
      (
        useCodexStore as unknown as {
          getState: { mockReturnValue: (v: unknown) => void };
        }
      ).getState.mockReturnValue({ entries: [entry], loadEntries: vi.fn() });
      return entry;
    };

    it("checkbox を出さず、行クリックで onSelect(entry) を1回呼ぶ", () => {
      seedEntries();
      const onSelect = vi.fn();
      render(
        <PinEntryDialog
          open={true}
          selectionMode="single"
          onSelect={onSelect}
          onClose={noop}
          tabs={["codex"]}
        />,
      );

      expect(screen.queryByRole("checkbox")).toBeNull();
      fireEvent.click(screen.getByText("アリス"));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: "e1", name: "アリス" }),
      );
    });

    it("multi (default) では checkbox 行のまま", () => {
      seedEntries();
      render(
        <PinEntryDialog
          open={true}
          pinnedIds={new Set()}
          onPin={noop}
          onUnpin={noop}
          onClose={noop}
          tabs={["codex"]}
        />,
      );
      expect(screen.getByRole("checkbox")).toBeDefined();
    });

    it("selectedId の行をハイライトする", () => {
      seedEntries();
      render(
        <PinEntryDialog
          open={true}
          selectionMode="single"
          selectedId="e1"
          onSelect={noop}
          onClose={noop}
          tabs={["codex"]}
        />,
      );
      const row = screen.getByTestId("pin-entry-pick-e1");
      expect(row.getAttribute("data-selected")).toBe("true");
    });
  });
});
