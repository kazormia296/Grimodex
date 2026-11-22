import { and, eq, isNull } from "drizzle-orm";

import type { CoreReadContext } from "../../mastraRead/ports.js";
import { foreshadows, foreshadowSetups, treeNodes } from "../db/schema.js";
import { openForeshadowsFromWire } from "../features/foreshadow/readRows.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * The foreshadow tools of the shared core (Mastra migration MP-4b, PR-5b):
 * `list_open_foreshadows` and `get_foreshadow_detail`. The SQL, the order of the
 * statements, the strings and the key order of every result are those of the
 * renderer's executors they were moved from (the PR-0 golden fixes them).
 *
 * Each tool checks its arguments first (an empty id is answered before the
 * project is looked at), then takes the project once (`requireCoreProjectId`),
 * then reads. The renderer's thin layer turns the empty-project throw back into
 * its `No active project` result.
 *
 * The two tools are not alike in what they may show (DR-MP4-24):
 * `list_open_foreshadows` never shows a secret foreshadow (the read that
 * fetches the list leaves it out), while `get_foreshadow_detail` answers any
 * foreshadow of the project by id, secret ones and their `notes` included.
 * That asymmetry is moved as it is. It is not decided here; C-11 is its own
 * issue.
 */

/**
 * The open foreshadows of the project. The list is fetched by `native.foreshadowOpen`
 * (Native's `foreshadow_list_open_for_context`, whose SQL has the `secret = 0`,
 * unpaid and not-abandoned conditions; the renderer's in-browser branch has the
 * same) and built here from its wire. The wire has no secret column, so this
 * cannot filter it again: a secret foreshadow that the read returned would be
 * shown, and `mastraReadParity.pipeline.spec.ts` fixes that Native leaves it out.
 */
export async function listOpenForeshadows(
  ctx: CoreReadContext,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const rows = openForeshadowsFromWire(
    await ctx.native.foreshadowOpen({ projectId }),
  );
  const content = rows.map((r) => ({
    id: r.id,
    title: r.title,
    intent: r.intent ?? "",
    loadBearing: r.loadBearing,
    setupCount: r.setupCount,
  }));
  const json = JSON.stringify(content);
  return {
    name: "list_open_foreshadows",
    content,
    summary: `${content.length} open foreshadowing items`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function getForeshadowDetail(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const id = String(params["id"] ?? "").trim();
  if (!id) {
    return {
      name: "get_foreshadow_detail",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    };
  }

  // XPROJ defense: scope the read-by-id to the active project. Without this,
  // an injected agent could pass another project's foreshadow UUID and read its
  // (secret) plot intent/notes/setups. This is the only project condition of
  // the tool: the setups and the payoff scene below are reached from a
  // foreshadow that is already the project's.
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const [fs] = await db
    .select()
    .from(foreshadows)
    .where(and(eq(foreshadows.id, id), eq(foreshadows.projectId, projectId)));
  if (!fs) {
    return {
      name: "get_foreshadow_detail",
      content: null,
      summary: "Foreshadow not found",
      tokensUsed: 0,
    };
  }

  // Setups + scene title (innerJoin); an orphan is a field of its own. A setup on
  // an archived scene (archived automatically when an external Markdown file
  // disappears or is duplicated) is left out, like the links of get_thread_scenes:
  // its scene id is not handed to the model, which would only get "Scene not
  // found" from get_scene. The count in the summary is the count after that.
  const setupRows = await db
    .select({
      sceneId: foreshadowSetups.sceneId,
      kind: foreshadowSetups.kind,
      strength: foreshadowSetups.strength,
      aiStrength: foreshadowSetups.aiStrength,
      attribution: foreshadowSetups.attribution,
      aiRationale: foreshadowSetups.aiRationale,
      isOrphan: foreshadowSetups.isOrphan,
      sceneTitle: treeNodes.title,
    })
    .from(foreshadowSetups)
    .innerJoin(treeNodes, eq(foreshadowSetups.sceneId, treeNodes.id))
    .where(
      and(eq(foreshadowSetups.foreshadowId, id), isNull(treeNodes.archivedAt)),
    );

  // The title of the payoff scene (null when there is no `payoffSceneId`). A payoff
  // scene that is archived is null, the same as when there is no row: its id is not
  // handed to the model either (see the setups above). The summary below follows it
  // (planned -> unset), and `payoffConfirmed` is left as it is.
  let payoffScene: { id: string; title: string } | null = null;
  if (fs.payoffSceneId) {
    const [row] = await db
      .select({ id: treeNodes.id, title: treeNodes.title })
      .from(treeNodes)
      .where(
        and(eq(treeNodes.id, fs.payoffSceneId), isNull(treeNodes.archivedAt)),
      );
    if (row) payoffScene = { id: row.id, title: row.title };
  }

  const content = {
    id: fs.id,
    title: fs.title,
    intent: fs.intent ?? "",
    notes: fs.notes ?? "",
    loadBearing: fs.loadBearing,
    payoffConfirmed: fs.payoffConfirmed,
    abandoned: fs.abandoned,
    payoffScene,
    setups: setupRows.map((s) => ({
      sceneId: s.sceneId,
      sceneTitle: s.sceneTitle,
      kind: s.kind,
      // Show the AI's rating when there is no human one (a reference value).
      strength: s.strength ?? s.aiStrength ?? null,
      attribution: s.attribution,
      aiRationale: s.aiRationale ?? "",
      isOrphan: s.isOrphan,
    })),
  };
  const json = JSON.stringify(content);
  return {
    name: "get_foreshadow_detail",
    content,
    summary: `${fs.title}: ${setupRows.length} setup(s), payoff ${
      fs.payoffConfirmed ? "confirmed" : payoffScene ? "planned" : "unset"
    }`,
    tokensUsed: ctx.countTokens(json),
  };
}
