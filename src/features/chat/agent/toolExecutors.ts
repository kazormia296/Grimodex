import { invoke } from "@/lib/tauri";
import { loadSceneContent, loadSceneContents } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { tokenizeFtsQuery as tokenizeQuery, codepointLength } from "@/lib/fts";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { db } from "@/db/client";
import {
  codexEntries,
  codexEntryTags,
  codexTags,
  codexDetailDefinitions,
  codexDetailValues,
  snippets,
  treeNodes,
  foreshadows,
  foreshadowSetups,
  plotThreads,
  plotThreadSceneLinks,
  plotThreadBranches,
  PLOT_PHASE_TYPES,
  type PlotPhaseType,
} from "@/db/schema";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  like,
  ne,
  or,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { countTokens } from "../contextBuilder";
import { useTreeStore } from "@/features/tree/treeStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { listOpenForeshadowsForContext } from "@/features/foreshadow/api";
import type { ToolResult } from "./agentTypes";
import {
  agentCreateCodexEntry,
  agentUpdateCodexEntry,
} from "@/features/agent-writes/codex";
import { agentCreateSnippet } from "@/features/agent-writes/snippet";
import { agentMarkdownToProseMirrorJson } from "@/features/agent-writes/richTextInput";
import {
  agentCreateForeshadow,
  agentUpdateForeshadow,
  type AgentForeshadowLoadBearing,
} from "@/features/agent-writes/foreshadow";
import {
  listEventsTool,
  getEventDetailTool,
  getCharacterTimelineTool,
  getChronicleStateTool,
} from "./chronicleReadTools";
import {
  createEventTool,
  updateEventTool,
  deleteEventTool,
  stampSceneEventTool,
  unstampSceneEventTool,
  setEventParticipantsTool,
  addEventRelationTool,
  removeEventRelationTool,
} from "./chronicleWriteTools";
import { agentApplyTreePlan } from "@/features/agent-writes/tree";
import { agentProposeSceneBody } from "@/features/agent-writes/prose";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";
import type { AiTreePlan } from "@/features/tree/aiScaffold/types";
import {
  codexSemanticSearch,
  type CodexSearchHit,
  eventsSemanticSearch,
  type EventSearchHit,
} from "@/features/semantic-search/api";
import { fuseCodexHybrid, type CodexHybridResult } from "./codexHybridSearch";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { isEventHiddenFromAi } from "@/features/chronicle/chronicleSecrecy";
import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedReadingOrder,
  invalidateChronicleToolCache,
} from "./chronicleToolCache";

interface SparseSearchHit {
  sourceType: string;
  id: string;
}

/**
 * codex_entries.tags_cache の JSON を tag 名の string[] に展開する。
 * 実態は `[{"name":"tag1","color":null}, ...]` という object 配列だが、
 * 旧スキーマ comment 通りの `["tag1", "tag2"]` 形式のレコードもあり得るため
 * 両形式を許容する。詳細は chatStore.ts の `parseTags` も参照。
 */
function parseTagsCacheNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((v): string | undefined => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "name" in v) {
          const name = (v as { name: unknown }).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

const EXCERPT_MAX_CHARS = 200;

/**
 * ProseMirror JSON 本文から plain text の抜粋を作る。tree_nodes.content /
 * snippets.content は生 JSON なので、SQL 側の snippet()/SUBSTR では構造 JSON が
 * そのまま LLM に渡ってしまう（get_scene の prosemirrorToText と非対称だった）。
 * 最初に一致した検索トークンを中心に切り出し、切断した側へ "..." を付ける。
 * どのトークンも本文に無い場合は先頭からの抜粋になる。
 */
function plainTextExcerpt(content: unknown, tokens: string[]): string {
  const raw = typeof content === "string" ? content : "";
  if (!raw) return "";
  const plain = prosemirrorToText(raw).replace(/\s+/g, " ").trim();
  if (plain.length <= EXCERPT_MAX_CHARS) return plain;
  let hit = -1;
  for (const t of tokens) {
    const idx = plain.indexOf(t);
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
  }
  const start =
    hit < 0 ? 0 : Math.max(0, hit - Math.floor(EXCERPT_MAX_CHARS / 2));
  const end = Math.min(plain.length, start + EXCERPT_MAX_CHARS);
  return (
    (start > 0 ? "..." : "") +
    plain.slice(start, end) +
    (end < plain.length ? "..." : "")
  );
}

/**
 * トークン群と LIKE 対象列に対し
 * `(col1 LIKE ? OR col2 LIKE ? OR ...) OR (col1 LIKE ? OR ...) OR ...`
 * 形の WHERE 断片と束縛パラメータ配列を組み立てる。
 * trigram で扱えない短いトークンが混じっている場合のフォールバックに使う。
 */
function buildLikeOrCondition(tokens: string[], columns: AnyColumn[]): SQL {
  const condition = or(
    ...tokens.flatMap((token) =>
      columns.map((column) => like(column, `%${token}%`)),
    ),
  );
  if (!condition) {
    throw new Error("search requires at least one token and column");
  }
  return condition;
}

async function sparseSearchIds(
  projectId: string,
  query: string,
  scope: "codex" | "scenes" | "snippets",
  limit: number,
): Promise<string[]> {
  const rows = await invoke<SparseSearchHit[]>("fts_search", {
    projectId,
    query,
    scope,
    limit,
  });
  const sourceType =
    scope === "scenes" ? "scene" : scope === "snippets" ? "snippet" : "codex";
  return rows
    .filter((row) => row.sourceType === sourceType)
    .map((row) => row.id);
}

function orderByIds<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

// ---------------------------------------------------------------------------
// Codex tools
// ---------------------------------------------------------------------------

async function searchCodex(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_codex",
      content: [],
      summary: "0 entries found",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "search_codex",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  // codex_fts は trigram tokenizer なので 3 codepoint 未満のトークンは
  // FTS で match できない。短いトークンが 1 つでも混じっていたら
  // LIKE-OR fallback に倒す。Agent が日本語の 2-3 文字語を渡す前提では
  // この経路が事実上のメインになる。
  const tokens = tokenizeQuery(query);
  const allTrigramFriendly =
    tokens.length > 0 && tokens.every((t) => codepointLength(t) >= 3);

  let rows: Array<{
    id: string;
    name: string;
    type: string;
    summary: string | null;
  }>;
  if (allTrigramFriendly) {
    const hitIds = await sparseSearchIds(projectId, query, "codex", 20);
    if (hitIds.length === 0) {
      rows = [];
    } else {
      rows = orderByIds(
        await db
          .select({
            id: codexEntries.id,
            name: codexEntries.name,
            type: codexEntries.type,
            summary: codexEntries.summary,
          })
          .from(codexEntries)
          .where(
            and(
              eq(codexEntries.projectId, projectId),
              inArray(codexEntries.id, hitIds),
            ),
          ),
        hitIds,
      );
    }
  } else {
    // `content` (ProseMirror body) is matched too so short (1-2 codepoint)
    // tokens — the LIKE-fallback case, common for Japanese — can hit body text,
    // not just metadata. The FTS path already covers content via codex_fts.
    rows = await db
      .select({
        id: codexEntries.id,
        name: codexEntries.name,
        type: codexEntries.type,
        summary: codexEntries.summary,
      })
      .from(codexEntries)
      .where(
        and(
          eq(codexEntries.projectId, projectId),
          buildLikeOrCondition(tokens.length > 0 ? tokens : [query], [
            codexEntries.name,
            codexEntries.summary,
            codexEntries.tagsCache,
            codexEntries.aliases,
            codexEntries.content,
          ]),
        ),
      )
      .limit(20);
  }

  const sparse: CodexHybridResult[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    summary: r.summary ?? "",
  }));

  // dense arm (段階3): codex_semantic_search を sparse(FTS/LIKE) と RRF 融合する。
  // feature 無効ビルド / 未 index / モデル不在では reject → sparse 単独へグレース
  // フルに退避 (= 段階1までの挙動)。search ツールなので注入用の precision ゲートは
  // かけず、順位融合した上位 20 件を返す (関連性判断は LLM 側)。
  const dense = await codexSemanticSearch({
    projectId,
    query,
    limit: 30,
  }).catch((e) => {
    debugLog.warn(
      "search_codex",
      "dense codex search failed (sparse-only fallback)",
      errorDetail(e),
    );
    return [] as CodexSearchHit[];
  });

  const content =
    dense.length > 0 ? fuseCodexHybrid(dense, sparse, 20) : sparse;
  const json = JSON.stringify(content);
  return {
    name: "search_codex",
    content,
    summary: `${content.length} entries found`,
    tokensUsed: countTokens(json),
  };
}

/**
 * 作中年表 (Chronicle) 出来事の dense セマンティック検索 (Phase 3)。
 * `events_semantic_search` を叩く dense-only ツール (codex のような FTS 融合なし)。
 * feature 無効ビルド / 未 index / モデル不在では reject → 空配列にグレースフルに退避。
 */
async function searchEvents(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_events",
      content: [],
      summary: "0 events found",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "search_events",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  const rawLimit = Number(params["limit"]);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 30)
      : 10;

  // AI 秘匿: hidden な secret イベントは hit から除外するため over-fetch（≤30=backendMax）→
  // visible filter → slice(limit)。索引自体は全件のまま（title 漏洩を返却段で防ぐ）。
  const fetchLimit = Math.min(limit * 3, 30);
  const hits = await eventsSemanticSearch({
    projectId,
    query,
    limit: fetchLimit,
  }).catch((e) => {
    debugLog.warn(
      "search_events",
      "dense events search failed (empty fallback)",
      errorDetail(e),
    );
    return [] as EventSearchHit[];
  });

  // 現在シーン（activeSceneId）文脈で hidden な event id 集合を算出（spec §2.5）。
  const allEvents = await getSharedEvents(projectId);
  const sceneEvents = await getSharedSceneEvents(projectId);
  const readingOrder = getSharedReadingOrder(useTreeStore.getState().nodes);
  const currentSceneId = useTreeStore.getState().activeSceneId ?? "";
  const hidden = new Set(
    allEvents
      .filter((e) =>
        isEventHiddenFromAi(e, currentSceneId, { readingOrder, sceneEvents }),
      )
      .map((e) => e.id),
  );

  const content = hits
    .filter((h) => !hidden.has(h.eventId))
    .slice(0, limit)
    .map((h) => ({
      eventId: h.eventId,
      title: h.title,
      kind: h.kind,
      score: h.score,
    }));
  const json = JSON.stringify(content);
  return {
    name: "search_events",
    content,
    summary: `${content.length} events found`,
    tokensUsed: countTokens(json),
  };
}

async function listCodexByType(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const type = String(params["type"] ?? "").trim();
  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "list_codex_by_type",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };
  const rows = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      summary: codexEntries.summary,
      tagsCache: codexEntries.tagsCache,
    })
    .from(codexEntries)
    .where(
      and(eq(codexEntries.projectId, projectId), eq(codexEntries.type, type)),
    );

  const content = rows.map((r) => ({
    id: r.id,
    name: r.name,
    summary: r.summary ?? "",
    tags: parseTagsCacheNames(r.tagsCache),
  }));
  const json = JSON.stringify(content);
  return {
    name: "list_codex_by_type",
    content,
    summary: `${content.length} entries of type '${type}'`,
    tokensUsed: countTokens(json),
  };
}

