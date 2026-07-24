// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { EditorPaneStatusBar } from "./EditorPaneStatusBar";

vi.mock("@/features/editor/EditorStatsFooter", () => ({
  EditorStatsFooter: ({ compact }: { compact?: boolean }) => (
    <span data-testid="editor-stats" data-compact={compact ? "true" : "false"}>
      0
    </span>
  ),
}));
vi.mock("@/features/attribution/AttributionLegend", () => ({
  AttributionLegend: () => null,
}));
vi.mock("@/features/editor/reorder/ReorderModeHint", () => ({
  ReorderModeHint: () => null,
}));
vi.mock("@/features/ai-policy/AiPolicyBadge", () => ({
  AiPolicyBadge: () => null,
}));
vi.mock("@/features/license/LicenseBadge", () => ({
  LicenseBadge: () => null,
}));
vi.mock("@/features/lint/StatusBarIndicator", () => ({
  StatusBarIndicator: () => null,
}));

const baseProps = {
  activeStatus: "draft" as const,
  editor: null,
  getStatsSceneId: () => "scene-1",
  isEntryMode: false,
  isSceneContentLoading: false,
  showAttribution: false,
  aiRatio: 0,
  isSaving: false,
  isDirty: false,
  onOpenAttribution: () => {},
  onOpenRevisionHistory: () => {},
};

afterEach(() => cleanup());

beforeEach(() => {
  useCursorSettingsStore.setState({ zenMode: false });
});

describe("EditorPaneStatusBar phone status control", () => {
  it("uses a native status selector that cannot be clipped by editor chrome", () => {
    const onStatusChange = vi.fn();
    render(
      <WorkspaceViewportProvider profile="phone">
        <EditorPaneStatusBar {...baseProps} onStatusChange={onStatusChange} />
      </WorkspaceViewportProvider>,
    );

    const selector = screen.getByRole("combobox", {
      name: i18next.t("editor.status.changeStatus"),
    });
    expect(selector).toHaveValue("draft");
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByTestId("editor-stats")).toHaveAttribute(
      "data-compact",
      "true",
    );

    fireEvent.change(selector, { target: { value: "complete" } });
    expect(onStatusChange).toHaveBeenCalledWith("complete");
  });

  it("preserves the desktop status button and popover", () => {
    render(
      <WorkspaceViewportProvider profile="wide">
        <EditorPaneStatusBar {...baseProps} onStatusChange={() => {}} />
      </WorkspaceViewportProvider>,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: i18next.t("editor.status.draft"),
      }),
    );
    expect(
      screen.getByRole("button", {
        name: i18next.t("editor.status.complete"),
      }),
    ).toBeInTheDocument();
  });
});
