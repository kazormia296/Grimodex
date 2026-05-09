import { useEffect, useMemo, useState } from "react";
import { db } from "@/db/client";
import { sceneCodexMentions, codexTags, sceneBeatPovCache } from "@/db/schema";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useGridStore } from "@/features/grid/gridStore";
import {
  upsertScenePin,
  deleteScenePin,
} from "@/features/codex/sceneCodexPinsApi";
import { addUnplacedBeatFromGrid } from "@/features/editor/beat/addUnplacedBeatFromGrid";
import {
  needsBodyBackfill,
  enqueueRescan,
} from "@/features/codex/mentionRescanQueue";
import { toast } from "sonner";
import { useMatrixStore } from "./matrixStore";
import { useMatrixDataVersionStore } from "./matrixDataVersion";
import { deriveRows } from "./lib/deriveRows";
import { deriveColumns } from "./lib/deriveColumns";
import { deriveCellMap } from "./lib/deriveCells";
import { buildCsvString } from "./lib/exportCsv";
import type { CellSource } from "./lib/deriveCells";
import { MatrixHeader } from "./MatrixHeader";
import { MatrixTable } from "./MatrixTable";
import { MatrixStatusBar } from "./MatrixStatusBar";

interface MentionRow {
  sceneId: string;
  codexEntryId: string;
  source: string;
  role: string;
}

