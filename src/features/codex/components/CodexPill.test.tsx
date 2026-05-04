// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodexPill } from "./CodexPill";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import type { CodexEntry } from "@/features/codex/api";

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ showPanel: vi.fn() })) },
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: vi.fn(() => ({ requestSelectEntry: vi.fn() })) },
}));

function makeEntry(overrides: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id: "e1",
    projectId: "p1",
    type: "character",
    name: "アリス",
    aliases: [],
    excludedAliases: [],
    summary: null,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    parentId: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as CodexEntry;
}

describe("CodexPill", () => {
  it("entry.name を表示する", () => {
    render(<CodexPill entry={makeEntry({ name: "Bob" })} />);
    expect(screen.getByText("Bob")).toBeDefined();
  });

  it("typeColorMap の色が背景に適用される", () => {
    useCodexHighlightStore.getState().setTypeColorMap({
      character: { hl: "#112233", tx: "#ffffff", fg: "#aabbcc" },
    });
    const { container } = render(<CodexPill entry={makeEntry()} />);
    const pill = container.firstChild as HTMLElement;
    expect(pill.style.backgroundColor).toBe("#112233");
    useCodexHighlightStore.getState().setTypeColorMap({});
  });

  it("hover でポップオーバーが portal に出る", () => {
    render(<CodexPill entry={makeEntry({ name: "Carol" })} />);
    const pill = screen.getByText("Carol").closest("span")!.parentElement!;
    fireEvent.mouseEnter(pill);
    // CodexEntryPopoverContent renders the name again inside the popover
    const matches = screen.getAllByText("Carol");
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("disablePopover で hover してもポップオーバーが出ない", () => {
    render(<CodexPill entry={makeEntry({ name: "Dave" })} disablePopover />);
    const pill = screen.getByText("Dave").closest("span")!.parentElement!;
    fireEvent.mouseEnter(pill);
    expect(screen.getAllByText("Dave").length).toBe(1);
  });

  it("actions slot が描画される", () => {
    render(
      <CodexPill
        entry={makeEntry()}
        actions={<button data-testid="x">x</button>}
      />,
    );
    expect(screen.getByTestId("x")).toBeDefined();
  });

  it("onClick が指定されているとそれが優先される", () => {
    const onClick = vi.fn();
    render(<CodexPill entry={makeEntry({ name: "Eve" })} onClick={onClick} />);
    fireEvent.click(screen.getByText("Eve"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
