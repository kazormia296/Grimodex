import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { db } from "@/db/client";
import { sceneCodexMentions, codexTags, sceneBeatPovCache } from "@/db/schema";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/application/editor/defaultEditorNavigation";
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
import { saveTextFile } from "@/lib/exportFile";
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
  const { t } = useTranslation();
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

  // 兄弟ノードの並び順コンパレータ。deriveRows は親ごとに子バケットを再ソート
  // するため、フラット配列を事前ソートしても捨てられてしまう（sortOrder 以外の
  // モードが無効化される）。モード別コンパレータを deriveRows に渡し、各バケットを
  // 実際のモードで並べる。
  const siblingComparator = useMemo(() => {
    switch (sortMode) {
      case "story-time":
        return (a: TreeNodeData, b: TreeNodeData) =>
          (a.storyTimeOrder ?? "z").localeCompare(b.storyTimeOrder ?? "z");
      case "word-count":
        return (a: TreeNodeData, b: TreeNodeData) =>
          (b.charCount ?? 0) - (a.charCount ?? 0);
      case "last-edited":
        return (a: TreeNodeData, b: TreeNodeData) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      default:
        return (a: TreeNodeData, b: TreeNodeData) =>
          a.sortOrder.localeCompare(b.sortOrder);
    }
  }, [sortMode]);

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
      deriveRows(nodes, collapsedRowIds, searchQuery || null, {
        sortComparator: siblingComparator,
      }).filter((r) => !r.isFolder).length,
    [nodes, siblingComparator, collapsedRowIds, searchQuery],
  );

  const rows = useMemo(
    () =>
      deriveRows(nodes, collapsedRowIds, searchQuery || null, {
        hideEmpty: hideEmptyRows,
        onlyUnedited: onlyUneditedRows,
        cellMap,
        sortComparator: siblingComparator,
      }),
    [
      nodes,
      siblingComparator,
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
    openEditorDocument(
      {
        target: { kind: "scene", documentId: sceneId },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: true,
      },
      defaultEditorNavigationPorts,
    );
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
      // 保存ダイアログは Rust 側 (security audit PIO-2)。キャンセルは null。
      const saved = await saveTextFile(
        "matrix.csv",
        { name: "CSV", extensions: ["csv"] },
        csv,
        "text/csv",
      );
      if (saved !== null) toast.success(t("matrix.export.success"));
    } catch (err) {
      toast.error(t("matrix.export.failed"), { description: String(err) });
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
