// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SnippetScopePickerSection } from "./SnippetScopePickerSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockSnippets = [
  {
    id: "s1",
    projectId: "proj-1",
    title: "戦闘シーンの下書き",
    content: "{}",
    tagsCache: null,
    contentSource: null,
    sceneId: null,
    sourceChatMessageId: null,
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "s2",
    projectId: "proj-1",
    title: "世界観メモ",
    content: "{}",
    tagsCache: null,
    contentSource: null,
    sceneId: null,
    sourceChatMessageId: null,
    usageCount: 0,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  },
];

const mockEnsureEntriesLoaded = vi.fn();

vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        entries: mockSnippets,
        ensureEntriesLoaded: mockEnsureEntriesLoaded,
      }),
    {
      getState: () => ({
        entries: mockSnippets,
        ensureEntriesLoaded: mockEnsureEntriesLoaded,
      }),
    },
  ),
}));

describe("SnippetScopePickerSection", () => {
  it("renders snippets and filters by title search", () => {
    render(<SnippetScopePickerSection selectedId={null} onPick={vi.fn()} />);

    expect(screen.getByText("戦闘シーンの下書き")).toBeInTheDocument();
    expect(screen.getByText("世界観メモ")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "世界観" },
    });

    expect(screen.queryByText("戦闘シーンの下書き")).toBeNull();
    expect(screen.getByText("世界観メモ")).toBeInTheDocument();
  });

  it("calls onPick with the snippet id on click", () => {
    const onPick = vi.fn();
    render(<SnippetScopePickerSection selectedId={null} onPick={onPick} />);

    fireEvent.click(screen.getByText("世界観メモ"));
    expect(onPick).toHaveBeenCalledWith("s2");
  });

  it("ensures snippet entries are loaded on mount", () => {
    render(<SnippetScopePickerSection selectedId={null} onPick={vi.fn()} />);
    expect(mockEnsureEntriesLoaded).toHaveBeenCalled();
  });
});
