import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
import { useGridDerivedData } from "./gridSelectors";
import { GridHeader } from "./GridHeader";
import { GridColumn } from "./GridColumn";
import { GridLooseColumn } from "./GridLooseColumn";
import { GridStatusBar } from "./GridStatusBar";
import {
  activeDragKind,
  computeSceneDropTarget,
  computeColumnDropTarget,
} from "./gridDndUtils";
import type { TreeNodeData } from "@/features/tree/treeStore";

export function GridPanel() {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const moveNode = useTreeStore((s) => s.moveNode);
  const nodes = useTreeStore((s) => s.nodes);

  const containerId = useGridStore((s) => s.containerId);
  const display = useGridStore((s) => s.display);
  const setContainerId = useGridStore((s) => s.setContainerId);
  const loadForProject = useGridStore((s) => s.loadForProject);

  const { chapters, looseScenes, totalChapters, totalScenes } =
    useGridDerivedData(containerId);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const pointerYRef = useRef(0);

  // Load persisted containerId when project changes
  useEffect(() => {
    void loadForProject(projectId);
  }, [projectId, loadForProject]);

  // Track actual pointer Y for accurate above/below-midpoint DnD decisions
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      pointerYRef.current = e.clientY;
    };
    window.addEventListener("pointermove", handler);
    return () => window.removeEventListener("pointermove", handler);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const activeIdStr = String(e.active.id);
    const overIdStr = e.over ? String(e.over.id) : "";
    if (!overIdStr) return;

    const kind = activeDragKind(activeIdStr);

    if (kind === "scene") {
      const sceneId = activeIdStr.replace(/^scene-/, "");
      // Build ordered scene list from derived data (already sorted by sortOrder)
      const orderedScenes = [
        ...chapters.flatMap((ch) =>
          ch.scenes.map((s) => ({ id: s.id, parentId: s.parentId })),
        ),
        ...looseScenes.map((s) => ({ id: s.id, parentId: s.parentId })),
      ];
      const overNode = e.over;
      const rect = overNode?.rect ?? { top: 0, height: 60 };

      const target = computeSceneDropTarget(
        sceneId,
        overIdStr,
        pointerYRef.current,
        { top: rect.top, height: rect.height },
        orderedScenes,
        containerId,
      );
      if (target) {
        void moveNode(sceneId, target.targetParentId, target.afterId);
      }
      return;
    }

    if (kind === "column") {
      const folderId = activeIdStr.replace(/^column-/, "");
      const folderParentMap: Record<string, string | null> = {};
      for (const n of nodes) {
        if (n.nodeType === "folder") folderParentMap[n.id] = n.parentId;
      }
      const target = computeColumnDropTarget(
        folderId,
        overIdStr,
        folderParentMap,
      );
      if (target) {
        void moveNode(folderId, target.targetParentId, target.afterId);
      }
    }
  }

  // Find active drag item for DragOverlay
  const activeDragNode: TreeNodeData | null = activeId
    ? (nodes.find((n) => n.id === activeId.replace(/^(scene|column)-/, "")) ??
      null)
    : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full flex-col overflow-hidden">
        <GridHeader
          containerId={containerId}
          projectId={projectId}
          chapterCount={totalChapters}
          onContainerChange={(id) => void setContainerId(projectId, id)}
          onToggleDisplay={() => setShowDisplayMenu((v) => !v)}
        />

        {/* Display settings flyout */}
        {showDisplayMenu && (
          <GridDisplayMenu onClose={() => setShowDisplayMenu(false)} />
        )}

        {/* Column scroll area */}
        <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4">
          {chapters.map(({ folder, scenes }) => (
            <GridColumn
              key={folder.id}
              folder={folder}
              scenes={scenes}
              display={display}
            />
          ))}

          {looseScenes.length > 0 && (
            <GridLooseColumn
              containerId={containerId}
              scenes={looseScenes}
              display={display}
            />
          )}

          {chapters.length === 0 && looseScenes.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {t(
                "grid.empty",
                "章がありません。「章を追加」から始めましょう。",
              )}
            </div>
          )}
        </div>

        <GridStatusBar
          totalChapters={totalChapters}
          totalScenes={totalScenes}
        />
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDragNode && (
          <div className="rounded-md border bg-card px-3 py-2 shadow-lg text-sm opacity-90">
            {activeDragNode.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

// Inline display settings flyout
function GridDisplayMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const display = useGridStore((s) => s.display);
  const setDisplay = useGridStore((s) => s.setDisplay);

  const toggles: Array<{
    key: keyof typeof display;
    label: string;
  }> = [
    {
      key: "showSynopsis",
      label: t("grid.display.synopsis", "シノプシス表示"),
    },
    { key: "showBeats", label: t("grid.display.beats", "Beat プレビュー表示") },
    { key: "showCodex", label: t("grid.display.codex", "Codex チップ表示") },
    {
      key: "showLabel",
      label: t("grid.display.label", "ステータスラベル表示"),
    },
  ];

  return (
    <div className="border-b bg-popover px-4 py-3">
      <div className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        {t("grid.display.title", "表示設定")}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {toggles.map(({ key, label }) => (
          <label
            key={key}
            className="flex items-center gap-1.5 text-[12px] cursor-pointer"
          >
            <input
              type="checkbox"
              checked={display[key]}
              onChange={(e) => setDisplay({ [key]: e.target.checked })}
              className="h-3 w-3"
            />
            {label}
          </label>
        ))}
      </div>
      <button
        className="mt-2 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={onClose}
      >
        {t("common.close", "閉じる")}
      </button>
    </div>
  );
}
