import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";
import type {
  StoryCompare,
  StoryRankResult,
} from "@/features/narrative-extraction/temporal/solver/resolveStoryRanks";

export type PhaseResolutionMode = "reading" | "story" | "auto";
export type ResolutionAxis = "reading" | "story";

export type TemporalAnchor =
  | { kind: "scene"; sceneId: string }
  | { kind: "phase"; phaseId: string }
  | { kind: "latest" }
  | { kind: "base" };

/**
 * Mode-independent scene time data. Resolution mode selects from these maps;
 * changing the mode therefore does not require rebuilding the index.
 */
export interface SceneTimeIndex {
  /** DFS reading order for every reachable, live scene. */
  readingOrder: Map<string, number>;
  /** Normalized, explicitly configured story keys only. */
  explicitStoryOrder: Map<string, string>;
  /** Explicit story keys forward-filled in reading order. */
  inheritedStoryOrder: Map<string, string>;
  /** All non-archived scene rows, including a malformed/orphaned tree row. */
  liveSceneCount: number;
  /** Live scenes with a non-empty explicit story key. */
  scheduledSceneCount: number;
  /** Store-owned invalidation revision. */
  revision: number;
}

function isLiveNode(node: TreeNodeData): boolean {
  return node.archivedAt == null;
}

export function normalizeStoryOrder(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

/**
 * Build the canonical reading-order map without depending on the input row
 * order. sortOrder collisions use id as a deterministic final tie-break.
 */
export function buildReadingOrder(nodes: TreeNodeData[]): Map<string, number> {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const node of nodes) {
    if (!isLiveNode(node)) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(
      (a, b) => cmpKeys(a.sortOrder, b.sortOrder) || a.id.localeCompare(b.id),
    );
  }

  const result = new Map<string, number>();
  const visitedParents = new Set<string | null>();
  let index = 0;

  const visit = (parentId: string | null): void => {
    if (visitedParents.has(parentId)) return;
    visitedParents.add(parentId);
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (node.nodeType === "scene") {
        result.set(node.id, index++);
      } else if (node.nodeType === "folder") {
        visit(node.id);
      }
    }
  };

  visit(null);
  return result;
}

export function buildSceneTimeIndex(
  nodes: TreeNodeData[],
  revision = 0,
): SceneTimeIndex {
  const liveScenes = nodes.filter(
    (node) => node.nodeType === "scene" && isLiveNode(node),
  );
  const readingOrder = buildReadingOrder(nodes);
  const explicitStoryOrder = new Map<string, string>();

  for (const scene of liveScenes) {
    const storyOrder = normalizeStoryOrder(scene.storyTimeOrder);
    if (storyOrder !== null) explicitStoryOrder.set(scene.id, storyOrder);
  }

  const inheritedStoryOrder = new Map<string, string>();
  const scenesByReading = [...readingOrder.entries()].sort(
    (a, b) => a[1] - b[1],
  );
  let lastStoryOrder: string | null = null;
  for (const [sceneId] of scenesByReading) {
    const explicit = explicitStoryOrder.get(sceneId);
    if (explicit !== undefined) lastStoryOrder = explicit;
    if (lastStoryOrder !== null) {
      inheritedStoryOrder.set(sceneId, lastStoryOrder);
    }
  }

  return {
    readingOrder,
    explicitStoryOrder,
    inheritedStoryOrder,
    liveSceneCount: liveScenes.length,
    scheduledSceneCount: explicitStoryOrder.size,
    revision,
  };
}

/**
 * Graph-derived overlay on top of a {@link SceneTimeIndex} (spec §25).
 *
 * Produced by {@link buildTemporalSceneIndex} once a Temporal Constraint
 * Graph has been solved for the project. All maps/sets key on scene id
 * (never `TemporalNodeId`) so downstream UI never has to reason about the
 * graph's opaque node namespace.
 */
