import { useRef, useState, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import { MatrixCell } from "./MatrixCell";
import { SceneCellMenu } from "./menu/SceneCellMenu";
import { ChapterCellMenu } from "./menu/ChapterCellMenu";
import { SceneRowHeaderMenu } from "./menu/SceneRowHeaderMenu";
import { ChapterRowHeaderMenu } from "./menu/ChapterRowHeaderMenu";
import { ColumnHeaderMenu } from "./menu/ColumnHeaderMenu";
import { ScenePopover } from "./menu/ScenePopover";
import { BeatPopover } from "./menu/BeatPopover";
import type { MatrixRow } from "./lib/deriveRows";
import type { MatrixColumnOrHeader } from "./lib/deriveColumns";
import type { CellInfo } from "./lib/deriveCells";
import type { DisplayMode } from "./matrixStore";
import type { ShowMode } from "./lib/deriveColumns";
import { useMatrixStore } from "./matrixStore";

const ROW_HEIGHT = 32;
const COL_WIDTH = 80;
const ROW_HEADER_WIDTH = 200;
const COL_HEADER_HEIGHT = 40;

interface ContextMenuState {
  type:
    | "scene-cell"
    | "chapter-cell"
    | "scene-header"
    | "chapter-header"
    | "column-header";
  x: number;
  y: number;
  rowIndex: number;
  colIndex: number;
}

interface PopoverState {
  type: "scene" | "beat";
  x: number;
  y: number;
  rowIndex: number;
  colIndex: number;
  initialText: string;
}

interface Props {
  rows: MatrixRow[];
  columns: MatrixColumnOrHeader[];
  cellMap: Map<string, CellInfo>;
  /** "sceneId::characterId" pairs from scene_beat_pov_cache */
  beatPovCache: Set<string>;
  displayMode: DisplayMode;
  showMode: ShowMode;
  onOpenScene: (sceneId: string) => void;
  onPin: (sceneId: string, entryId: string) => Promise<void>;
  onRemovePin: (sceneId: string, entryId: string) => Promise<void>;
  onAddBeat: (sceneId: string, text: string) => Promise<void>;
  onAddScene: (
    parentId: string,
    entryId: string | null,
    synopsis: string,
  ) => Promise<void>;
  onRenameNode: (id: string, title: string) => void;
  onRevealInScenes: (id: string) => void;
  onRevealInGrid: (id: string) => void;
}

export function MatrixTable({
  rows,
  columns,
  cellMap,
  beatPovCache,
  displayMode,
  showMode,
  onOpenScene,
  onPin,
  onRemovePin,
  onAddBeat,
  onAddScene,
  onRenameNode,
  onRevealInScenes,
  onRevealInGrid,
}: Props) {
  const toggleRowCollapsed = useMatrixStore((s) => s.toggleRowCollapsed);
  const collapsedRowIds = useMatrixStore((s) => s.collapsedRowIds);
  const pinnedColumnIds = useMatrixStore((s) => s.pinnedColumnIds);
  const collapsedTypeSections = useMatrixStore((s) => s.collapsedTypeSections);
  const activeCustomSetId = useMatrixStore((s) => s.activeCustomSetId);
  const togglePinnedColumn = useMatrixStore((s) => s.togglePinnedColumn);
  const toggleHiddenColumn = useMatrixStore((s) => s.toggleHiddenColumn);
  const toggleTypeSection = useMatrixStore((s) => s.toggleTypeSection);
  const removeCodexFromCustomSet = useMatrixStore(
    (s) => s.removeCodexFromCustomSet,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // Reset scroll when switching custom sets
  useEffect(() => {
    containerRef.current?.scrollTo(0, 0);
  }, [activeCustomSetId]);

  // Sync column header horizontal scroll with body
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      if (headerRef.current) headerRef.current.scrollLeft = el.scrollLeft;
    };
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => COL_WIDTH,
    overscan: 4,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);

  function closeAll() {
    setContextMenu(null);
    setPopover(null);
  }

  const handleCellContextMenu = useCallback(
    (e: React.MouseEvent, rowIdx: number, colIdx: number) => {
      e.preventDefault();
      const row = rows[rowIdx];
      setContextMenu({
        type: row.isFolder ? "chapter-cell" : "scene-cell",
        x: e.clientX,
        y: e.clientY,
        rowIndex: rowIdx,
        colIndex: colIdx,
      });
    },
    [rows],
  );

  const handleRowHeaderContextMenu = useCallback(
    (e: React.MouseEvent, rowIdx: number) => {
      e.preventDefault();
      const row = rows[rowIdx];
      setContextMenu({
        type: row.isFolder ? "chapter-header" : "scene-header",
        x: e.clientX,
        y: e.clientY,
        rowIndex: rowIdx,
        colIndex: -1,
      });
    },
    [rows],
  );

  const handleColHeaderContextMenu = useCallback(
    (e: React.MouseEvent, colIdx: number) => {
      e.preventDefault();
      setContextMenu({
        type: "column-header",
        x: e.clientX,
        y: e.clientY,
        rowIndex: -1,
        colIndex: colIdx,
      });
    },
    [],
  );

  function openAddScene(rowIdx: number, colIdx: number, x: number, y: number) {
    setPopover({
      type: "scene",
      x,
      y,
      rowIndex: rowIdx,
      colIndex: colIdx,
      initialText: "",
    });
  }

  function openAddBeat(
    rowIdx: number,
    colIdx: number,
    x: number,
    y: number,
    initialText: string,
  ) {
    setPopover({
      type: "beat",
      x,
      y,
      rowIndex: rowIdx,
      colIndex: colIdx,
      initialText,
    });
  }

  async function commitAddScene(synopsis: string, addAnother: boolean) {
    if (!popover) return;
    const row = rows[popover.rowIndex];
    const col = columns[popover.colIndex];
    const entryId = col && !col.isSectionHeader ? col.entry.id : null;
    await onAddScene(row.node.id, entryId, synopsis);
    if (addAnother) {
      // keep popover open, reset text
      setPopover((prev) => (prev ? { ...prev, initialText: "" } : null));
    } else {
      closeAll();
    }
  }

  async function commitAddBeat(text: string) {
    if (!popover) return;
    const row = rows[popover.rowIndex];
    await onAddBeat(row.node.id, text);
    closeAll();
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Column headers — sticky top */}
      <div className="sticky top-0 z-20 flex border-b bg-background">
        {/* Corner placeholder aligned with row headers */}
        <div
          className="shrink-0 border-r border-border/30"
          style={{ width: ROW_HEADER_WIDTH, height: COL_HEADER_HEIGHT }}
        />
        <div
          ref={headerRef}
          data-testid="mx-header"
          style={{ overflowX: "hidden", flex: 1, height: COL_HEADER_HEIGHT }}
        >
          <div
            style={{
              width: colVirtualizer.getTotalSize(),
              position: "relative",
              height: COL_HEADER_HEIGHT,
            }}
          >
            {virtualCols.map((vc) => {
              const col = columns[vc.index];
              if (col.isSectionHeader) {
                return (
                  <div
                    key={vc.key}
                    style={{
                      position: "absolute",
                      left: vc.start,
                      width: vc.size,
                      height: COL_HEADER_HEIGHT,
                    }}
                    className="flex items-end justify-center border-r border-border/30 pb-1 text-[10px] font-semibold uppercase text-muted-foreground"
                  >
                    {col.sectionType}
                  </div>
                );
              }
              return (
                <div
                  key={vc.key}
                  data-testid={`mx-colhead-${vc.index}`}
                  style={{
                    position: "absolute",
                    left: vc.start,
                    width: vc.size,
                    height: COL_HEADER_HEIGHT,
                  }}
                  className="flex items-end justify-center overflow-hidden border-r border-border/30 pb-1"
                  title={col.entry.name}
                  onContextMenu={(e) => handleColHeaderContextMenu(e, vc.index)}
                >
                  <span className="max-w-full truncate px-1 text-[10px]">
                    {col.entry.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div
        ref={containerRef}
        data-testid="mx-body"
        className="overflow-auto"
        style={{ height: `calc(100% - ${COL_HEADER_HEIGHT}px)` }}
      >
        <div
          style={{
            width: ROW_HEADER_WIDTH + colVirtualizer.getTotalSize(),
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
          }}
        >
          {virtualRows.map((vr) => {
            const row = rows[vr.index];
            return (
              <div
                key={vr.key}
                style={{
                  position: "absolute",
                  top: vr.start,
                  height: ROW_HEIGHT,
                  width: "100%",
                  display: "flex",
                }}
              >
                {/* Row header (sticky left) */}
                <div
                  className={`sticky left-0 z-10 flex shrink-0 cursor-pointer select-none items-center overflow-hidden border-b border-r border-border/30 bg-background px-2 text-xs ${
                    row.isFolder
                      ? "font-semibold text-foreground"
                      : "text-foreground/80"
                  }`}
                  style={{
                    width: ROW_HEADER_WIDTH,
                    paddingLeft: 8 + row.depth * 12,
                  }}
                  onContextMenu={(e) => handleRowHeaderContextMenu(e, vr.index)}
                >
                  {row.isFolder && (
                    <button
                      type="button"
                      onClick={() => toggleRowCollapsed(row.node.id)}
                      className="mr-1 text-muted-foreground"
                    >
                      {collapsedRowIds.has(row.node.id) ? "▶" : "▼"}
                    </button>
                  )}
                  <span className="truncate">{row.node.title}</span>
                </div>

                {/* Cells */}
                <div
                  style={{
                    width: colVirtualizer.getTotalSize(),
                    position: "relative",
                  }}
                >
                  {virtualCols.map((vc) => {
                    const col = columns[vc.index];
                    if (col.isSectionHeader) {
                      return (
                        <div
                          key={vc.key}
                          style={{
                            position: "absolute",
                            left: vc.start,
                            width: vc.size,
                            height: ROW_HEIGHT,
                          }}
                          className="border-b border-r border-border/20 bg-muted/20"
                        />
                      );
                    }
                    const key = `${row.node.id}::${col.entry.id}`;
                    const cellInfo = cellMap.get(key);
                    const isBeatPovOverride = beatPovCache.has(key);
                    return (
                      <div
                        key={vc.key}
                        data-testid={`mx-cell-${vr.index}-${vc.index}`}
                        style={{
                          position: "absolute",
                          left: vc.start,
                          width: vc.size,
                          height: ROW_HEIGHT,
                        }}
                      >
                        <MatrixCell
                          cellInfo={cellInfo}
                          colEntryId={col.entry.id}
                          povCharacterId={row.node.povCharacterId}
                          locationId={row.node.locationId}
                          isBeatPovOverride={isBeatPovOverride}
                          displayMode={displayMode}
                          showMode={showMode}
                          isFolder={row.isFolder}
                          onClick={
                            !row.isFolder
                              ? () => onOpenScene(row.node.id)
                              : undefined
                          }
                          onContextMenu={(e) =>
                            handleCellContextMenu(e, vr.index, vc.index)
                          }
                          onHoverAddClick={() =>
                            openAddScene(vr.index, vc.index, vc.start, vr.start)
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Context menus (portalled) */}
      {contextMenu &&
        createPortal(
          <>
            {contextMenu.type === "scene-cell" &&
              (() => {
                const row = rows[contextMenu.rowIndex];
                const col = columns[contextMenu.colIndex];
                const entryId = col && !col.isSectionHeader ? col.entry.id : "";
                const entryName =
                  col && !col.isSectionHeader ? col.entry.name : "";
                const cellInfo = cellMap.get(`${row.node.id}::${entryId}`);
                const source = cellInfo?.topSource;
                return (
                  <SceneCellMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    sceneId={row.node.id}
                    sceneName={row.node.title}
                    entryId={entryId}
                    entryName={entryName}
                    source={source}
                    onClose={closeAll}
                    onOpenScene={() => onOpenScene(row.node.id)}
                    onPin={() => void onPin(row.node.id, entryId)}
                    onRemovePin={() => void onRemovePin(row.node.id, entryId)}
                    onAddBeat={() =>
                      openAddBeat(
                        contextMenu.rowIndex,
                        contextMenu.colIndex,
                        contextMenu.x,
                        contextMenu.y,
                        `@${entryName} `,
                      )
                    }
                    onShowInGrid={() => onRevealInGrid(row.node.id)}
                  />
                );
              })()}
            {contextMenu.type === "chapter-cell" &&
              (() => {
                const row = rows[contextMenu.rowIndex];
                const col = columns[contextMenu.colIndex];
                const entryName =
                  col && !col.isSectionHeader ? col.entry.name : null;
                return (
                  <ChapterCellMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    chapterName={row.node.title}
                    entryName={entryName}
                    onClose={closeAll}
                    onAddSceneWithEntry={() =>
                      openAddScene(
                        contextMenu.rowIndex,
                        contextMenu.colIndex,
                        contextMenu.x,
                        contextMenu.y,
                      )
                    }
                    onAddSceneNoEntry={() =>
                      openAddScene(
                        contextMenu.rowIndex,
                        -1,
                        contextMenu.x,
                        contextMenu.y,
                      )
                    }
                    onOpenInScenes={() => onRevealInScenes(row.node.id)}
                  />
                );
              })()}
            {contextMenu.type === "scene-header" &&
              (() => {
                const row = rows[contextMenu.rowIndex];
                return (
                  <SceneRowHeaderMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    sceneName={row.node.title}
                    onClose={closeAll}
                    onOpenScene={() => onOpenScene(row.node.id)}
                    onAddBeat={() =>
                      openAddBeat(
                        contextMenu.rowIndex,
                        -1,
                        contextMenu.x,
                        contextMenu.y,
                        "",
                      )
                    }
                    onRename={() => onRenameNode(row.node.id, row.node.title)}
                    onShowInScenes={() => onRevealInScenes(row.node.id)}
                    onShowInGrid={() => onRevealInGrid(row.node.id)}
                  />
                );
              })()}
            {contextMenu.type === "chapter-header" &&
              (() => {
                const row = rows[contextMenu.rowIndex];
                const isCollapsed = collapsedRowIds.has(row.node.id);
                return (
                  <ChapterRowHeaderMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    chapterName={row.node.title}
                    isCollapsed={isCollapsed}
                    onClose={closeAll}
                    onAddScene={() =>
                      openAddScene(
                        contextMenu.rowIndex,
                        -1,
                        contextMenu.x,
                        contextMenu.y,
                      )
                    }
                    onRename={() => onRenameNode(row.node.id, row.node.title)}
                    onShowInScenes={() => onRevealInScenes(row.node.id)}
                    onToggleCollapse={() => toggleRowCollapsed(row.node.id)}
                  />
                );
              })()}
            {contextMenu.type === "column-header" &&
              (() => {
                const col = columns[contextMenu.colIndex];
                if (!col || col.isSectionHeader) return null;
                const isPinned = pinnedColumnIds.includes(col.entry.id);
                const isSectionCollapsed = collapsedTypeSections.includes(
                  col.entry.type,
                );
                return (
                  <ColumnHeaderMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    entryName={col.entry.name}
                    entryType={col.entry.type}
                    isPinned={isPinned}
                    isSectionCollapsed={isSectionCollapsed}
                    onClose={closeAll}
                    onTogglePin={() => togglePinnedColumn(col.entry.id)}
                    onHide={() => toggleHiddenColumn(col.entry.id)}
                    onToggleTypeSection={() =>
                      toggleTypeSection(col.entry.type)
                    }
                    onRemoveFromSet={
                      showMode === "custom" && activeCustomSetId
                        ? () =>
                            removeCodexFromCustomSet(
                              activeCustomSetId,
                              col.entry.id,
                            )
                        : undefined
                    }
                  />
                );
              })()}
          </>,
          document.body,
        )}

      {/* Popovers (portalled) */}
      {popover &&
        createPortal(
          <>
            {popover.type === "scene" && (
              <ScenePopover
                anchorX={popover.x}
                anchorY={popover.y}
                onConfirm={(synopsis) => void commitAddScene(synopsis, false)}
                onAddAnother={(synopsis) => void commitAddScene(synopsis, true)}
                onClose={closeAll}
              />
            )}
            {popover.type === "beat" && (
              <BeatPopover
                anchorX={popover.x}
                anchorY={popover.y}
                initialText={popover.initialText}
                onConfirm={(text) => void commitAddBeat(text)}
                onClose={closeAll}
              />
            )}
          </>,
          document.body,
        )}
    </div>
  );
}
