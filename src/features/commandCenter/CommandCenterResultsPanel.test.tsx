// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandCenterResultsPanel } from "./CommandCenterResultsPanel";
import { usePanelStore } from "./store/commandCenterStore";
import { useResultsPanelStore } from "./store/resultsPanelStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock("./hooks/useCommandCenterSearch", () => ({
  useCommandCenterSearch: vi.fn(),
}));

vi.mock("./hooks/useFilteredSections", () => ({
  useFilteredSections: () => [],
}));

vi.mock("./CommandCenterFilterBar", () => ({
  CommandCenterFilterBar: () => <div data-testid="filter-bar" />,
}));

describe("CommandCenterResultsPanel", () => {
  beforeEach(() => {
    usePanelStore.getState().reset();
    useResultsPanelStore.getState().reset();
  });

  it("is search-only and no longer advertises a command mode", () => {
    render(<CommandCenterResultsPanel />);

    expect(
      screen.getByRole("textbox", { name: "検索…" }),
    ).toBeInTheDocument();
    expect(screen.getByText("キーワードを入力して検索")).toBeInTheDocument();
    expect(screen.queryByText(/コマンドモード/)).not.toBeInTheDocument();
  });
});
