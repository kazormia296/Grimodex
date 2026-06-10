// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodexScopePickerSection } from "./CodexScopePickerSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockEntries = [
  {
    id: "c1",
    name: "Alice",
    type: "character",
    aliases: '["アリス"]',
  },
  {
    id: "c2",
    name: "Bob",
    type: "character",
    aliases: null,
  },
];

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: (sel: (s: { entries: typeof mockEntries }) => unknown) =>
    sel({ entries: mockEntries }),
}));

describe("CodexScopePickerSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders codex entries and filters by search", () => {
    render(<CodexScopePickerSection selectedId={null} onPick={vi.fn()} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "bob" },
    });
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("calls onPick when an entry is clicked", () => {
    const onPick = vi.fn();
    render(<CodexScopePickerSection selectedId={null} onPick={onPick} />);
    fireEvent.click(screen.getByText("Alice"));
    expect(onPick).toHaveBeenCalledWith("c1");
  });
});