export interface TemporalSceneIndex extends SceneTimeIndex {
  /** Digest of the solved graph this overlay was derived from, or null pre-solve. */
  readonly temporalGraphDigest: string | null;
  /** Scene id -> topological story-rank layer (lower = earlier). Absent = unresolved by the graph. */
  readonly resolvedStoryRanks: ReadonlyMap<string, number>;
  /** Scene id -> equal-time group key. Scenes sharing a key are the same story instant. */
  readonly equalTimeGroups: ReadonlyMap<string, string>;
  /** Live scenes the graph does not (yet) place on the story axis. */
  readonly unresolvedSceneIds: ReadonlySet<string>;
  /** Scenes touched by a hard temporal conflict; graph rank is untrusted for these. */
  readonly conflictSceneIds: ReadonlySet<string>;
  /**
   * Precise pairwise story comparison sourced from the solver's rank result
   * (before/after/equal/incomparable), keyed by scene id. Undefined when no
   * graph data was supplied to {@link buildTemporalSceneIndex}.
   */
  readonly compareGraphOrder?: (
    left: string,
    right: string,
  ) => StoryCompare | null;
}

export interface BuildTemporalSceneIndexOptions {
  readonly temporalGraphDigest?: string | null;
  /** Story rank result from `resolveStoryRanks` (solver output), keyed by TemporalNodeId. */
  readonly storyRanks?: StoryRankResult;
  /** 1:1 mapping from graph node id to the scene id it represents. */
  readonly sceneIdByNodeId?: ReadonlyMap<TemporalNodeId, string>;
  /** Node ids the solver flagged as part of a hard conflict. */
  readonly conflictNodeIds?: readonly TemporalNodeId[];
}

/**
 * Wrap a base {@link SceneTimeIndex} with optional solver-derived story rank
 * data. Without `storyRanks`, the result behaves exactly like the base index
 * (graph fields are empty / null) so existing reading/manual-story callers
 * are unaffected.
 */
export function buildTemporalSceneIndex(
  base: SceneTimeIndex,
  options: BuildTemporalSceneIndexOptions = {},
): TemporalSceneIndex {
  const sceneIdByNodeId =
    options.sceneIdByNodeId ?? new Map<TemporalNodeId, string>();
  const resolvedStoryRanks = new Map<string, number>();
  const equalTimeGroups = new Map<string, string>();
  let compareGraphOrder: TemporalSceneIndex["compareGraphOrder"];

  if (options.storyRanks) {
    const storyRanks = options.storyRanks;
    for (const layer of storyRanks.layers) {
      for (const nodeId of layer.nodeIds) {
        const sceneId = sceneIdByNodeId.get(nodeId);
        if (sceneId !== undefined) resolvedStoryRanks.set(sceneId, layer.rank);
      }
    }
    for (const [nodeId, group] of storyRanks.equalTimeGroups) {
      const sceneId = sceneIdByNodeId.get(nodeId);
      if (sceneId !== undefined) equalTimeGroups.set(sceneId, group);
    }

    const nodeIdByScene = new Map<string, TemporalNodeId>();
    for (const [nodeId, sceneId] of sceneIdByNodeId) {
      nodeIdByScene.set(sceneId, nodeId);
    }
    compareGraphOrder = (left: string, right: string): StoryCompare | null => {
      const leftNodeId = nodeIdByScene.get(left);
      const rightNodeId = nodeIdByScene.get(right);
      if (leftNodeId === undefined || rightNodeId === undefined) return null;
      return storyRanks.compare(leftNodeId, rightNodeId);
    };
  }

  const conflictSceneIds = new Set<string>();
  for (const nodeId of options.conflictNodeIds ?? []) {
    const sceneId = sceneIdByNodeId.get(nodeId);
    if (sceneId !== undefined) conflictSceneIds.add(sceneId);
  }

  const unresolvedSceneIds = new Set<string>();
  if (options.storyRanks) {
    for (const sceneId of base.readingOrder.keys()) {
      if (!resolvedStoryRanks.has(sceneId)) unresolvedSceneIds.add(sceneId);
    }
  }

  return {
    ...base,
    temporalGraphDigest: options.temporalGraphDigest ?? null,
    resolvedStoryRanks,
    equalTimeGroups,
    unresolvedSceneIds,
    conflictSceneIds,
    ...(compareGraphOrder ? { compareGraphOrder } : {}),
  };
}

function asTemporalSceneIndex(
  index: SceneTimeIndex,
): TemporalSceneIndex | null {
  return "compareGraphOrder" in index &&
    typeof (index as Partial<TemporalSceneIndex>).compareGraphOrder ===
      "function"
    ? (index as TemporalSceneIndex)
    : null;
}

