// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";

const openEditorDocument = vi.hoisted(() => vi.fn());

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
  EditorPane: ({
    groupIndex,
    nodeId,
    inputProjectionAuthority,
    inputProjectionScopeKey,
    isForegroundInputProjection,
  }: {
    groupIndex: number;
    nodeId: string;
    inputProjectionAuthority?: string;
    inputProjectionScopeKey?: string;
    isForegroundInputProjection?: boolean;
  }) => (
    <div
      data-editor-pane={groupIndex}
      data-node-id={nodeId}
      data-input-authority={inputProjectionAuthority}
      data-input-scope={inputProjectionScopeKey}
      data-input-foreground={isForegroundInputProjection ? "true" : "false"}
    />
  ),
}));
vi.mock("@/features/editor/LinearEditorView", () => ({
  LinearEditorView: () => <div data-linear-editor />,
}));
vi.mock("@/features/revision/RevisionHistoryModal", () => ({
  RevisionHistoryModal: () => null,
}));
vi.mock("@/features/editor/AsciiSplash", () => ({
  AsciiSplash: () => <div data-ascii-splash />,
}));
vi.mock("./PhoneEmptySceneBootstrap", () => ({
  PhoneEmptySceneBootstrap: () => <div data-phone-empty-bootstrap />,
}));
vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument,
}));
vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: {},
}));

import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useTabStore } from "@/features/editor/tabStore";
import { SceneEditor } from "./SceneEditor";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";