export function MatrixPanel() {
  const nodes = useTreeStore((s) => s.nodes);
  const allEntries = useCodexStore((s) => s.entries);

  const showMode = useMatrixStore((s) => s.showMode);
  const sortMode = useMatrixStore((s) => s.sortMode);
  const displayMode = useMatrixStore((s) => s.displayMode);
  const tagFilter = useMatrixStore((s) => s.tagFilter);
  const groupCodexByType = useMatrixStore((s) => s.groupCodexByType);
  const searchQuery = useMatrixStore((s) => s.searchQuery);
  const collapsedRowIds = useMatrixStore((s) => s.collapsedRowIds);
  const bodyBackfillCompleted = useMatrixStore((s) => s.bodyBackfillCompleted);
  const subplotTagName = useMatrixStore((s) => s.subplotTagName);
  const customSets = useMatrixStore((s) => s.customSets);
  const activeCustomSetId = useMatrixStore((s) => s.activeCustomSetId);
  const hideEmptyRows = useMatrixStore((s) => s.hideEmptyRows);
  const onlyUneditedRows = useMatrixStore((s) => s.onlyUneditedRows);
  const pinnedColumnIds = useMatrixStore((s) => s.pinnedColumnIds);
  const hiddenColumnIds = useMatrixStore((s) => s.hiddenColumnIds);
  const collapsedTypeSections = useMatrixStore((s) => s.collapsedTypeSections);

  // Raw mentions from DB
  const [mentions, setMentions] = useState<MentionRow[]>([]);
  // Beat-level POV override cache: "sceneId::characterId" pairs
  const [beatPovCache, setBeatPovCache] = useState<Set<string>>(new Set());
  // Available tags for the tag filter autocomplete
  const [availableTags, setAvailableTags] = useState<string[]>([]);

  const dataVersion = useMatrixDataVersionStore((s) => s.version);

  // Reload mentions on mount and whenever upstream writes bump dataVersion
  // (scene_codex_mentions / scene_beat_pov_cache writes, rescan completion).
  // A short debounce coalesces rapid bursts (e.g. rescan loop firing per scene).
  useEffect(() => {
    const handle = setTimeout(() => {
      void loadMentions();
      void loadBeatPovCache();
    }, 250);
    return () => clearTimeout(handle);
  }, [dataVersion]);

  async function loadMentions() {
    const rows = await db
      .select({
        sceneId: sceneCodexMentions.sceneId,
        codexEntryId: sceneCodexMentions.codexEntryId,
        source: sceneCodexMentions.source,
        role: sceneCodexMentions.role,
      })
      .from(sceneCodexMentions);
    setMentions(rows);
  }

  async function loadBeatPovCache() {
    const rows = await db
      .select({
        sceneId: sceneBeatPovCache.sceneId,
        povCharacterId: sceneBeatPovCache.povCharacterId,
      })
      .from(sceneBeatPovCache);
    setBeatPovCache(
      new Set(rows.map((r) => `${r.sceneId}::${r.povCharacterId}`)),
    );
  }

  // Load available tags for autocomplete
  useEffect(() => {
    db.select({ name: codexTags.name })
      .from(codexTags)
      .then((rows) => setAvailableTags([...new Set(rows.map((r) => r.name))]))
      .catch(() => {});
  }, []);

  // Startup backfill: run once when body rows are insufficient
  useEffect(() => {
    if (bodyBackfillCompleted) return;
    needsBodyBackfill()
      .then((needed) => {
        if (needed) {
          enqueueRescan(null);
          useMatrixStore.setState({ bodyBackfillCompleted: true });
        } else {
          useMatrixStore.setState({ bodyBackfillCompleted: true });
        }
      })
      .catch(() => {});
  }, [bodyBackfillCompleted]);

  // Derive sorted rows
  const sortedNodes = useMemo(() => {
    const sceneNodes = [...nodes];
    switch (sortMode) {
      case "story-time":
        sceneNodes.sort((a, b) => {
          const ao = a.storyTimeOrder ?? "z";
          const bo = b.storyTimeOrder ?? "z";
          return ao.localeCompare(bo);
        });
        break;
      case "word-count":
        sceneNodes.sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0));
        break;
      case "last-edited":
        sceneNodes.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        break;
      default:
        break;
    }
    return sceneNodes;
  }, [nodes, sortMode]);

  // Derive cell map first (rows depends on it for hideEmpty)
  const cellMap = useMemo(
    () =>
      deriveCellMap(
        mentions as {
          sceneId: string;
          codexEntryId: string;
          source: CellSource;
          role: string;
        }[],
      ),
    [mentions],
  );

  // Total visible scene count before row filters (for status bar)
  const totalSceneCount = useMemo(
    () =>
      deriveRows(sortedNodes, collapsedRowIds, searchQuery || null).filter(
        (r) => !r.isFolder,
      ).length,
    [sortedNodes, collapsedRowIds, searchQuery],
  );

  const rows = useMemo(
    () =>
      deriveRows(sortedNodes, collapsedRowIds, searchQuery || null, {
        hideEmpty: hideEmptyRows,
        onlyUnedited: onlyUneditedRows,
        cellMap,
      }),
    [
      sortedNodes,
      collapsedRowIds,
      searchQuery,
      hideEmptyRows,
      onlyUneditedRows,
      cellMap,
    ],
  );

  // Active custom set entry IDs
  const activeCustomEntryIds = useMemo(() => {
    if (!activeCustomSetId) return undefined;
    return customSets.find((s) => s.id === activeCustomSetId)?.codexEntryIds;
  }, [customSets, activeCustomSetId]);

  // Derive columns
  const columns = useMemo(() => {
    const targets = allEntries.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      aliases: e.aliases ?? undefined,
      excludedAliases: e.excludedAliases ?? undefined,
      tagsCache: e.tagsCache,
    }));
    return deriveColumns(
      targets,
      showMode,
      tagFilter[showMode] ?? [],
      groupCodexByType,
      {
        subplotTagName,
        customEntryIds: activeCustomEntryIds,
        pinnedColumnIds,
        hiddenColumnIds,
        collapsedTypeSections,
      },
    );
  }, [
    allEntries,
    showMode,
    tagFilter,
    groupCodexByType,
    subplotTagName,
    activeCustomEntryIds,
    pinnedColumnIds,
    hiddenColumnIds,
    collapsedTypeSections,
  ]);

  // Stats
  const sceneCount = rows.filter((r) => !r.isFolder).length;
  const totalCodexCount = useMemo(() => {
    const targets = allEntries.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      aliases: e.aliases ?? undefined,
      excludedAliases: e.excludedAliases ?? undefined,
      tagsCache: e.tagsCache,
    }));
    return deriveColumns(
      targets,
      showMode,
      tagFilter[showMode] ?? [],
      groupCodexByType,
      { subplotTagName, customEntryIds: activeCustomEntryIds },
    ).filter((c) => !c.isSectionHeader).length;
  }, [
    allEntries,
    showMode,
    tagFilter,
    groupCodexByType,
    subplotTagName,
    activeCustomEntryIds,
  ]);
  const codexCount = columns.filter((c) => !c.isSectionHeader).length;
  const filledCells = cellMap.size;

  // Actions
  function openScene(sceneId: string) {
    useTabStore.getState().openPinned(sceneId);
    useLayoutStore.getState().showPanel("editor");
  }

  async function handlePin(sceneId: string, entryId: string) {
    await upsertScenePin(sceneId, entryId);
    await loadMentions();
  }

  async function handleRemovePin(sceneId: string, entryId: string) {
    await deleteScenePin(sceneId, entryId);
    await loadMentions();
  }

  async function handleAddBeat(sceneId: string, text: string) {
    await addUnplacedBeatFromGrid(sceneId, text);
  }

  async function handleAddScene(
    parentId: string,
    entryId: string | null,
    synopsis: string,
  ) {
    const treeState = useTreeStore.getState();
    const newNode = await treeState.createNode({
      nodeType: "scene",
      parentId,
    });
    if (synopsis.trim()) {
      const { updateNode } = await import("@/features/tree/api");
      await updateNode(newNode.id, { synopsis: synopsis.trim() });
      useTreeStore.setState((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === newNode.id ? { ...n, synopsis: synopsis.trim() } : n,
        ),
      }));
    }
    if (entryId) {
      await upsertScenePin(newNode.id, entryId);
    }
    await loadMentions();
  }

  async function handleRenameNode(id: string, _currentTitle: string) {
    const newTitle = window.prompt("Rename scene:", _currentTitle);
    if (!newTitle?.trim()) return;
    const { updateNode } = await import("@/features/tree/api");
    await updateNode(id, { title: newTitle.trim() });
    useTreeStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, title: newTitle.trim() } : n,
      ),
    }));
  }

  function handleRevealInScenes(id: string) {
    useTreeStore.getState().revealInTree(id);
    useLayoutStore.getState().showPanel("scenes");
  }

  function handleRevealInGrid(id: string) {
    useGridStore.getState().requestRevealScene(id);
    useLayoutStore.getState().showPanel("grid");
  }

  async function handleExportCsv() {
    try {
      const csv = buildCsvString(rows, columns, cellMap);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: "matrix.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, csv);
      toast.success("CSV をエクスポートしました");
    } catch (err) {
      toast.error("エクスポートに失敗しました", { description: String(err) });
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MatrixHeader
        availableTags={availableTags}
        onExportCsv={() => void handleExportCsv()}
      />
      <MatrixTable
        rows={rows}
        columns={columns}
        cellMap={cellMap}
        beatPovCache={beatPovCache}
        displayMode={displayMode}
        showMode={showMode}
        onOpenScene={openScene}
        onPin={handlePin}
        onRemovePin={handleRemovePin}
        onAddBeat={handleAddBeat}
        onAddScene={handleAddScene}
        onRenameNode={handleRenameNode}
        onRevealInScenes={handleRevealInScenes}
        onRevealInGrid={handleRevealInGrid}
      />
      <MatrixStatusBar
        sceneCount={sceneCount}
        totalSceneCount={totalSceneCount}
        codexCount={codexCount}
        totalCodexCount={totalCodexCount}
        filledCells={filledCells}
      />
    </div>
  );
}