async function getCodexEntry(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id)
    return {
      name: "get_codex_entry",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "get_codex_entry",
      content: null,
      summary: "No active project",
      tokensUsed: 0,
    };

  const [entry] = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  if (!entry)
    return {
      name: "get_codex_entry",
      content: null,
      summary: "Entry not found",
      tokensUsed: 0,
    };

  // Detail definitions for this type
  const defs = await db
    .select()
    .from(codexDetailDefinitions)
    .where(eq(codexDetailDefinitions.typeSlug, entry.type));

  // Detail values for this entry
  const vals = await db
    .select()
    .from(codexDetailValues)
    .where(eq(codexDetailValues.entryId, id));

  const details = defs
    .filter((d) => d.includeInContext)
    .map((d) => {
      const val = vals.find((v) => v.definitionId === d.id);
      return { field: d.name, value: val?.value ?? null };
    });

  // Child entries (summaries only)
  const children = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      summary: codexEntries.summary,
    })
    .from(codexEntries)
    .where(eq(codexEntries.parentId, id));

  // 本体テキスト (ProseMirror JSON → plain text)。Tool description が
  // "full content body" と謳う以上、ここで抜けてはいけない。
  const body = entry.content ? extractPlainText(entry.content) : "";

  const result = {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases ? (JSON.parse(entry.aliases) as string[]) : [],
    summary: entry.summary ?? "",
    body,
    details,
    children: children.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      summary: c.summary ?? "",
    })),
  };
  const json = JSON.stringify(result);
  return {
    name: "get_codex_entry",
    content: result,
    summary: `${entry.name} (${entry.type})`,
    tokensUsed: countTokens(json),
  };
}

async function listCodexTags(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const typeFilter = params["type"] ? String(params["type"]) : undefined;

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "list_codex_tags",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  const usageCount = count(codexEntryTags.entryId);
  const rows = await db
    .select({
      id: codexTags.id,
      name: codexTags.name,
      usageCount,
    })
    .from(codexTags)
    .leftJoin(codexEntryTags, eq(codexTags.id, codexEntryTags.tagId))
    .where(
      and(
        eq(codexTags.projectId, projectId),
        typeFilter
          ? or(
              isNull(codexTags.typeFilter),
              like(codexTags.typeFilter, `%${typeFilter}%`),
            )
          : undefined,
      ),
    )
    .groupBy(codexTags.id)
    .orderBy(desc(usageCount));

  const content = rows.map((row) => ({
    id: row.id,
    name: row.name,
    usageCount: row.usageCount,
  }));
  const json = JSON.stringify(content);
  return {
    name: "list_codex_tags",
    content,
    summary: `${content.length} tags`,
    tokensUsed: countTokens(json),
  };
}

async function searchCodexByTags(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const tags = Array.isArray(params["tags"])
    ? (params["tags"] as unknown[]).map(String)
    : [];
  if (tags.length === 0)
    return {
      name: "search_codex_by_tags",
      content: [],
      summary: "No tags provided",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "search_codex_by_tags",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  const rows = await db
    .selectDistinct({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      summary: codexEntries.summary,
    })
    .from(codexEntries)
    .innerJoin(codexEntryTags, eq(codexEntries.id, codexEntryTags.entryId))
    .innerJoin(codexTags, eq(codexEntryTags.tagId, codexTags.id))
    .where(
      and(eq(codexEntries.projectId, projectId), inArray(codexTags.name, tags)),
    );

  const content = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary ?? "",
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_codex_by_tags",
    content,
    summary: `${content.length} entries found`,
    tokensUsed: countTokens(json),
  };
}

/**
 * 起点エントリの name + aliases を、他エントリの name / summary / aliases /
 * tags_cache に対して LIKE-OR 検索する。"〇〇に関連するエントリ" という
 * Agent の自然な意図に応える関係探索ツール。type で絞り込み可能。
 */
async function findRelatedEntries(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id)
    return {
      name: "find_related_entries",
      content: [],
      summary: "No id provided",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "find_related_entries",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  const [source] = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  if (!source)
    return {
      name: "find_related_entries",
      content: [],
      summary: "Entry not found",
      tokensUsed: 0,
    };

  // 起点エントリの name と aliases を検索語として集める。
  const aliasArr = source.aliases
    ? (() => {
        try {
          const parsed = JSON.parse(source.aliases as string);
          return Array.isArray(parsed)
            ? parsed.filter((s): s is string => typeof s === "string")
            : [];
        } catch {
          return [];
        }
      })()
    : [];
  const terms = [source.name, ...aliasArr].filter(
    (t) => typeof t === "string" && t.trim().length > 0,
  );
  if (terms.length === 0)
    return {
      name: "find_related_entries",
      content: [],
      summary: "Source entry has no searchable name",
      tokensUsed: 0,
    };

  const typeFilter = params["type"] ? String(params["type"]).trim() : undefined;

  const rows = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      summary: codexEntries.summary,
    })
    .from(codexEntries)
    .where(
      and(
        eq(codexEntries.projectId, projectId),
        ne(codexEntries.id, id),
        buildLikeOrCondition(terms, [
          codexEntries.name,
          codexEntries.summary,
          codexEntries.aliases,
          codexEntries.tagsCache,
        ]),
        typeFilter ? eq(codexEntries.type, typeFilter) : undefined,
      ),
    )
    .limit(20);

  const content = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary ?? "",
  }));
  const json = JSON.stringify(content);
  return {
    name: "find_related_entries",
    content,
    summary: `${content.length} related to ${source.name}${typeFilter ? ` (type=${typeFilter})` : ""}`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Scene tools
// ---------------------------------------------------------------------------

async function listChapters(): Promise<Omit<ToolResult, "toolCallId">> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "list_chapters",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };
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
        inArray(treeNodes.nodeType, ["part", "chapter", "scene"]),
      ),
    );

  // Sort by sortOrder for consistent output
  nodes.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  const content = nodes.map((n) => ({
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
    tokensUsed: countTokens(json),
  };
}

async function getScene(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id)
    return {
      name: "get_scene",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "get_scene",
      content: null,
      summary: "No active project",
      tokensUsed: 0,
    };

  const [node] = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      nodeType: treeNodes.nodeType,
    })
    .from(treeNodes)
    .where(and(eq(treeNodes.id, id), eq(treeNodes.projectId, projectId)));

  if (!node || node.nodeType !== "scene") {
    return {
      name: "get_scene",
      content: null,
      summary: "Scene not found",
      tokensUsed: 0,
    };
  }

  const rawContent = await loadSceneContent(id);
  const markdown = prosemirrorToText(rawContent);
  const content = { id, title: node.title, content: markdown };
  const json = JSON.stringify(content);
  return {
    name: "get_scene",
    content,
    summary: `Scene '${node.title}' (${markdown.length} chars)`,
    tokensUsed: countTokens(json),
  };
}

