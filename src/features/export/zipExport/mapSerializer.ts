import type { MapBoard } from "@/db/schema";
import {
  listNodePositions,
  listUserEdges,
  listFrames,
  listStickies,
  listAiBranches,
  parseShowConfig,
} from "@/features/map/mapApi";
import { boardToReactFlow } from "@/features/map/boardToReactFlow";
import {
  buildMapJSON,
  buildMapSVG,
  svgToPngBlob,
} from "@/features/map/mapExport";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ColorByAxis } from "@/features/map/types";
import { listPhasesByEntryIds } from "@/features/codex/phaseApi";
import { resolveUniqueSlug } from "./slug";

export interface MapBoardExportInput {
  board: MapBoard;
  treeNodes: TreeNodeData[];
  codexEntries: CodexEntry[];
  snippets: Snippet[];
}

export interface MapBoardFiles {
  json: string;
  svg: string;
  png: Blob | null;
}

export async function serializeMapBoard(
  input: MapBoardExportInput,
): Promise<{ slug: string; files: MapBoardFiles }> {
  const { board, treeNodes, codexEntries, snippets } = input;

  const [positions, userEdges, frames, stickies, aiBranches] =
    await Promise.all([
      listNodePositions(board.id),
      listUserEdges(board.id),
      listFrames(board.id),
      listStickies(board.id),
      listAiBranches(board.id),
    ]);

  const entryIds = codexEntries.map((e) => e.id);
  const phases = await listPhasesByEntryIds(entryIds);
  const phasesByEntry: Record<
    string,
    { id: string; label?: string | null; anchorNodeId?: string | null }[]
  > = {};
  for (const phase of phases) {
    const list = phasesByEntry[phase.entryId] ?? [];
    list.push({
      id: phase.id,
      label: phase.label,
      anchorNodeId: phase.anchorNodeId,
    });
    phasesByEntry[phase.entryId] = list;
  }

  const show = parseShowConfig(board.showConfig);
  const { rfNodes, rfEdges } = boardToReactFlow({
    positions,
    userEdges,
    treeNodes,
    codexEntries,
    snippets,
    stickies,
    aiBranches,
    frames,
    phasesByEntry,
    show,
    colorBy: (board.colorBy as ColorByAxis | undefined) ?? "none",
    visualTheme: "default",
  });

  const svg = buildMapSVG(rfNodes, rfEdges);
  let png: Blob | null = null;
  try {
    png = await svgToPngBlob(svg);
  } catch {
    // PNG requires canvas; skip in headless environments
  }

  const used = new Set<string>();
  const slug = resolveUniqueSlug(board.title || "board", used);

  return {
    slug,
    files: {
      json: buildMapJSON(rfNodes, rfEdges),
      svg,
      png,
    },
  };
}
