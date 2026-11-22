/**
 * The inputs of the read tools that decide what the AI may see before a tool
 * result is made: the reading order, the scene time index and the phase
 * resolution mode, rebuilt from database rows (Mastra migration MP-4b PR-6,
 * DR-MP4-8). Pure: rows in, values out. `readInputsReader.ts` reads the rows.
 * Nothing calls this module yet.
 *
 * The renderer's own functions do the work (`buildSceneTimeIndex`, which calls
 * `buildReadingOrder`), unchanged. The rows are only written into the shape
 * those functions take. The Rust `derive_live_scene_projection` is not used:
 * it disagrees with them in 7 of 11 measured cases (K-4).
 *
 * This file imports no store, no `invoke`, no `@/` path and nothing about the
 * chat IR. Relative `.js` imports only, so it can be compiled for Electron main
 * (NodeNext) and still be reached from the renderer.
 */
import {
  buildSceneTimeIndex,
  type PhaseResolutionMode,
  type SceneTimeIndex,
} from "../features/codex/context/sceneTimeIndex.js";
import type { NodeType, TreeNodeData } from "../features/tree/types.js";

/**
 * The six `tree_nodes` columns the two renderer functions read, and nothing
 * else. `project_id` is not one of them: the project condition is in the SQL
 * (`readInputsReader.ts`), because a row of another project must never reach
 * this function.
 */
export interface ReadInputTreeRow {
  readonly id: string;
  readonly parentId: string | null;
  /** `folder`, `scene` or `note` in the database; anything else is ignored by the builders. */
  readonly nodeType: string;
  readonly sortOrder: string;
  readonly storyTimeOrder: string | null;
  /** The reader selects `archived_at IS NULL`; a row that still carries one is dropped by the builders too. */
  readonly archivedAt: string | null;
}

/** The modes `projects.phase_resolution_mode` may hold (`CHECK` in `migrate.rs`). */
export const READ_INPUT_PHASE_MODES: readonly PhaseResolutionMode[] =
  Object.freeze(["reading", "story", "auto"]);

/**
 * The mode is a value or an explicit "could not be resolved". There is no
 * default here: a caller that reads `resolved` gets a mode the database holds,
 * and a caller that gets `unresolved` has to treat it as unknown, which
 * DR-MP4-8 says hides (fail closed). Nothing here turns it into `reading` or
 * `auto`. How "hides" is carried out on the Codex side (and which anchor it
 * means) is PR-8's, with a fixture; this module only makes the case impossible
 * to miss.
 */
export type ReadInputMode =
  | { readonly kind: "resolved"; readonly mode: PhaseResolutionMode }
  | {
      readonly kind: "unresolved";
      /**
       * `project-missing`: there is no row for the project (or none was read).
       * `mode-null`: the column is null or absent. `mode-unknown`: any other
       * value, empty text included.
       */
      readonly reason: "project-missing" | "mode-null" | "mode-unknown";
    };

/** What a `projects` select gave: no row, or the raw `phase_resolution_mode`. */
export type ReadInputProjectRow = {
  readonly phaseResolutionMode: unknown;
} | null;

export function resolveReadInputMode(
  project: ReadInputProjectRow,
): ReadInputMode {
  if (project === null || project === undefined) {
    return { kind: "unresolved", reason: "project-missing" };
  }
  const value = project.phaseResolutionMode;
  if (value === null || value === undefined) {
    return { kind: "unresolved", reason: "mode-null" };
  }
  for (const mode of READ_INPUT_PHASE_MODES) {
    if (value === mode) return { kind: "resolved", mode };
  }
  return { kind: "unresolved", reason: "mode-unknown" };
}

export interface ReadInputs {
  readonly projectId: string;
  /**
   * Built with revision 0. The revision is the renderer store's invalidation
   * counter and has no meaning for a value rebuilt at the start of a turn.
   */
  readonly sceneTimeIndex: SceneTimeIndex;
  /** The same map as `sceneTimeIndex.readingOrder` (`computeGlobalSceneOrder` is `buildReadingOrder`). */
  readonly readingOrder: ReadonlyMap<string, number>;
  readonly resolutionMode: ReadInputMode;
  /**
   * The wire's current scene, or null when it is not a live scene of this
   * project's reading order: empty, another project's id, a nonexistent id, an
   * archived scene, a folder or a note, or a live scene whose ancestor is
   * archived (it is not in the reading order either). Null makes the chronicle
   * hide secret events (`isEventHiddenFromAi` fails closed on a scene that is
   * not in the order). The Codex side's reading of null is DR-MP4-1; whether it
   * equals a scene id that is not found is K-20 (1) and is not claimed here.
   */
  readonly currentSceneId: string | null;
}

export interface BuildReadInputsArgs {
  readonly projectId: string;
  /** The live rows of this project. Their order does not matter. */
  readonly treeRows: readonly ReadInputTreeRow[];
  readonly project: ReadInputProjectRow;
  readonly currentSceneId: string | null | undefined;
}

/** Writes a row into the shape `buildSceneTimeIndex` takes. The fields it does not read are neutral. */
function toTreeNodeData(
  projectId: string,
  row: ReadInputTreeRow,
): TreeNodeData {
  return {
    id: row.id,
    projectId,
    parentId: row.parentId,
    // Not narrowed: only `scene` and `folder` are acted on, and a value of
    // another kind is skipped by the builders, as in the renderer.
    nodeType: row.nodeType as NodeType,
    title: "",
    synopsis: null,
    intent: null,
    sortOrder: row.sortOrder,
    status: null,
    storyTimeOrder: row.storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    archivedAt: row.archivedAt,
    createdAt: "",
    updatedAt: "",
  };
}

/** The current scene when it is in the reading order, else null. */
export function normalizeCurrentSceneId(
  readingOrder: ReadonlyMap<string, number>,
  currentSceneId: unknown,
): string | null {
  if (typeof currentSceneId !== "string" || currentSceneId === "") return null;
  return readingOrder.has(currentSceneId) ? currentSceneId : null;
}

export function buildReadInputs(args: BuildReadInputsArgs): ReadInputs {
  const nodes = args.treeRows.map((row) => toTreeNodeData(args.projectId, row));
  const sceneTimeIndex = buildSceneTimeIndex(nodes, 0);
  return {
    projectId: args.projectId,
    sceneTimeIndex,
    readingOrder: sceneTimeIndex.readingOrder,
    resolutionMode: resolveReadInputMode(args.project),
    currentSceneId: normalizeCurrentSceneId(
      sceneTimeIndex.readingOrder,
      args.currentSceneId,
    ),
  };
}
