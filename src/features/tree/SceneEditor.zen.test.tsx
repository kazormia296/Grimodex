// @vitest-environment happy-dom
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/editor/Breadcrumb", () => ({
  Breadcrumb: () => <div data-breadcrumb />,
}));
vi.mock("@/features/editor/TabBar", () => ({
  TabBar: ({ groupIndex }: { groupIndex: number }) => (
    <div data-tab-bar={groupIndex} />
  ),
  DRAG_DATA_KEY: "application/grimodex-tab",
  DRAG_GROUP_KEY: (group: number) => `application/grimodex-tab-g${group}`,
}));
vi.mock("@/features/editor/SceneMetaChipRow", () => ({
  SceneMetaChipRow: ({ groupIndex }: { groupIndex?: number }) => (
    <div data-meta-chip-row={groupIndex ?? 0} />
  ),
}));
vi.mock("@/features/editor/EditorPane", () => ({
  EditorPane: ({ groupIndex }: { groupIndex: number }) => (
    <div data-editor-pane={groupIndex} />
  ),
}));
vi.mock("@/features/editor/LinearEditorView", () => ({
  LinearEditorView: () => <div data-linear-editor />,
}));
vi.mock("@/features/revision/RevisionHistoryModal", () => ({
  RevisionHistoryModal: () => <div data-revision-history-modal />,
}));
vi.mock("@/features/editor/AsciiSplash", () => ({
  AsciiSplash: () => <div data-ascii-splash />,
}));
vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument: vi.fn(),
}));
vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: {},
}));

import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useTabStore } from "@/features/editor/tabStore";
import { SceneEditor } from "./SceneEditor";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";
import { useRevisionStore } from "@/features/revision/revisionStore";

describe("SceneEditor Zen projection", () => {
  beforeEach(() => {
    useRevisionStore.setState({ isOpen: false });
    useCursorSettingsStore.setState({ zenMode: true });
    useSceneStore.setState({ activeSceneId: "scene-2" } as never);
    useTreeStore.setState({
      activeSceneId: "scene-2",
      nodes: [
        { id: "scene-1", nodeType: "scene", title: "One" },
        { id: "scene-2", nodeType: "scene", title: "Two" },
      ],
    } as never);
    useTabStore.setState({
      tabs: [{ nodeId: "scene-1", contentType: "scene", isPreview: false }],
      activeTabId: "scene-1",
      secondaryTabs: [
        { nodeId: "scene-2", contentType: "scene", isPreview: false },
      ],
      secondaryActiveTabId: "scene-2",
      secondaryGroupOpen: true,
      activeGroupIndex: 1,
      splitDirection: "right",
      isLinearMode: false,
      isDraggingTab: false,
      tabStateHydrated: true,
    } as never);
  });

  it("keeps both editor panes mounted while showing only the active pane and no persistent navigation", () => {
    const { container } = render(<SceneEditor />);
    const primaryPane = container.querySelector('[data-editor-pane="0"]');
    const secondaryPane = container.querySelector('[data-editor-pane="1"]');
    const primaryGroup = container.querySelector('[data-editor-group="0"]');
    const secondaryGroup = container.querySelector('[data-editor-group="1"]');

    expect(container.querySelector("[data-breadcrumb]")).toBeNull();
    expect(container.querySelector("[data-tab-bar]")).toBeNull();
    expect(container.querySelector("[data-meta-chip-row]")).toBeNull();
    expect(primaryPane).not.toBeNull();
    expect(secondaryPane).not.toBeNull();
    expect(primaryGroup).toHaveAttribute("aria-hidden", "true");
    expect(primaryGroup).toHaveAttribute("inert");
    expect(secondaryGroup).not.toHaveAttribute("aria-hidden");

    act(() => useCursorSettingsStore.setState({ zenMode: false }));

    expect(container.querySelector('[data-editor-pane="0"]')).toBe(primaryPane);
    expect(container.querySelector('[data-editor-pane="1"]')).toBe(
      secondaryPane,
    );
    expect(primaryGroup).not.toHaveAttribute("aria-hidden");
    expect(container.querySelectorAll("[data-tab-bar]")).toHaveLength(2);
  });

  it("loads the linear editor on first mode entry and restores the normal editor on exit", async () => {
    useCursorSettingsStore.setState({ zenMode: false });
    useTabStore.setState({ isLinearMode: false });
    const { container } = render(<SceneEditor />);

    expect(container.querySelector("[data-linear-editor]")).toBeNull();
    expect(container.querySelector("[data-editor-pane]")).not.toBeNull();

    act(() => useTabStore.setState({ isLinearMode: true }));
    await waitFor(() =>
      expect(container.querySelector("[data-linear-editor]")).not.toBeNull(),
    );
    expect(container.querySelector("[data-editor-pane]")).toBeNull();

    act(() => useTabStore.setState({ isLinearMode: false }));
    await waitFor(() =>
      expect(container.querySelector("[data-editor-pane]")).not.toBeNull(),
    );
    expect(container.querySelector("[data-linear-editor]")).toBeNull();
  });

  it("mounts revision history only for its first open and removes it on close", async () => {
    useCursorSettingsStore.setState({ zenMode: false });
    const { container } = render(<SceneEditor />);

    expect(container.querySelector("[data-revision-history-modal]")).toBeNull();
    act(() => useRevisionStore.setState({ isOpen: true }));
    await waitFor(() =>
      expect(
        container.querySelector("[data-revision-history-modal]"),
      ).not.toBeNull(),
    );

    act(() => useRevisionStore.getState().closeHistory());
    await waitFor(() =>
      expect(
        container.querySelector("[data-revision-history-modal]"),
      ).toBeNull(),
    );
  });
});
