/**
 * Reads the rows `buildReadInputs` needs, through the Drizzle db of the read core
 * (Mastra migration MP-4b PR-6, DR-MP4-8). The db is a `CoreReadDb`: main
 * passes `createCoreReadDb(checkedClient)` (`readDb.ts`), a test its own
 * capture. Nothing calls this module yet.
 *
 * Two selects, in the shapes the pre-send check (`mastraRead/sql.ts`) accepts:
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
import {
  buildReadInputs,
  type ReadInputProjectRow,
  type ReadInputs,
  type ReadInputTreeRow,
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
): Promise<ReadInputTreeRow[]> {
  assertCoreProjectId(projectId);
  return db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      nodeType: treeNodes.nodeType,
      sortOrder: treeNodes.sortOrder,
      storyTimeOrder: treeNodes.storyTimeOrder,
      archivedAt: treeNodes.archivedAt,
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
