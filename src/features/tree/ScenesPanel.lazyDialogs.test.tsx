// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

const treeState = {
  activeSceneId: "",
  selectedIds: [],
  isLoading: false,
  expandedIds: [],
  filterQuery: "",
  viewMode: "tree",
  sortMode: "manual",
  statusFilter: [],
  labelFilter: [],
  charCounts: {},
  threadFilter: [],
  showWordCounts: false,
  showStatusDots: false,
  showLabelDots: false,
  showPlotThreadTrack: false,
  showAiAttribution: false,
  autoRevealActiveScene: false,
  pendingRevealId: null,
  projectId: "project-a",
  createNode: vi.fn(),
  expandAll: vi.fn(),
  collapseAll: vi.fn(),
  setFilterQuery: vi.fn(),
  setStatusFilter: vi.fn(),
  toggleLabelFilter: vi.fn(),
  clearLabelFilter: vi.fn(),
  setLabelFilter: vi.fn(),
  toggleThreadFilter: vi.fn(),
  clearThreadFilter: vi.fn(),
  setThreadFilter: vi.fn(),
  toggleExpand: vi.fn(),
  setActiveScene: vi.fn(),
  moveNode: vi.fn(),
  setPendingRenameId: vi.fn(),
  deleteNode: vi.fn(),
};

vi.mock("./treeStore", () => {
  const useTreeStore = Object.assign(
    (selector: (state: typeof treeState) => unknown) => selector(treeState),
    {
      getState: () => treeState,
      setState: vi.fn(),
    },
  );
  return { useTreeStore };
});
vi.mock("./useScenesPanelNodes", () => ({ useScenesPanelNodes: () => [] }));
vi.mock("./useScenesDerivedData", () => ({
  useScenesDerivedData: () => ({
    childMap: {},
    nodeMap: {},
    flatRows: [],
    flatNodes: [],
  }),
}));
vi.mock("./useScenesDnd", () => ({
  useScenesDnd: () => ({
    sensors: [],
    draggingId: null,
    onDragStart: vi.fn(),
    onDragMove: vi.fn(),
    onDragEnd: vi.fn(),
    onDragOver: vi.fn(),
    onDragCancel: vi.fn(),
  }),
}));
vi.mock("./useScenesKeyboard", () => ({
  useScenesKeyboard: () => vi.fn(),
}));
vi.mock("@/features/labels/labelStore", () => ({
  useLabelStore: (selector: (state: unknown) => unknown) =>
    selector({ labels: [], nodeLabels: {} }),
}));
vi.mock("@/features/plot-threads/plotThreadStore", () => ({
  usePlotThreadStore: (selector: (state: unknown) => unknown) =>
    selector({ threads: [], links: [], branches: [] }),
}));
vi.mock("@/features/plot-threads/sceneThreadTracks", () => ({
  buildSceneThreadTracks: () => ({
    columns: [],
    cellByNode: {},
    connectorByNode: {},
  }),
}));
vi.mock("@/features/timeline/timelineStore", () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) =>
    selector({ plotSubwaySort: "manual" }),
}));
vi.mock("@/features/post-effect/lensStore", () => ({
  useLensStore: (selector: (state: unknown) => unknown) =>
    selector({ load: vi.fn() }),
}));
vi.mock("@/features/chat/store", () => ({
  selectProviderReadiness: () => "ready",
  useAiSettingsStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock("@/features/trash-bin/useDropTarget", () => ({
  useDropTarget: () => vi.fn(),
}));
vi.mock("@/lib/animation", () => ({
  DURATIONS: { fast: 0.1 },
  EASINGS: { easeOut: "ease-out" },
  useReducedMotion: () => true,
}));
vi.mock("@/lib/perfLog", () => ({ recordMark: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: PropsWithChildren) => children,
  motion: { div: ({ children }: PropsWithChildren) => <div>{children}</div> },
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: PropsWithChildren) => children,
  DragOverlay: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: PropsWithChildren) => children,
  ContextMenuTrigger: ({ children }: PropsWithChildren) => children,
}));
vi.mock("./ScenesToolbar", async () => {
  const { useContext } = await import("react");
  const { ScenesPanelContext } = await import("./ScenesPanelContext");
  return {
    ScenesToolbar: () => {
      const actions = useContext(ScenesPanelContext);
      if (!actions) return null;
      return (
        <div>
          <button onClick={actions.openManageLabels}>open-labels</button>
          <button
            onClick={() =>
              actions.openAiTree({ mode: "scaffold", rootRef: null })
            }
          >
            open-ai-tree
          </button>
        </div>
      );
    },
  };
});
vi.mock("./ScenesFilterBar", () => ({ ScenesFilterBar: () => null }));
vi.mock("./RootContextMenu", () => ({ RootContextMenu: () => null }));
vi.mock("./VirtualTree", () => ({ VirtualTree: () => null }));
vi.mock("./BottomDropZone", () => ({ BottomDropZone: () => null }));
vi.mock("./DeleteConfirmDialog", () => ({ DeleteConfirmDialog: () => null }));
vi.mock("./TreeNodeItem", () => ({ NodeIcon: () => null }));
vi.mock("./StatusDot", () => ({ StatusDot: () => null }));
vi.mock("./SynopsisArea", () => ({ SynopsisArea: () => null }));
vi.mock("@/features/grid/StructureTemplatePicker", () => ({
  StructureTemplatePicker: () => null,
}));
vi.mock("@/components/ui/skeleton-patterns", () => ({
  TreeRowSkeletonList: () => null,
}));
vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument: vi.fn(),
}));
vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: {},
}));
vi.mock("./aiScaffold/AiTreeDialog", () => ({
  AiTreeDialog: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="ai-tree-dialog" onClick={onClose} />
  ),
}));
vi.mock("@/features/labels/ManageLabelsDialog", () => ({
  ManageLabelsDialog: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="manage-labels-dialog" onClick={onClose} />
  ),
}));

import { ScenesPanel } from "./ScenesPanel";

describe("ScenesPanel lazy dialogs", () => {
  it("loads each dialog on first open and unmounts it on close", async () => {
    render(<ScenesPanel />);

    expect(screen.queryByTestId("manage-labels-dialog")).toBeNull();
    fireEvent.click(screen.getByText("open-labels"));
    fireEvent.click(await screen.findByTestId("manage-labels-dialog"));
    await waitFor(() =>
      expect(screen.queryByTestId("manage-labels-dialog")).toBeNull(),
    );

    expect(screen.queryByTestId("ai-tree-dialog")).toBeNull();
    fireEvent.click(screen.getByText("open-ai-tree"));
    fireEvent.click(await screen.findByTestId("ai-tree-dialog"));
    await waitFor(() =>
      expect(screen.queryByTestId("ai-tree-dialog")).toBeNull(),
    );
  });
});
