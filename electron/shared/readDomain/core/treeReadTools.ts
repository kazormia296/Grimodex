import { and, eq, inArray, isNull } from "drizzle-orm";

import type { CoreReadContext } from "../../mastraRead/ports.js";
import { treeNodes } from "../db/schema.js";
import { cmpKeys } from "../features/tree/fractionalIndex.js";
import { orderNodesInReadingOrder } from "../features/tree/treeReadingOrder.js";
import { prosemirrorToText } from "../lib/prosemirror.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * The tree and scene read tools of the shared core (Mastra migration MP-4b,
 * PR-4): `list_chapters`, `get_chapter_summaries`,
 * `get_scene_timeline_neighbors` and `get_scene`. The SQL, the order of the
 * statements, the strings and the key order of every result are those of the
 * renderer's executors they were moved from (the PR-0 golden fixes them).
 *
 * Each tool checks its own parameters first, then takes the project once
 * (`requireCoreProjectId`), then reads. The renderer's thin layer turns the
 * empty-project throw back into its `No active project` result.
 */

export async function listChapters(
  ctx: CoreReadContext,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();
  const nodes = await db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      nodeType: treeNodes.nodeType,
      title: treeNodes.title,
      status: treeNodes.status,
      sortOrder: treeNodes.sortOrder,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        inArray(treeNodes.nodeType, ["folder", "scene"]),
        // 外部 Markdown のファイル消失・重複で自動の soft delete になった行は読ませない。
        // 祖先だけが archived の行は listNodes と同じく残る（root から届かない行として末尾に並ぶ）。
        isNull(treeNodes.archivedAt),
      ),
    );

  // tree の読む順（DFS。兄弟ごとの sortOrder）。全体を 1 回の sortOrder で並べない。
  const content = orderNodesInReadingOrder(nodes).map(({ node: n }) => ({
    id: n.id,
    parentId: n.parentId ?? null,
    nodeType: n.nodeType,
    title: n.title,
    status: n.status ?? "outline",
  }));
  const json = JSON.stringify(content);
  return {
    name: "list_chapters",
    content,
    summary: `${content.length} nodes (parts/chapters/scenes)`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function getChapterSummaries(
  ctx: CoreReadContext,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();
  // 現行 schema の node_type は folder／scene／note だけ。folder を章として扱う
  // （MCP の get_chapter_summaries と同じ形）。全階層の folder を tree の読む順（DFS）に並べる。
  const rows = await db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      nodeType: treeNodes.nodeType,
      title: treeNodes.title,
      synopsis: treeNodes.synopsis,
      sortOrder: treeNodes.sortOrder,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        inArray(treeNodes.nodeType, ["folder", "scene"]),
        // 自動 soft delete（外部ファイルの消失・重複）の行は除く。listNodes と同じ行単位の規則。
        isNull(treeNodes.archivedAt),
      ),
    );

  const ordered = orderNodesInReadingOrder(rows).map(({ node }) => node);
  const chapters = ordered.filter((n) => n.nodeType === "folder");
  const scenesByParent = new Map<string, typeof ordered>();
  for (const n of ordered) {
    if (n.nodeType !== "scene" || n.parentId === null) continue;
    if ((n.synopsis ?? "").trim() === "") continue;
    const siblings = scenesByParent.get(n.parentId) ?? [];
    siblings.push(n);
    scenesByParent.set(n.parentId, siblings);
  }

  const content = chapters.map((ch) => ({
    id: ch.id,
    title: ch.title,
    scenes: (scenesByParent.get(ch.id) ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      synopsis: s.synopsis ?? "",
    })),
  }));

  const json = JSON.stringify(content);
  return {
    name: "get_chapter_summaries",
    content,
    summary: `${chapters.length} chapters with scene summaries`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function getSceneTimelineNeighbors(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const sceneId = String(params["sceneId"] ?? "").trim();
  if (!sceneId) {
    return {
      name: "get_scene_timeline_neighbors",
      content: { previous: [], next: [], currentSceneStoryTimeLabel: null },
      summary: "No sceneId provided",
      tokensUsed: 0,
    };
  }

  // XPROJ defense: scope the target lookup to the active project. The neighbor
  // query below already filters by project, but an unscoped target lookup let a
  // foreign sceneId read another project's storyTimeLabel + neighbor titles.
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const [target] = await db
    .select({
      id: treeNodes.id,
      projectId: treeNodes.projectId,
      storyTimeOrder: treeNodes.storyTimeOrder,
      storyTimeLabel: treeNodes.storyTimeLabel,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.id, sceneId),
        eq(treeNodes.projectId, projectId),
        isNull(treeNodes.archivedAt),
      ),
    );

  if (!target || !target.storyTimeOrder) {
    return {
      name: "get_scene_timeline_neighbors",
      content: {
        previous: [],
        next: [],
        currentSceneStoryTimeLabel: target?.storyTimeLabel ?? null,
      },
      summary: target
        ? "Target scene has no storyTimeOrder set"
        : "Scene not found",
      tokensUsed: 0,
    };
  }

  // 同 project 内の story-time キーを持つシーンだけ拾い、JS で fractional-index 比較。
  // SQL の文字列順は base62 fractional key と一致するため、order by + limit が
  // 使えるが、cmpKeys との挙動差分を避けるため全件読み JS でソート分割する
  // (シーン数 << 数千件と想定)。
  const candidates = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      synopsis: treeNodes.synopsis,
      storyTimeOrder: treeNodes.storyTimeOrder,
      storyTimeLabel: treeNodes.storyTimeLabel,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, target.projectId),
        eq(treeNodes.nodeType, "scene"),
        isNull(treeNodes.archivedAt),
      ),
    );

  const targetKey = target.storyTimeOrder;
  const previous = candidates
    .filter(
      (n) =>
        n.id !== sceneId &&
        n.storyTimeOrder != null &&
        cmpKeys(n.storyTimeOrder, targetKey) < 0,
    )
    .sort((a, b) =>
      cmpKeys(b.storyTimeOrder as string, a.storyTimeOrder as string),
    )
    .slice(0, 3)
    .map((n) => ({
      id: n.id,
      title: n.title,
      storyTimeLabel: n.storyTimeLabel ?? null,
      synopsis: n.synopsis ?? "",
    }));
  const next = candidates
    .filter(
      (n) =>
        n.id !== sceneId &&
        n.storyTimeOrder != null &&
        cmpKeys(n.storyTimeOrder, targetKey) > 0,
    )
    .sort((a, b) =>
      cmpKeys(a.storyTimeOrder as string, b.storyTimeOrder as string),
    )
    .slice(0, 3)
    .map((n) => ({
      id: n.id,
      title: n.title,
      storyTimeLabel: n.storyTimeLabel ?? null,
      synopsis: n.synopsis ?? "",
    }));

  const content = {
    currentSceneStoryTimeLabel: target.storyTimeLabel ?? null,
    previous,
    next,
  };
  const json = JSON.stringify(content);
  return {
    name: "get_scene_timeline_neighbors",
    content,
    summary: `previous: ${previous.length}, next: ${next.length}`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function getScene(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const id = String(params["id"] ?? "").trim();
  if (!id)
    return {
      name: "get_scene",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const [node] = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      nodeType: treeNodes.nodeType,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.id, id),
        eq(treeNodes.projectId, projectId),
        isNull(treeNodes.archivedAt),
      ),
    );

  if (!node || node.nodeType !== "scene") {
    return {
      name: "get_scene",
      content: null,
      summary: "Scene not found",
      tokensUsed: 0,
    };
  }

  const rawContent = await ctx.body.readSceneBody(id);
  const markdown = prosemirrorToText(rawContent);
  const content = { id, title: node.title, content: markdown };
  const json = JSON.stringify(content);
  return {
    name: "get_scene",
    content,
    summary: `Scene '${node.title}' (${markdown.length} chars)`,
    tokensUsed: ctx.countTokens(json),
  };
}