async function searchScenes(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_scenes",
      content: [],
      summary: "0 scenes found",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "search_scenes",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  // tree_nodes_fts は trigram。短トークンを含む場合は LIKE-OR fallback。
  const tokens = tokenizeQuery(query);
  const allTrigramFriendly =
    tokens.length > 0 && tokens.every((t) => codepointLength(t) >= 3);

  let rows: Array<{ id: string; title: string; content: string }>;
  if (allTrigramFriendly) {
    const hitIds = await sparseSearchIds(projectId, query, "scenes", 10);
    if (hitIds.length === 0) {
      rows = [];
    } else {
      rows = orderByIds(
        await db
          .select({
            id: treeNodes.id,
            title: treeNodes.title,
            content: treeNodes.content,
          })
          .from(treeNodes)
          .where(
            and(
              eq(treeNodes.projectId, projectId),
              eq(treeNodes.nodeType, "scene"),
              inArray(treeNodes.id, hitIds),
            ),
          ),
        hitIds,
      );
    }
  } else {
    rows = await db
      .select({
        id: treeNodes.id,
        title: treeNodes.title,
        content: treeNodes.content,
      })
      .from(treeNodes)
      .where(
        and(
          eq(treeNodes.projectId, projectId),
          eq(treeNodes.nodeType, "scene"),
          buildLikeOrCondition(tokens.length > 0 ? tokens : [query], [
            treeNodes.title,
            treeNodes.content,
          ]),
        ),
      )
      .limit(10);
  }

  const content = rows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: plainTextExcerpt(row.content, tokens),
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_scenes",
    content,
    summary: `${content.length} scenes found`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Snippet tools
// ---------------------------------------------------------------------------

async function searchSnippets(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_snippets",
      content: [],
      summary: "0 snippets found",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "search_snippets",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  // snippets_fts は trigram。短トークンを含む場合は LIKE-OR fallback。
  const tokens = tokenizeQuery(query);
  const allTrigramFriendly =
    tokens.length > 0 && tokens.every((t) => codepointLength(t) >= 3);

  let rows: Array<{
    id: string;
    title: string;
    tagsCache: string | null;
    content: string;
  }>;
  if (allTrigramFriendly) {
    const hitIds = await sparseSearchIds(projectId, query, "snippets", 10);
    if (hitIds.length === 0) {
      rows = [];
    } else {
      rows = orderByIds(
        await db
          .select({
            id: snippets.id,
            title: snippets.title,
            tagsCache: snippets.tagsCache,
            content: snippets.content,
          })
          .from(snippets)
          .where(
            and(
              eq(snippets.projectId, projectId),
              inArray(snippets.id, hitIds),
            ),
          ),
        hitIds,
      );
    }
  } else {
    rows = await db
      .select({
        id: snippets.id,
        title: snippets.title,
        tagsCache: snippets.tagsCache,
        content: snippets.content,
      })
      .from(snippets)
      .where(
        and(
          eq(snippets.projectId, projectId),
          buildLikeOrCondition(tokens.length > 0 ? tokens : [query], [
            snippets.title,
            snippets.content,
            snippets.tagsCache,
          ]),
        ),
      )
      .limit(10);
  }

  const content = rows.map((row) => ({
    id: row.id,
    title: row.title,
    tags: parseTagsCacheNames(row.tagsCache),
    preview: plainTextExcerpt(row.content, tokens),
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_snippets",
    content,
    summary: `${content.length} snippets found`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Summary tools
// ---------------------------------------------------------------------------

async function getChapterSummaries(): Promise<Omit<ToolResult, "toolCallId">> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "get_chapter_summaries",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };
  const chapters = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      sortOrder: treeNodes.sortOrder,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "chapter"),
      ),
    );

  chapters.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  const scenes = await db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      title: treeNodes.title,
      synopsis: treeNodes.synopsis,
      sortOrder: treeNodes.sortOrder,
    })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), eq(treeNodes.nodeType, "scene")),
    );

  const content = chapters.map((ch) => ({
    id: ch.id,
    title: ch.title,
    scenes: scenes
      .filter((s) => s.parentId === ch.id)
      .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder))
      .map((s) => ({ id: s.id, title: s.title, synopsis: s.synopsis ?? "" }))
      .filter((s) => s.synopsis),
  }));

  const json = JSON.stringify(content);
  return {
    name: "get_chapter_summaries",
    content,
    summary: `${chapters.length} chapters with scene summaries`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Foreshadow / Timeline tools (Phase 3)
// ---------------------------------------------------------------------------

async function listOpenForeshadows(): Promise<Omit<ToolResult, "toolCallId">> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) {
    return {
      name: "list_open_foreshadows",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };
  }
  const rows = await listOpenForeshadowsForContext(projectId);
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
    tokensUsed: countTokens(json),
  };
}

