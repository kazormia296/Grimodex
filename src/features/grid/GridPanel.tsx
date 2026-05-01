import { useEffect, useMemo, useRef, useState } from "react";
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
import { useCodexStore } from "@/features/codex/codexStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useGridStore } from "./gridStore";
import { useGridDerivedData } from "./gridSelectors";
import { useGridCardVisibility } from "./useGridCardVisibility";
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
  const charCounts = useTreeStore((s) => s.charCounts);

  const containerId = useGridStore((s) => s.containerId);
  const display = useGridStore((s) => s.display);
  const filter = useGridStore((s) => s.filter);
  const searchQuery = useGridStore((s) => s.searchQuery);
  const setContainerId = useGridStore((s) => s.setContainerId);
  const loadForProject = useGridStore((s) => s.loadForProject);

  const pinsByScene = useSceneCodexPinsStore((s) => s.pinsByScene);

  const { chapters, looseScenes, totalChapters, totalScenes } =
    useGridDerivedData(containerId);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [showPanelMenu, setShowPanelMenu] = useState(false);
  const pointerYRef = useRef(0);

  useEffect(() => {
    void loadForProject(projectId);
  }, [projectId, loadForProject]);

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

  const activeDragNode: TreeNodeData | null = activeId
    ? (nodes.find((n) => n.id === activeId.replace(/^(scene|column)-/, "")) ??
      null)
    : null;

  // Compute visibility for all displayed scenes
  const allDisplayedScenes = useMemo(
    () => [...chapters.flatMap((ch) => ch.scenes), ...looseScenes],
    [chapters, looseScenes],
  );

  const visibility = useGridCardVisibility({
    scenes: allDisplayedScenes,
    searchQuery,
    filter,
    charCounts,
    pinsByScene,
  });

  // Total char count (live from store)
  const totalCharCount = useMemo(
    () =>
      allDisplayedScenes.reduce(
        (sum, s) => sum + (charCounts[s.id] ?? s.charCount ?? 0),
        0,
      ),
    [allDisplayedScenes, charCounts],
  );

  const hasActiveFilter =
    filter.emptyOnly || filter.hideCompleted || filter.codexFilter !== null;

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
          onTogglePanelMenu={() => setShowPanelMenu((v) => !v)}
        />

        {showPanelMenu && (
          <GridPanelMenu
            onClose={() => setShowPanelMenu(false)}
            hasActiveFilter={hasActiveFilter}
          />
        )}

        <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4">
          {chapters.map(({ folder, scenes }) => (
            <GridColumn
              key={folder.id}
              folder={folder}
              scenes={scenes}
              display={display}
              visibility={visibility}
            />
          ))}

          {looseScenes.length > 0 && (
            <GridLooseColumn
              containerId={containerId}
              scenes={looseScenes}
              display={display}
              chapters={chapters.map((ch) => ch.folder)}
              visibility={visibility}
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
          totalCharCount={totalCharCount}
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

// Panel-level menu: Display + Filter + Help
function GridPanelMenu({
  onClose,
  hasActiveFilter,
}: {
  onClose: () => void;
  hasActiveFilter: boolean;
}) {
  const { t } = useTranslation();
  const display = useGridStore((s) => s.display);
  const setDisplay = useGridStore((s) => s.setDisplay);
  const filter = useGridStore((s) => s.filter);
  const setFilter = useGridStore((s) => s.setFilter);
  const clearFilter = useGridStore((s) => s.clearFilter);
  const codexEntries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);

  useEffect(() => {
    if (codexEntries.length === 0) loadEntries();
  }, [codexEntries.length, loadEntries]);

  const displayToggles: Array<{
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
    {
      key: "compactCards",
      label: t("grid.display.compact", "コンパクト表示"),
    },
  ];

  return (
    <div className="border-b bg-popover px-4 py-3 space-y-3">
      {/* Display */}
      <div>
        <div className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {t("grid.display.title", "表示設定")}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {displayToggles.map(({ key, label }) => (
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
      </div>

      {/* Filter */}
      <div>
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {t("grid.filter.title", "フィルタ")}
          {hasActiveFilter && (
            <button
              className="text-[10px] normal-case text-primary hover:underline"
              onClick={clearFilter}
            >
              {t("grid.filter.clear", "クリア")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
            <input
              type="checkbox"
              checked={filter.emptyOnly}
              onChange={(e) => setFilter({ emptyOnly: e.target.checked })}
              className="h-3 w-3"
            />
            {t("grid.filter.emptyOnly", "空のシーンのみ")}
          </label>
          <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
            <input
              type="checkbox"
              checked={filter.hideCompleted}
              onChange={(e) => setFilter({ hideCompleted: e.target.checked })}
              className="h-3 w-3"
            />
            {t("grid.filter.hideCompleted", "完成済みを非表示")}
          </label>
        </div>
        {codexEntries.length > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t("grid.filter.codex", "Codex:")}
            </span>
            <select
              value={filter.codexFilter ?? ""}
              onChange={(e) =>
                setFilter({ codexFilter: e.target.value || null })
              }
              className="rounded border border-input bg-background px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t("grid.filter.codexAll", "すべて")}</option>
              {codexEntries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <button
        className="text-[11px] text-muted-foreground hover:text-foreground"
        onClick={onClose}
      >
        {t("common.close", "閉じる")}
      </button>
    </div>
  );
}
