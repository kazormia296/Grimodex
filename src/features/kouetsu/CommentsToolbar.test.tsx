// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CommentsToolbar } from "./CommentsToolbar";

vi.mock("./KouetsuScopePicker", () => ({
  KouetsuScopePicker: () => <button data-testid="scope-picker" />,
}));
vi.mock("./PseudoCommentRunControl", () => ({
  PseudoCommentRunControl: () => (
    <button data-testid="pseudo-comment-run-control" />
  ),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

describe("CommentsToolbar", () => {
  it("フィルター行と操作行を分け、操作を2列に配置する", () => {
    render(
      <CommentsToolbar
        filter="all"
        onFilterChange={vi.fn()}
        showDismissed={false}
        onShowDismissedChange={vi.fn()}
        sortOrder="newest"
        onSortOrderChange={vi.fn()}
        liveReaderEnabled={false}
        onLiveReaderEnabledChange={vi.fn()}
        liveReaderRunning={false}
        onPseudoCompleted={vi.fn()}
        onReload={vi.fn()}
      />,
    );

    const toolbar = screen.getByTestId("comments-toolbar");
    expect(
      within(toolbar).getByTestId("comments-toolbar-filters"),
    ).toBeVisible();

    const actions = within(toolbar).getByTestId("comments-toolbar-actions");
    expect(actions).toHaveClass("grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]");
    expect(
      within(actions).getByTestId("comments-toolbar-preferences"),
    ).toBeVisible();
    expect(
      within(actions).getByTestId("comments-toolbar-generation"),
    ).toBeVisible();
  });
});
