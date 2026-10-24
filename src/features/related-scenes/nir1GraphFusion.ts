import rankingPolicy from "../../../policies/narrative/nir1-related-scenes-ranking.json";
import type {
  RelatedScenesGraphOnlyRow,
  RelatedScenesGraphPathAttachment,
} from "@/../electron/shared/relatedScenesSearchWire";
import type { RelatedScene } from "./selectRelatedScenes";
import type {
  Nir1AdmittedScene,
  Nir1RelatedScenesResult,
} from "./nir1RelatedScenesResult";
import type { Nir1GraphJoinOutcome } from "./nir1RelatedScenesGraphJoin";
import type { Nir1RelatedScenesGraphPayload } from "./nir1RelatedScenesFetchTypes";

/** One displayed R or R+IR row, with the path Native attached to it. */
export interface Nir1GraphBaseRow {
  readonly kind: "base";
  readonly sceneId: string;
  readonly sceneTitle: string;
  /** Absent for a Raw-only result (the row shows its score instead). */
  readonly rank?: number;
  readonly raw?: RelatedScene;
  readonly ir?: Nir1AdmittedScene;
  readonly path: RelatedScenesGraphPathAttachment | null;
}

/** The one common additional slot, filled by a Graph-only target. */
export interface Nir1GraphOnlyDisplayRow {
  readonly kind: "graph-only";
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly rank: number;
  readonly graphOnly: RelatedScenesGraphOnlyRow;
}

export type Nir1GraphDisplayRow = Nir1GraphBaseRow | Nir1GraphOnlyDisplayRow;

export interface Nir1GraphFusion {
  readonly rows: readonly Nir1GraphDisplayRow[];
  /**
   * Counts only (no text, no ID): the path attachments the renderer's checks
   * discarded. A discarded Graph-only row is not counted: whether an Eligible
   * candidate existed must not reach any diagnostic (K2/4 MD2, MD9; DR-CP3B-4).
   */
  readonly dropped: {
    readonly attachments: number;
  };
}

export interface Nir1GraphFusionInput {
  /** The R or R+IR result. Never changed (the harness and P read it). */
  readonly result: Nir1RelatedScenesResult;
  readonly queryBinding: string | null;
  readonly querySceneId: string | null;
  readonly graphOutcome?: Nir1GraphJoinOutcome;
  readonly graph?: Nir1RelatedScenesGraphPayload;
}

function baseRows(result: Nir1RelatedScenesResult): Nir1GraphBaseRow[] {
  if (result.kind === "raw")
    return result.scenes.map((raw) => ({
      kind: "base",
      sceneId: raw.sceneId,
      sceneTitle: raw.sceneTitle,
      raw,
      path: null,
    }));
  return result.scenes.map((scene) => ({
    kind: "base",
    sceneId: scene.sceneId,
    sceneTitle: scene.sceneTitle,
    rank: scene.rank1,
    raw: scene.kind !== "ir" ? scene.raw : undefined,
    ir: scene.kind !== "raw" ? scene.ir : undefined,
    path: null,
  }));
}

/** The common additional slot is open only when IR did not use it and R < 8. */
function slotOpen(result: Nir1RelatedScenesResult): boolean {
  if (result.kind === "fused" && result.scenes.some((s) => s.kind === "ir"))
    return false;
  const rawCount =
    result.kind === "raw"
      ? result.scenes.length
      : result.scenes.filter((s) => s.kind !== "ir").length;
  return (
    rankingPolicy.fusion.maxAdditionalScenes >= 1 &&
    rawCount < rankingPolicy.fusion.maxScenes
  );
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function edgesWellFormed(edges: unknown): boolean {
  return Array.isArray(edges) && edges.length > 0;
}

function graphOnlyWellFormed(
  row: RelatedScenesGraphOnlyRow,
  querySceneId: string | null,
): boolean {
  const range = row.canonicalRange;
  const last = row.path?.edges?.[row.path.edges.length - 1];
  return (
    nonEmptyString(row.sceneId) &&
    row.sceneId !== querySceneId &&
    typeof row.sceneTitle === "string" &&
    nonEmptyString(row.excerpt) &&
    !/[\r\n]/.test(row.excerpt) &&
    nonEmptyString(row.navigationIdentity) &&
    Number.isSafeInteger(range?.start) &&
    Number.isSafeInteger(range?.end) &&
    range.start >= 0 &&
    range.start < range.end &&
    range.end - range.start === row.excerpt.length &&
    edgesWellFormed(row.path?.edges) &&
    last !== undefined &&
    nonEmptyString(row.path.pinEntityId) &&
    (last.from?.entityId === row.path.pinEntityId ||
      last.to?.entityId === row.path.pinEntityId)
  );
}

/**
 * Display rows of a Related Scenes query with its `graph-ready` Graph (CP-3b,
 * DR-CP3B-4). Pure and DOM-free so CP-4's R+IR+Graph arm can call it.
 *
 * The R/R+IR rows keep their membership, order, rank and excerpt; Native's path
 * is attached to them, and the one Graph-only target is appended last (rank
 * n+1) when IR did not use the common slot and R has fewer than 8 Scenes. The
 * renderer copies Native's decision and never synthesizes a row. A mismatch
 * narrows the display: a bad attachment drops the whole Graph contribution
 * (Native would not have reached the Graph-only step), a bad Graph-only row
 * drops that row only.
 */
export function fuseNir1RelatedScenesGraph(
  input: Nir1GraphFusionInput,
): Nir1GraphFusion {
  const rows = baseRows(input.result);
  const graph = input.graph;
  if (input.graphOutcome !== "graph-ready" || !graph)
    return { rows, dropped: { attachments: 0 } };
  const attachments = Array.isArray(graph.pathAttachments)
    ? graph.pathAttachments
    : [];
  const dropAll = { rows, dropped: { attachments: attachments.length } };
  if (
    !Array.isArray(graph.pathAttachments) ||
    !nonEmptyString(graph.queryBinding) ||
    graph.queryBinding !== input.queryBinding
  )
    return dropAll;
  const index = new Map(rows.map((row, at) => [row.sceneId, at]));
  const attached = new Map<string, RelatedScenesGraphPathAttachment>();
  for (const attachment of attachments) {
    if (
      !index.has(attachment?.sceneId) ||
      attached.has(attachment.sceneId) ||
      !edgesWellFormed(attachment.edges)
    )
      return dropAll;
    attached.set(attachment.sceneId, attachment);
  }
  const fused: Nir1GraphDisplayRow[] = rows.map((row) => ({
    ...row,
    path: attached.get(row.sceneId) ?? null,
  }));
  const graphOnly = graph.graphOnly;
  if (graphOnly) {
    if (
      slotOpen(input.result) &&
      !index.has(graphOnly.sceneId) &&
      graphOnlyWellFormed(graphOnly, input.querySceneId)
    )
      fused.push({
        kind: "graph-only",
        sceneId: graphOnly.sceneId,
        sceneTitle: graphOnly.sceneTitle,
        rank: rows.length + 1,
        graphOnly,
      });
    // Otherwise the row is dropped silently (no counter, see `dropped`).
  }
  return { rows: fused, dropped: { attachments: 0 } };
}
