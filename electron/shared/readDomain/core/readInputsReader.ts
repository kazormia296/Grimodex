/**
 * Reads the rows `buildReadInputs` needs, through the Drizzle db of the read core
 * (Mastra migration MP-4b PR-6, DR-MP4-8). The db is a `CoreReadDb`: main
 * passes `createCoreReadDb(checkedClient)` (`readDb.ts`), a test its own
 * capture. Nothing calls this module yet.
 *
 * Two selects (PR-7a: the tree select also carries the scene title and the
 * chronicle date columns, so that the chronicle tools' nodes and the reading
 * order come from one statement), in the shapes the pre-send check (`mastraRead/sql.ts`) accepts:
 * awaited as arrays (no `.get()`), no `$with`, no `findFirst`. They name two
 * tables, `tree_nodes` and `projects`, both in `MAIN_READ_TABLES`.
 *
 * They are two statements and not one snapshot. A write between them can make
 * the tree and the mode come from different moments. Both are read at the
 * start of a turn and then held (DR-MP4-8; Q5 (5)).
 */
import { and, eq, isNull } from "drizzle-orm";

import { projects, treeNodes } from "../db/schema.js";
import {
  assertCoreProjectId,
  type CoreReadDb,
} from "../../mastraRead/ports.js";
import type { CoreTreeNode } from "../../mastraRead/ports.js";
import {
  buildChronicleNodes,
  buildReadInputs,
  type ReadChronicleTreeRow,
  type ReadInputProjectRow,
  type ReadInputs,
} from "./readInputs.js";

/**
 * The live tree rows of one project: `project_id` equal and `archived_at IS
 * NULL`, the same condition as the renderer's `listNodes`
 * (`src/features/tree/api.ts`). An empty project id throws before anything is
 * sent (it would drop the project condition).
 */
export async function readTreeRows(
  db: CoreReadDb,
  projectId: string,
): Promise<ReadChronicleTreeRow[]> {
  assertCoreProjectId(projectId);
  return db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      nodeType: treeNodes.nodeType,
      sortOrder: treeNodes.sortOrder,
      storyTimeOrder: treeNodes.storyTimeOrder,
      archivedAt: treeNodes.archivedAt,
      title: treeNodes.title,
      chronicleStartTime: treeNodes.chronicleStartTime,
      chronicleStartMinute: treeNodes.chronicleStartMinute,
      chronicleStartGranularity: treeNodes.chronicleStartGranularity,
      chroniclePrecision: treeNodes.chroniclePrecision,
    })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), isNull(treeNodes.archivedAt)),
    );
}

/** The row of the project, or null when there is none. The column is returned raw. */
export async function readProjectModeRow(
  db: CoreReadDb,
  projectId: string,
): Promise<ReadInputProjectRow> {
  assertCoreProjectId(projectId);
  const rows = await db
    .select({ phaseResolutionMode: projects.phaseResolutionMode })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows.length === 0
    ? null
    : { phaseResolutionMode: rows[0]!.phaseResolutionMode };
}

export interface ReadReadInputsArgs {
  readonly projectId: string;
  /** The wire's `currentSceneId`; not trusted (see `ReadInputs.currentSceneId`). */
  readonly currentSceneId: string | null | undefined;
}

/**
 * The inputs of a turn of the chronicle tools: the read inputs and the tree
 * nodes (title and chronicle date included), both built from the rows of the one
 * tree select (the same moment). The mode row is the second statement, as for
 * `readReadInputs`.
 */
export interface ChronicleReadInputs {
  readonly inputs: ReadInputs;
  readonly nodes: CoreTreeNode[];
}

export async function readChronicleReadInputs(
  db: CoreReadDb,
  args: ReadReadInputsArgs,
): Promise<ChronicleReadInputs> {
  const treeRows = await readTreeRows(db, args.projectId);
  const project = await readProjectModeRow(db, args.projectId);
  return {
    inputs: buildReadInputs({
      projectId: args.projectId,
      treeRows,
      project,
      currentSceneId: args.currentSceneId,
    }),
    nodes: buildChronicleNodes(treeRows),
  };
}

export async function readReadInputs(
  db: CoreReadDb,
  args: ReadReadInputsArgs,
): Promise<ReadInputs> {
  const treeRows = await readTreeRows(db, args.projectId);
  const project = await readProjectModeRow(db, args.projectId);
  return buildReadInputs({
    projectId: args.projectId,
    treeRows,
    project,
    currentSceneId: args.currentSceneId,
  });
}
