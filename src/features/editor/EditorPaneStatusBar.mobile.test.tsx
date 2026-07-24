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
  it("removes the persistent status chrome from the phone editor", () => {
    const onStatusChange = vi.fn();
    const { container } = render(
      <WorkspaceViewportProvider profile="phone">
        <EditorPaneStatusBar {...baseProps} onStatusChange={onStatusChange} />
      </WorkspaceViewportProvider>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("editor-stats")).toBeNull();
    expect(onStatusChange).not.toHaveBeenCalled();
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