async function getForeshadowDetail(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
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
  // (secret) plot intent/notes/setups. Mirrors getCodexEntry / getScene.
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) {
    return {
      name: "get_foreshadow_detail",
      content: null,
      summary: "No active project",
      tokensUsed: 0,
    };
  }

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

  // Setups + scene title (innerJoin); orphan は別フィールドで載せる。
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
    .where(eq(foreshadowSetups.foreshadowId, id));

  // Payoff scene の title 取得（payoffSceneId が無ければ null）
  let payoffScene: { id: string; title: string } | null = null;
  if (fs.payoffSceneId) {
    const [row] = await db
      .select({ id: treeNodes.id, title: treeNodes.title })
      .from(treeNodes)
      .where(eq(treeNodes.id, fs.payoffSceneId));
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
      // 人手評価が無いとき AI 評価を露出（強度の参考情報）
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
    tokensUsed: countTokens(json),
  };
}

async function getSceneTimelineNeighbors(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
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
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) {
    return {
      name: "get_scene_timeline_neighbors",
      content: { previous: [], next: [], currentSceneStoryTimeLabel: null },
      summary: "No active project",
      tokensUsed: 0,
    };
  }

  const [target] = await db
    .select({
      id: treeNodes.id,
      projectId: treeNodes.projectId,
      storyTimeOrder: treeNodes.storyTimeOrder,
      storyTimeLabel: treeNodes.storyTimeLabel,
    })
    .from(treeNodes)
    .where(and(eq(treeNodes.id, sceneId), eq(treeNodes.projectId, projectId)));

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
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Mutating executors (knowledgeWrite policy gated)
// ---------------------------------------------------------------------------

const MAX_CODEX_ALIASES = 100;
const MAX_CODEX_ALIAS_BYTES = 64_000;

function optionalMarkdownBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("content must be a Markdown string");
  }
  return agentMarkdownToProseMirrorJson(value);
}

function optionalAliases(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("aliases must be an array of strings");
  }
  if (value.length > MAX_CODEX_ALIASES) {
    throw new Error(`aliases must contain at most ${MAX_CODEX_ALIASES} items`);
  }
  const aliases = value.map((item) => item.trim()).filter(Boolean);
  const serialized = JSON.stringify(aliases);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CODEX_ALIAS_BYTES) {
    throw new Error(`aliases exceed ${MAX_CODEX_ALIAS_BYTES} bytes`);
  }
  return serialized;
}

