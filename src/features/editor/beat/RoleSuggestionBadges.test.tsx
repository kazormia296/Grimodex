// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RoleSuggestionBadges } from "./RoleSuggestionBadges";
import { useRoleSuggestionsStore } from "./roleSuggestionsStore";
import type { RoleSuggestionEntry } from "./roleSuggestionsStore";

vi.mock("@/features/editor/beat/applyRoleSuggestion", () => ({
  applyRoleSuggestion: vi.fn().mockReturnValue(true),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params) {
        return `${key}:${JSON.stringify(params)}`;
      }
      return key;
    },
  }),
}));

vi.mock("@/components/ui/animated-dropdown", () => ({
  AnimatedDropdown: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="dropdown">{children}</div> : null),
}));

const mockEditor = {} as import("@tiptap/core").Editor;

function makeEntry(
  codexId: string,
  override?: Partial<RoleSuggestionEntry>,
): RoleSuggestionEntry {
  return {
    codexId,
    name: `キャラ-${codexId}`,
    currentRole: "mentioned",
    suggestedRole: "actor",
    confidence: 0.85,
    status: "pending",
    ...override,
  };
}

beforeEach(() => {
  useRoleSuggestionsStore.setState({ byBeatId: {} });
  vi.clearAllMocks();
});

describe("RoleSuggestionBadges", () => {
  it("active suggestions が 0 件のとき何も描画しない", () => {
    const { container } = render(
      <RoleSuggestionBadges editor={mockEditor} beatId="b1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("editor が null のとき何も描画しない", () => {
    useRoleSuggestionsStore.getState().setSuggestions("b1", [makeEntry("c1")]);
    const { container } = render(
      <RoleSuggestionBadges editor={null} beatId="b1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("pending suggestions があるときバッジを描画する", () => {
    useRoleSuggestionsStore
      .getState()
      .setSuggestions("b1", [makeEntry("c1"), makeEntry("c2")]);
    render(<RoleSuggestionBadges editor={mockEditor} beatId="b1" />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("Accept クリックで store の status が accepted になる", async () => {
    useRoleSuggestionsStore.getState().setSuggestions("b1", [makeEntry("c1")]);
    render(<RoleSuggestionBadges editor={mockEditor} beatId="b1" />);

    // Open popover
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByTestId("dropdown")).toBeTruthy();

    // Click accept
    fireEvent.click(screen.getByText("editor.beat.roleSuggestion.accept"));
    const entries = useRoleSuggestionsStore.getState().byBeatId["b1"];
    expect(entries[0].status).toBe("accepted");
  });

  it("Reject クリックで store の status が rejected になり attrs は変更されない", async () => {
    const { applyRoleSuggestion } = vi.mocked(
      await import("@/features/editor/beat/applyRoleSuggestion"),
    );
    useRoleSuggestionsStore.getState().setSuggestions("b1", [makeEntry("c1")]);
    render(<RoleSuggestionBadges editor={mockEditor} beatId="b1" />);

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByText("editor.beat.roleSuggestion.reject"));

    const entries = useRoleSuggestionsStore.getState().byBeatId["b1"];
    expect(entries[0].status).toBe("rejected");
    expect(applyRoleSuggestion).not.toHaveBeenCalled();
  });

  it("4件以上のとき +N バッジを表示する", () => {
    useRoleSuggestionsStore
      .getState()
      .setSuggestions("b1", [
        makeEntry("c1"),
        makeEntry("c2"),
        makeEntry("c3"),
        makeEntry("c4"),
      ]);
    render(<RoleSuggestionBadges editor={mockEditor} beatId="b1" />);
    expect(screen.getByText("+1")).toBeTruthy();
  });
});