describe("SceneEditor phone projection", () => {
  beforeEach(() => {
    openEditorDocument.mockReset();
    useInlineAiStore.getState().reset();
    useProjectStore.setState({ currentProjectId: "project-a" } as never);
    useWorkspaceStore.setState({
      activeWorkspacePath: "/workspace/a",
      workspaceOpenRevision: 7,
    } as never);
    useCursorSettingsStore.setState({ zenMode: false });
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

  it("does not create a preview tab before persisted tabs are hydrated", () => {
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      secondaryTabs: [],
      secondaryActiveTabId: null,
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
      tabStateHydrated: false,
    } as never);

    render(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );
    expect(openEditorDocument).not.toHaveBeenCalled();

    act(() => useTabStore.setState({ tabStateHydrated: true }));

    expect(openEditorDocument).toHaveBeenCalledOnce();
    expect(openEditorDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "scene", documentId: "scene-2" },
        mode: "preview",
      }),
      expect.anything(),
    );
  });

  it("does not let a provisional tree scene steal a restored non-scene tab", () => {
    useTabStore.setState({
      tabs: [
        {
          nodeId: "codex-1",
          contentType: "codex",
          isPreview: false,
          overridePhaseId: "phase-1",
        },
      ],
      activeTabId: "codex-1",
      secondaryTabs: [],
      secondaryActiveTabId: null,
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
      tabStateHydrated: true,
    } as never);

    const { container } = render(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(openEditorDocument).not.toHaveBeenCalled();
    expect(container.querySelector('[data-editor-pane="0"]')).toHaveAttribute(
      "data-node-id",
      "codex-1",
    );
  });

  it("projects one active scene without tabs while preserving both desktop editors", () => {
    const { container, rerender } = render(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );
    const primaryPane = container.querySelector('[data-editor-pane="0"]');
    const secondaryPane = container.querySelector('[data-editor-pane="1"]');
    const primaryGroup = container.querySelector('[data-editor-group="0"]');
    const secondaryGroup = container.querySelector('[data-editor-group="1"]');

    expect(container.querySelector("[data-breadcrumb]")).toBeNull();
    expect(primaryPane).not.toBeNull();
    expect(primaryPane).toHaveAttribute("data-node-id", "scene-1");
    expect(secondaryPane).not.toBeNull();
    expect(secondaryPane).toHaveAttribute("data-node-id", "scene-2");
    expect(primaryGroup).toHaveAttribute("aria-hidden", "true");
    expect(primaryGroup).toHaveAttribute("inert");
    expect(secondaryGroup).not.toHaveAttribute("aria-hidden");
    expect(primaryPane).toHaveAttribute("data-input-authority", "workspace");
    expect(primaryPane).toHaveAttribute(
      "data-input-scope",
      JSON.stringify(["editor-input-v1", "/workspace/a", 7, "project-a"]),
    );
    expect(primaryPane).toHaveAttribute("data-input-foreground", "false");
    expect(secondaryPane).toHaveAttribute("data-input-foreground", "true");
    expect(container.querySelector("[data-tab-bar]")).toBeNull();

    act(() =>
      rerender(
        <WorkspaceViewportProvider profile="wide">
          <SceneEditor />
        </WorkspaceViewportProvider>,
      ),
    );

    expect(container.querySelector('[data-editor-pane="0"]')).toBe(primaryPane);
    expect(primaryPane).toHaveAttribute("data-node-id", "scene-1");
    expect(container.querySelector('[data-editor-pane="1"]')).toBe(
      secondaryPane,
    );
    expect(container.querySelectorAll("[data-tab-bar]")).toHaveLength(2);
    expect(primaryGroup).not.toHaveAttribute("aria-hidden");
    expect(primaryGroup).not.toHaveAttribute("inert");
    expect(secondaryGroup).not.toHaveAttribute("aria-hidden");
    expect(container.querySelector("[data-breadcrumb]")).not.toBeNull();
    expect(useTabStore.getState().activeGroupIndex).toBe(1);
  });

  it("ignores persisted linear mode and keeps a single editor on a phone", () => {
    useTabStore.setState({ isLinearMode: true });
    const { container } = render(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(container.querySelector("[data-linear-editor]")).toBeNull();
    expect(container.querySelector("[data-tab-bar]")).toBeNull();
    expect(container.querySelectorAll("[data-editor-pane]")).toHaveLength(2);
    expect(container.querySelector('[data-editor-pane="1"]')).toHaveAttribute(
      "data-node-id",
      "scene-2",
    );
    expect(container.querySelector('[data-editor-group="0"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      container.querySelector('[data-editor-group="1"]'),
    ).not.toHaveAttribute("aria-hidden");
  });

  it("shows the group that already owns the selected phone document", () => {
    useTabStore.setState({ activeGroupIndex: 0 });
    const { container } = render(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(container.querySelector('[data-editor-pane="0"]')).toHaveAttribute(
      "data-node-id",
      "scene-1",
    );
    expect(container.querySelector('[data-editor-pane="1"]')).toHaveAttribute(
      "data-node-id",
      "scene-2",
    );
    expect(container.querySelector('[data-editor-group="0"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      container.querySelector('[data-editor-group="1"]'),
    ).not.toHaveAttribute("aria-hidden");
    expect(useTabStore.getState().activeGroupIndex).toBe(0);
  });

  it("keeps the inline-AI owner visible when a document is duplicated", () => {
    useTabStore.setState({
      tabs: [{ nodeId: "scene-2", contentType: "scene", isPreview: false }],
      activeTabId: "scene-2",
      secondaryTabs: [
        { nodeId: "scene-2", contentType: "scene", isPreview: false },
      ],
      secondaryActiveTabId: "scene-2",
      secondaryGroupOpen: true,
      activeGroupIndex: 1,
    } as never);
    useInlineAiStore.setState({
      status: "diffShown",
      activeEditorGroup: 0,
    });

    const { container } = render(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(
      container.querySelector('[data-editor-group="0"]'),
    ).not.toHaveAttribute("aria-hidden");
    expect(container.querySelector('[data-editor-group="1"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("restores desktop scene context without adding a mobile-only tab", () => {
    useTreeStore.setState({ activeSceneId: "scene-1" } as never);
    useTabStore.setState({
      secondaryTabs: [],
      secondaryActiveTabId: null,
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
    } as never);
    const tabsBefore = useTabStore.getState().tabs;
    const { rerender } = render(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    rerender(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );
    act(() => useTreeStore.getState().setActiveScene("scene-2"));
    expect(useTreeStore.getState().activeSceneId).toBe("scene-2");

    rerender(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(useTreeStore.getState().activeSceneId).toBe("scene-1");
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
    expect(openEditorDocument).not.toHaveBeenCalled();
  });

  it("keeps a mobile-only document mounted across resize until inline AI is resolved", () => {
    useTreeStore.setState({ activeSceneId: "scene-1" } as never);
    useTabStore.setState({
      secondaryTabs: [],
      secondaryActiveTabId: null,
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
    } as never);
    const tabsBefore = useTabStore.getState().tabs;
    const { container, rerender } = render(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );
    rerender(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );
    act(() => {
      useTreeStore.getState().setActiveScene("scene-2");
      useInlineAiStore.setState({
        status: "diffShown",
        activeEditorGroup: 0,
      });
    });

    rerender(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );
    expect(container.querySelector('[data-editor-pane="0"]')).toHaveAttribute(
      "data-node-id",
      "scene-2",
    );
    expect(container.querySelector("[data-tab-bar]")).toBeNull();
    expect(useInlineAiStore.getState().status).toBe("diffShown");

    act(() => useInlineAiStore.getState().reset());
    expect(container.querySelector('[data-editor-pane="0"]')).toHaveAttribute(
      "data-node-id",
      "scene-1",
    );
    expect(container.querySelector("[data-tab-bar]")).not.toBeNull();
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
    expect(openEditorDocument).not.toHaveBeenCalled();
  });

  it("adopts the phone document as the first desktop tab when no desktop projection exists", () => {
    useTreeStore.setState({ activeSceneId: "scene-2" } as never);
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      secondaryTabs: [],
      secondaryActiveTabId: null,
      secondaryGroupOpen: false,
      activeGroupIndex: 0,
    } as never);
    const { rerender } = render(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    rerender(
      <WorkspaceViewportProvider profile="wide">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(openEditorDocument).toHaveBeenCalledOnce();
    expect(openEditorDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "scene", documentId: "scene-2" },
        mode: "preview",
      }),
      expect.anything(),
    );
  });

  it("never projects a folder id into the phone editor", () => {
    useSceneStore.setState({ activeSceneId: "folder-1" } as never);
    useTreeStore.setState({
      activeSceneId: "folder-1",
      nodes: [{ id: "folder-1", nodeType: "folder", title: "Folder" }],
    } as never);

    const { container } = render(
      <WorkspaceViewportProvider profile="phone">
        <SceneEditor />
      </WorkspaceViewportProvider>,
    );

    expect(container.querySelector('[data-node-id="folder-1"]')).toBeNull();
    expect(container.querySelector('[data-editor-group="1"]')).toContainElement(
      container.querySelector("[data-phone-empty-bootstrap]"),
    );
  });
});
