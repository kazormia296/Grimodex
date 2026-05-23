import type { CodexEntry } from "@/features/codex/api";
import type { MapNodePositionRecord } from "../types";
import { posToNodeKey } from "./posToNodeKey";
import type { LayoutUserEdge, SceneLayoutInput } from "./types";

export interface LayoutFingerprintInput {
  boardId: string;
  scenes: SceneLayoutInput[];
  codexEntries: CodexEntry[];
  positions: MapNodePositionRecord[];
  userEdges?: LayoutUserEdge[];
}

/** Stable fingerprint for theme layout recompute triggers (excludes x/y). */
export function layoutFingerprint(input: LayoutFingerprintInput): string {
  const sceneIds = input.scenes.map((s) => s.id).sort();
  const codexIds = input.codexEntries.map((e) => e.id).sort();

  const pinned = input.positions
    .filter(
      (p) =>
        (p.nodeRefType === "scene" || p.nodeRefType === "codex") &&
        p.pinned === 1,
    )
    .map((p) => p.treeNodeId ?? p.codexEntryId)
    .filter(Boolean)
    .sort();

  const posById = new Map(input.positions.map((p) => [p.id, p]));
  const userEdgePairs = (input.userEdges ?? [])
    .map((edge) => {
      const fromKey = posToNodeKey(posById.get(edge.fromPositionId));
      const toKey = posToNodeKey(posById.get(edge.toPositionId));
      if (!fromKey || !toKey) return null;
      return [fromKey, toKey].sort().join("->");
    })
    .filter((pair): pair is string => pair !== null)
    .sort();

  const sceneMeta = input.scenes
    .map((s) => ({
      id: s.id,
      tags: [...(s.tags ?? [])].sort(),
      pov: s.povCharacterId ?? null,
      loc: s.locationId ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const codexMeta = input.codexEntries
    .map((e) => ({ id: e.id, tagsCache: e.tagsCache ?? "" }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    boardId: input.boardId,
    sceneIds,
    codexIds,
    pinned,
    userEdgePairs,
    sceneMeta,
    codexMeta,
  });
}

/** @alias layoutFingerprint — plan/API name */
export const computeLayoutFingerprint = layoutFingerprint;