export function isAutoStoryReady(index: SceneTimeIndex): boolean {
  const temporal = asTemporalSceneIndex(index);
  if (temporal && temporal.conflictSceneIds.size === 0) {
    const liveSceneIds = [...index.readingOrder.keys()];
    const allComparable =
      liveSceneIds.length > 0 &&
      liveSceneIds.every((id) => temporal.resolvedStoryRanks.has(id));
    if (allComparable) return true;
  }
  return (
    index.liveSceneCount > 0 &&
    index.scheduledSceneCount === index.liveSceneCount
  );
}

/**
 * Compare two live scenes on the same mixed-time semantics used by Phase
 * resolution. A negative result places `leftSceneId` before `rightSceneId`.
 *
 * Unlike `linearizeSceneTimeIndex`, this pair-wise comparison does not require
 * every scene in the project to be representable on the selected axis. In
 * explicit `story` mode it uses inherited story keys when both scenes have
 * one, and falls back to reading order only for an unresolved pair. `auto`
 * retains its project-wide coverage gate.
 *
 * Returns null when either scene is not present in the live reading index.
 */
export function compareSceneTime(
  index: SceneTimeIndex,
  mode: PhaseResolutionMode,
  leftSceneId: string,
  rightSceneId: string,
): number | null {
  const leftReadingOrder = index.readingOrder.get(leftSceneId);
  const rightReadingOrder = index.readingOrder.get(rightSceneId);
  if (leftReadingOrder === undefined || rightReadingOrder === undefined) {
    return null;
  }

  // Graph ranks take priority over manual storyTimeOrder, but never for
  // "reading" (which is explicitly graph-independent) and never for a scene
  // currently flagged by a hard conflict (its graph position is untrusted).
  if (mode !== "reading") {
    const temporal = asTemporalSceneIndex(index);
    if (
      temporal &&
      !temporal.conflictSceneIds.has(leftSceneId) &&
      !temporal.conflictSceneIds.has(rightSceneId)
    ) {
      const graphResult = temporal.compareGraphOrder?.(
        leftSceneId,
        rightSceneId,
      );
      if (graphResult) {
        if (graphResult.kind === "before") return -1;
        if (graphResult.kind === "after") return 1;
        if (graphResult.kind === "equal") return 0;
        // "incomparable" falls through to manual storyTimeOrder / reading.
      }
    }
  }

  const storyOrder =
    mode === "auto"
      ? isAutoStoryReady(index)
        ? index.explicitStoryOrder
        : null
      : mode === "story"
        ? index.inheritedStoryOrder
        : null;
  const leftStoryOrder = storyOrder?.get(leftSceneId);
  const rightStoryOrder = storyOrder?.get(rightSceneId);
  if (leftStoryOrder !== undefined && rightStoryOrder !== undefined) {
    const storyDiff = cmpKeys(leftStoryOrder, rightStoryOrder);
    if (storyDiff !== 0) return storyDiff;
  }

  return leftReadingOrder - rightReadingOrder;
}

function storyLinearOrder(
  index: SceneTimeIndex,
  storyOrder: Map<string, string>,
): Map<string, number> | null {
  const ranked = [...index.readingOrder.entries()].map(
    ([sceneId, readingOrder]) => ({
      sceneId,
      readingOrder,
      storyOrder: storyOrder.get(sceneId),
    }),
  );
  if (ranked.some((scene) => scene.storyOrder === undefined)) return null;

  ranked.sort(
    (a, b) =>
      cmpKeys(a.storyOrder!, b.storyOrder!) || a.readingOrder - b.readingOrder,
  );
  return new Map(ranked.map((scene, position) => [scene.sceneId, position]));
}

/**
 * Transitional total-order projection for legacy UI consumers. Semantic Phase
 * resolution must use resolveApplicablePhases because story fallback can be
 * entry-specific and therefore cannot be represented by one project-wide Map.
 */
export function linearizeSceneTimeIndex(
  index: SceneTimeIndex,
  mode: PhaseResolutionMode,
): Map<string, number> {
  if (mode === "reading") return new Map(index.readingOrder);

  if (mode === "auto") {
    if (!isAutoStoryReady(index)) return new Map(index.readingOrder);
    return (
      storyLinearOrder(index, index.explicitStoryOrder) ??
      new Map(index.readingOrder)
    );
  }

  return (
    storyLinearOrder(index, index.inheritedStoryOrder) ??
    new Map(index.readingOrder)
  );
}