async function createCodexEntryTool(
  params: Record<string, unknown>,
  requestId?: string,
): Promise<Omit<ToolResult, "toolCallId">> {
  const type = String(params["type"] ?? "").trim();
  const name = String(params["name"] ?? "").trim();
  if (!type || !name) {
    return {
      name: "create_codex_entry",
      content: null,
      summary: "type and name are required",
      tokensUsed: 0,
      error: "type and name are required",
    };
  }
  try {
    const entry = await agentCreateCodexEntry({
      requestId,
      type,
      name,
      summary: params["summary"] ? String(params["summary"]) : undefined,
      content: optionalMarkdownBody(params["content"]),
      aliases: optionalAliases(params["aliases"]),
      parentId: params["parentId"] ? String(params["parentId"]) : undefined,
    });
    const content = { id: entry.id, name: entry.name, type: entry.type };
    const json = JSON.stringify(content);
    return {
      name: "create_codex_entry",
      content,
      summary: `Created codex entry '${entry.name}' (${entry.type})`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "create_codex_entry",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  } finally {
    // DB 書込成功後に store 再ロード等で throw しても stale 化しないよう finally で破棄。
    invalidateChronicleToolCache();
  }
}

async function updateCodexEntryTool(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id) {
    return {
      name: "update_codex_entry",
      content: null,
      summary: "id is required",
      tokensUsed: 0,
      error: "id is required",
    };
  }
  try {
    const entry = await agentUpdateCodexEntry({
      entryId: id,
      name: params["name"] !== undefined ? String(params["name"]) : undefined,
      summary:
        params["summary"] !== undefined ? String(params["summary"]) : undefined,
      content:
        params["content"] !== undefined
          ? optionalMarkdownBody(params["content"])
          : undefined,
      aliases: optionalAliases(params["aliases"]),
    });
    const content = { id: entry.id, name: entry.name, type: entry.type };
    const json = JSON.stringify(content);
    return {
      name: "update_codex_entry",
      content,
      summary: `Updated codex entry '${entry.name}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "update_codex_entry",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  } finally {
    invalidateChronicleToolCache();
  }
}

// ---------------------------------------------------------------------------
// Plot threads (read-only)
// ---------------------------------------------------------------------------

const THREAD_SCENE_MAX = 8;
const THREAD_EXCERPT_MAX_CHARS = 800;

/** phaseType の表示順 index（未知値は末尾）。 */
function phaseRank(p: string): number {
  const i = (PLOT_PHASE_TYPES as readonly string[]).indexOf(p);
  return i < 0 ? PLOT_PHASE_TYPES.length : i;
}

/** 不正な phaseType 文字列を既定値に丸める（CHECK は SQL 側のみ＝混入し得る）。 */
function normalizePhase(p: string): PlotPhaseType {
  return (PLOT_PHASE_TYPES as readonly string[]).includes(p)
    ? (p as PlotPhaseType)
    : "develop";
}

async function listPlotThreads(): Promise<Omit<ToolResult, "toolCallId">> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      // 他の list_* ツールと揃えて空配列を返す（null だと「列挙失敗」に見える）。
      name: "list_plot_threads",
      content: [],
      summary: "No active project",
      tokensUsed: 0,
    };

  const threads = await db
    .select({
      id: plotThreads.id,
      name: plotThreads.name,
      description: plotThreads.description,
      sortOrder: plotThreads.sortOrder,
    })
    .from(plotThreads)
    .where(eq(plotThreads.projectId, projectId));

  const threadIds = threads.map((t) => t.id);
  const links =
    threadIds.length > 0
      ? await db
          .select({
            threadId: plotThreadSceneLinks.threadId,
            nodeId: plotThreadSceneLinks.nodeId,
            phaseType: plotThreadSceneLinks.phaseType,
          })
          .from(plotThreadSceneLinks)
          .where(inArray(plotThreadSceneLinks.threadId, threadIds))
      : [];

  // thread ごとの distinct scene 数 + 到達 phase 集合。
  const sceneSets = new Map<string, Set<string>>();
  const phaseSets = new Map<string, Set<string>>();
  for (const l of links) {
    let sc = sceneSets.get(l.threadId);
    if (!sc) {
      sc = new Set();
      sceneSets.set(l.threadId, sc);
    }
    sc.add(l.nodeId);
    let ph = phaseSets.get(l.threadId);
    if (!ph) {
      ph = new Set();
      phaseSets.set(l.threadId, ph);
    }
    ph.add(l.phaseType);
  }

  const ordered = [...threads].sort((a, b) =>
    cmpKeys(a.sortOrder, b.sortOrder),
  );
  const content = ordered.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? "",
    sceneCount: sceneSets.get(t.id)?.size ?? 0,
    phases: PLOT_PHASE_TYPES.filter((p) => phaseSets.get(t.id)?.has(p)),
  }));

  const json = JSON.stringify(content);
  return {
    name: "list_plot_threads",
    content,
    summary: `${content.length} plot thread(s)`,
    tokensUsed: countTokens(json),
  };
}

async function getThreadScenes(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const threadId = String(params["threadId"] ?? "").trim();
  if (!threadId)
    return {
      name: "get_thread_scenes",
      content: null,
      summary: "No threadId provided",
      tokensUsed: 0,
    };

  // XPROJ 1段目: thread_id → plot_threads.project_id を検証。別 project の
  // スレッド UUID を渡しても、シーン/リンク/本文に触れる前にここで弾く
  // （nodeId 単独 lookup 禁止＝plot_thread_scene_links は project_id を持たず
  // 親スレッド経由でしか scope できないため）。
  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "get_thread_scenes",
      content: null,
      summary: "No active project",
      tokensUsed: 0,
    };

  const [thread] = await db
    .select({
      id: plotThreads.id,
      name: plotThreads.name,
      description: plotThreads.description,
    })
    .from(plotThreads)
    .where(
      and(eq(plotThreads.id, threadId), eq(plotThreads.projectId, projectId)),
    );

  if (!thread)
    return {
      name: "get_thread_scenes",
      content: null,
      summary: "Thread not found",
      tokensUsed: 0,
    };

  // 2段目: 親スレッド検証済みなので links を threadId で取得。
  const links = await db
    .select({
      nodeId: plotThreadSceneLinks.nodeId,
      phaseType: plotThreadSceneLinks.phaseType,
      note: plotThreadSceneLinks.note,
      sortOrder: plotThreadSceneLinks.sortOrder,
    })
    .from(plotThreadSceneLinks)
    .where(eq(plotThreadSceneLinks.threadId, threadId));

  // PLOT_PHASE_TYPES 順 → 同 phase 内は sortOrder。
  const orderedLinks = [...links].sort((a, b) => {
    const pr = phaseRank(a.phaseType) - phaseRank(b.phaseType);
    if (pr !== 0) return pr;
    return cmpKeys(a.sortOrder ?? "", b.sortOrder ?? "");
  });

  // scene title をまとめて解決（active project の treeNodes に限定）。
  const nodeIds = [...new Set(orderedLinks.map((l) => l.nodeId))];
  const titleRows =
    nodeIds.length > 0
      ? await db
          .select({ id: treeNodes.id, title: treeNodes.title })
          .from(treeNodes)
          .where(
            and(
              inArray(treeNodes.id, nodeIds),
              eq(treeNodes.projectId, projectId),
            ),
          )
      : [];
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  // 1 シーンが複数 phase マーカーを持ち得るので nodeId で dedup（最初＝最も早い
  // phase を採用）。list_plot_threads の distinct scene 数と一貫させ、同一シーンが
  // 重複出力されるのを防ぐ。
  const seenNodes = new Set<string>();
  const dedupedLinks = orderedLinks.filter((l) => {
    if (seenNodes.has(l.nodeId)) return false;
    seenNodes.add(l.nodeId);
    return true;
  });

  const capped = dedupedLinks.slice(0, THREAD_SCENE_MAX);
  const scenes: Array<{
    id: string;
    title: string;
    phaseType: PlotPhaseType;
    note: string;
    excerpt: string;
  }> = [];
  const contentMap = await loadSceneContents(capped.map((l) => l.nodeId)).catch(
    () => new Map<string, string>(),
  );
  for (const l of capped) {
    const text = prosemirrorToText(contentMap.get(l.nodeId) ?? "");
    scenes.push({
      id: l.nodeId,
      title: titleById.get(l.nodeId) ?? "",
      phaseType: normalizePhase(l.phaseType),
      note: l.note ?? "",
      excerpt: text.slice(0, THREAD_EXCERPT_MAX_CHARS),
    });
  }

  // このスレッドに関わる branch（project でも絞る＝XPROJ）。
  const branchRows = await db
    .select({
      fromThreadId: plotThreadBranches.fromThreadId,
      toThreadId: plotThreadBranches.toThreadId,
      atNodeId: plotThreadBranches.atNodeId,
      kind: plotThreadBranches.kind,
    })
    .from(plotThreadBranches)
    .where(eq(plotThreadBranches.projectId, projectId));
  const branches = branchRows.filter(
    (b) => b.fromThreadId === threadId || b.toThreadId === threadId,
  );

  const content = {
    id: thread.id,
    name: thread.name,
    description: thread.description ?? "",
    sceneCount: dedupedLinks.length,
    scenes,
    branches,
  };
  const json = JSON.stringify(content);
  return {
    name: "get_thread_scenes",
    content,
    summary: `Thread '${thread.name}': ${scenes.length}/${dedupedLinks.length} scene(s)`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

type Executor = (
  params: Record<string, unknown>,
  requestId?: string,
) => Promise<Omit<ToolResult, "toolCallId">>;

/**
 * ツール名 → executor の dispatch マップ。
 *
 * 契約（security review F-2）: **ここに載る executor は全て read-only でなければ
 * ならない**。本文・DB を変更する mutating tool を追加する場合は、必ず次の 3 点を
 * 同時に満たすこと:
 *   1. `toolExecutors.test.ts` の read-only allowlist テストを更新する
 *      （allowlist を更新しないとテストが落ちるので、追加が意識的になる）。
 *   2. `agentLoop.ts` の declaredToolNames ゲートにより、その mutating tool が
 *      宣言されたターンでのみ発火することを確認する。
 *   3. AiPolicy bodyWrite ゲート（[[grimodex-bodywrite-chat-suppression]]）と連動させ、
 *      bodyWrite=off のとき呼ばれない／無効化されることを保証する。
 *
 * `ask_user` は意図的にここに含めない（mutating ではなく、chatStore の
 * guardedExecuteTool が UI 往復として横取りする）。
 */
/** Read-only tools — frozen allowlist (security review F-2). */
export const READ_ONLY_EXECUTORS: Record<string, Executor> = {
  search_codex: searchCodex,
  list_codex_by_type: listCodexByType,
  get_codex_entry: getCodexEntry,
  list_codex_tags: listCodexTags,
  search_codex_by_tags: searchCodexByTags,
  find_related_entries: findRelatedEntries,
  list_chapters: () => listChapters(),
  get_scene: getScene,
  search_scenes: searchScenes,
  search_snippets: searchSnippets,
  get_chapter_summaries: () => getChapterSummaries(),
  list_open_foreshadows: () => listOpenForeshadows(),
  get_foreshadow_detail: getForeshadowDetail,
  get_scene_timeline_neighbors: getSceneTimelineNeighbors,
  list_plot_threads: () => listPlotThreads(),
  get_thread_scenes: getThreadScenes,
  list_events: listEventsTool,
  get_event_detail: getEventDetailTool,
  get_character_timeline: getCharacterTimelineTool,
  get_chronicle_state: getChronicleStateTool,
  search_events: searchEvents,
};
Object.freeze(READ_ONLY_EXECUTORS);

async function createSnippetTool(
  params: Record<string, unknown>,
  requestId?: string,
): Promise<Omit<ToolResult, "toolCallId">> {
  const title = String(params["title"] ?? "").trim();
  if (!title) {
    return {
      name: "create_snippet",
      content: null,
      summary: "title is required",
      tokensUsed: 0,
      error: "title is required",
    };
  }
  try {
    const snippet = await agentCreateSnippet({
      requestId,
      title,
      content: optionalMarkdownBody(params["content"]),
      sceneId: params["sceneId"] ? String(params["sceneId"]) : undefined,
    });
    const content = { id: snippet.id, title: snippet.title };
    const json = JSON.stringify(content);
    return {
      name: "create_snippet",
      content,
      summary: `Created snippet '${snippet.title}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "create_snippet",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

async function applyAiTreePlanTool(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const kind = params["kind"];
  const ops = params["ops"];
  if (kind !== "scaffold" && kind !== "reorganize") {
    return {
      name: "apply_ai_tree_plan",
      content: null,
      summary: "kind must be scaffold or reorganize",
      tokensUsed: 0,
      error: "invalid kind",
    };
  }
  if (!Array.isArray(ops)) {
    return {
      name: "apply_ai_tree_plan",
      content: null,
      summary: "ops must be an array",
      tokensUsed: 0,
      error: "invalid ops",
    };
  }
  try {
    const plan = { kind, ops } as AiTreePlan;
    const result = await agentApplyTreePlan(plan);
    const content = result;
    const json = JSON.stringify(content);
    return {
      name: "apply_ai_tree_plan",
      content,
      summary: `Applied tree plan: ${result.createdIds.length} created, ${result.movedIds.length} moved, ${result.renamedIds.length} renamed`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "apply_ai_tree_plan",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  } finally {
    // tree 変更は readingOrder / scene 可視性判定に効くため共有キャッシュを破棄。
    invalidateChronicleToolCache();
  }
}

async function proposeSceneBodyTool(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const sceneId = String(params["sceneId"] ?? "").trim();
  const text = String(params["text"] ?? "").trim();
  if (!sceneId || !text) {
    return {
      name: "propose_scene_body",
      content: null,
      summary: "sceneId and text are required",
      tokensUsed: 0,
      error: "sceneId and text are required",
    };
  }
  const rawMode = params["mode"];
  const mode = rawMode === "insert" ? "insert" : "append";
  try {
    const result = await agentProposeSceneBody({ sceneId, text, mode });
    useProseStagingStore.getState().enqueue({
      stagingId: result.stagingId,
      sceneId: result.sceneId,
      text,
      mode,
    });
    const content = {
      stagingId: result.stagingId,
      sceneId: result.sceneId,
      status: result.status,
    };
    const json = JSON.stringify(content);
    return {
      name: "propose_scene_body",
      content,
      summary: `Proposed body prose for scene (${mode}); awaiting user accept/reject`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "propose_scene_body",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

async function createForeshadowTool(
  params: Record<string, unknown>,
  requestId?: string,
): Promise<Omit<ToolResult, "toolCallId">> {
  const title = String(params["title"] ?? "").trim();
  if (!title) {
    return {
      name: "create_foreshadow",
      content: null,
      summary: "title is required",
      tokensUsed: 0,
      error: "title is required",
    };
  }
  try {
    const item = await agentCreateForeshadow({
      requestId,
      title,
      intent: params["intent"] ? String(params["intent"]) : undefined,
      notes: params["notes"] ? String(params["notes"]) : undefined,
      loadBearing: params["loadBearing"]
        ? (String(params["loadBearing"]) as AgentForeshadowLoadBearing)
        : undefined,
      secret:
        typeof params["secret"] === "boolean" ? params["secret"] : undefined,
    });
    const content = { id: item.id, title: item.title, secret: item.secret };
    const json = JSON.stringify(content);
    return {
      name: "create_foreshadow",
      content,
      summary: `Created foreshadow '${item.title}'${item.secret ? " (secret)" : ""}`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "create_foreshadow",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

async function updateForeshadowTool(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id) {
    return {
      name: "update_foreshadow",
      content: null,
      summary: "id is required",
      tokensUsed: 0,
      error: "id is required",
    };
  }
  try {
    const item = await agentUpdateForeshadow({
      foreshadowId: id,
      title:
        params["title"] !== undefined ? String(params["title"]) : undefined,
      intent:
        params["intent"] !== undefined ? String(params["intent"]) : undefined,
      notes:
        params["notes"] !== undefined ? String(params["notes"]) : undefined,
      loadBearing:
        params["loadBearing"] !== undefined
          ? (String(params["loadBearing"]) as AgentForeshadowLoadBearing)
          : undefined,
      payoffConfirmed:
        typeof params["payoffConfirmed"] === "boolean"
          ? params["payoffConfirmed"]
          : undefined,
      abandoned:
        typeof params["abandoned"] === "boolean"
          ? params["abandoned"]
          : undefined,
      secret:
        typeof params["secret"] === "boolean" ? params["secret"] : undefined,
    });
    const content = {
      id: item.id,
      title: item.title,
      payoffConfirmed: item.payoffConfirmed,
      abandoned: item.abandoned,
    };
    const json = JSON.stringify(content);
    return {
      name: "update_foreshadow",
      content,
      summary: `Updated foreshadow '${item.title}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "update_foreshadow",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

/** Mutating tools — knowledgeWrite / structureWrite / bodyWrite gated per tool. */
export const MUTATING_EXECUTORS: Record<string, Executor> = {
  create_codex_entry: createCodexEntryTool,
  update_codex_entry: updateCodexEntryTool,
  create_foreshadow: createForeshadowTool,
  update_foreshadow: updateForeshadowTool,
  create_snippet: createSnippetTool,
  apply_ai_tree_plan: applyAiTreePlanTool,
  propose_scene_body: proposeSceneBodyTool,
  create_event: createEventTool,
  update_event: updateEventTool,
  delete_event: deleteEventTool,
  stamp_scene_event: stampSceneEventTool,
  unstamp_scene_event: unstampSceneEventTool,
  set_event_participants: setEventParticipantsTool,
  add_event_relation: addEventRelationTool,
  remove_event_relation: removeEventRelationTool,
};
Object.freeze(MUTATING_EXECUTORS);

export const EXECUTORS: Record<string, Executor> = {
  ...READ_ONLY_EXECUTORS,
  ...MUTATING_EXECUTORS,
};
// 実行時の mutation を封じる（read-only 不変条件の defense-in-depth）。
Object.freeze(EXECUTORS);

const IDEMPOTENT_CREATE_TOOLS: ReadonlySet<string> = new Set([
  "create_codex_entry",
  "create_snippet",
  "create_foreshadow",
  "create_event",
]);

async function toolCreateRequestId(
  toolName: string,
  toolCallId: string,
  projectId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${toolName}\0${projectId}\0${toolCallId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `agent-tool:${hex}`;
}

/** Execute a named tool and return a ToolResult (always succeeds — errors are wrapped). */
export async function executeTool(
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const executor = EXECUTORS[name];
  if (!executor) {
    const msg = `Unknown tool: ${name}`;
    return {
      toolCallId,
      name,
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
  try {
    const createAuthority = IDEMPOTENT_CREATE_TOOLS.has(name)
      ? captureMutationAuthority(getCurrentProjectId(), getCurrentProjectId)
      : null;
    const requestId = createAuthority
      ? await toolCreateRequestId(name, toolCallId, createAuthority.projectId)
      : undefined;
    // SHA-256 yields before the domain writer captures its own Project. Do not
    // let a pre-switch tool call resume against a replacement Project/Workspace.
    if (createAuthority && !isCurrentMutationAuthority(createAuthority)) {
      throw new Error("agent tool create authority changed");
    }
    const result = await executor(params, requestId);
    return { toolCallId, ...result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      toolCallId,
      name,
      content: null,
      summary: `Error: ${msg}`,
      tokensUsed: 0,
      error: msg,
    };
  }
}

/**
 * 読み取り専用ツールのみを dispatch する（リサーチ・サブエージェント用）。
 * READ_ONLY_EXECUTORS 以外（mutating / ask_user / run_research）は構造的に拒否し、
 * 子エージェントが書き込み・質問・再帰を行えないことを defense-in-depth で保証する。
 * サブエージェントには getResearchSubagentTools() の読み取りサブセットしか宣言しない
 * ため通常ここに非読み取りツールは来ないが、宣言ゲートが万一破られても
 * read-only 不変条件を二重に守る。
 */
export async function executeReadOnlyTool(
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const executor = READ_ONLY_EXECUTORS[name];
  if (!executor) {
    const msg = `Tool not available in research sub-agent (read-only): ${name}`;
    return {
      toolCallId,
      name,
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
  try {
    const result = await executor(params);
    return { toolCallId, ...result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      toolCallId,
      name,
      content: null,
      summary: `Error: ${msg}`,
      tokensUsed: 0,
      error: msg,
    };
  }
}
