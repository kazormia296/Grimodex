import { invoke } from "@/lib/tauri";
import { loadSceneContent } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { db } from "@/db/client";
import {
  codexEntries,
  codexDetailDefinitions,
  codexDetailValues,
  treeNodes,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { countTokens } from "../contextBuilder";
import type { ToolResult } from "./agentTypes";

interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
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

  const charCount = [...query].length;
  let rows: Record<string, unknown>[];

  if (charCount >= 3) {
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT ce.id, ce.name, ce.type, ce.summary
            FROM codex_entries ce
            JOIN codex_fts fts ON ce.rowid = fts.rowid
            WHERE codex_fts MATCH ?
            ORDER BY fts.rank
            LIMIT 20`,
      params: [query],
      method: "all",
    });
    rows = result.rows;
  } else {
    const like = `%${query}%`;
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT id, name, type, summary FROM codex_entries
            WHERE name LIKE ? OR summary LIKE ? OR tags_cache LIKE ?
            LIMIT 20`,
      params: [like, like, like],
      method: "all",
    });
    rows = result.rows;
  }

  const content = rows.map((r) => ({
    id: r["id"],
    name: r["name"],
    type: r["type"],
    summary: r["summary"] ?? "",
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_codex",
    content,
    summary: `${content.length} entries found`,
    tokensUsed: countTokens(json),
  };
}

async function listCodexByType(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const type = String(params["type"] ?? "").trim();
  const rows = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      summary: codexEntries.summary,
      tagsCache: codexEntries.tagsCache,
    })
    .from(codexEntries)
    .where(eq(codexEntries.type, type));

  const content = rows.map((r) => ({
    id: r.id,
    name: r.name,
    summary: r.summary ?? "",
    tags: r.tagsCache ? (JSON.parse(r.tagsCache) as string[]) : [],
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

  const [entry] = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.id, id));
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

  const content = {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases ? (JSON.parse(entry.aliases) as string[]) : [],
    summary: entry.summary ?? "",
    details,
    children: children.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      summary: c.summary ?? "",
    })),
  };
  const json = JSON.stringify(content);
  return {
    name: "get_codex_entry",
    content,
    summary: `${entry.name} (${entry.type})`,
    tokensUsed: countTokens(json),
  };
}

async function listCodexTags(
  params: Record<string, unknown>,
): Promise<Omit<ToolResult, "toolCallId">> {
  const typeFilter = params["type"] ? String(params["type"]) : undefined;

  const sql = typeFilter
    ? `SELECT ct.id, ct.name, ct.color, ct.type_filter, COUNT(cet.entry_id) as usage_count
       FROM codex_tags ct
       LEFT JOIN codex_entry_tags cet ON ct.id = cet.tag_id
       WHERE ct.type_filter IS NULL OR ct.type_filter LIKE ?
       GROUP BY ct.id
       ORDER BY usage_count DESC`
    : `SELECT ct.id, ct.name, ct.color, ct.type_filter, COUNT(cet.entry_id) as usage_count
       FROM codex_tags ct
       LEFT JOIN codex_entry_tags cet ON ct.id = cet.tag_id
       GROUP BY ct.id
       ORDER BY usage_count DESC`;

  const queryParams = typeFilter ? [`%${typeFilter}%`] : [];
  const result = await invoke<QueryResult>("db_execute", {
    sql,
    params: queryParams,
    method: "all",
  });

  const content = result.rows.map((r) => ({
    id: r["id"],
    name: r["name"],
    usageCount: r["usage_count"],
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

  const placeholders = tags.map(() => "?").join(", ");
  const result = await invoke<QueryResult>("db_execute", {
    sql: `SELECT DISTINCT ce.id, ce.name, ce.type, ce.summary
          FROM codex_entries ce
          JOIN codex_entry_tags cet ON ce.id = cet.entry_id
          JOIN codex_tags ct ON cet.tag_id = ct.id
          WHERE ct.name IN (${placeholders})`,
    params: tags,
    method: "all",
  });

  const content = result.rows.map((r) => ({
    id: r["id"],
    name: r["name"],
    type: r["type"],
    summary: r["summary"] ?? "",
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_codex_by_tags",
    content,
    summary: `${content.length} entries found`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Scene tools
// ---------------------------------------------------------------------------

async function listChapters(): Promise<Omit<ToolResult, "toolCallId">> {
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
    .where(inArray(treeNodes.nodeType, ["part", "chapter", "scene"]));

  // Sort by sortOrder for consistent output
  nodes.sort((a, b) => a.sortOrder - b.sortOrder);

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

  const [node] = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      nodeType: treeNodes.nodeType,
    })
    .from(treeNodes)
    .where(eq(treeNodes.id, id));

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

  const charCount = [...query].length;
  let rows: Record<string, unknown>[];

  if (charCount >= 3) {
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT tn.id, tn.title,
                   snippet(tree_nodes_fts, 1, '[', ']', '...', 40) as excerpt
            FROM tree_nodes tn
            JOIN tree_nodes_fts fts ON tn.rowid = fts.rowid
            WHERE tree_nodes_fts MATCH ? AND tn.node_type = 'scene'
            LIMIT 10`,
      params: [query],
      method: "all",
    });
    rows = result.rows;
  } else {
    const like = `%${query}%`;
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT id, title, SUBSTR(content, 1, 200) as excerpt
            FROM tree_nodes
            WHERE node_type = 'scene' AND (title LIKE ? OR content LIKE ?)
            LIMIT 10`,
      params: [like, like],
      method: "all",
    });
    rows = result.rows;
  }

  const content = rows.map((r) => ({
    id: r["id"],
    title: r["title"],
    excerpt: r["excerpt"] ?? "",
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

  const charCount = [...query].length;
  let rows: Record<string, unknown>[];

  if (charCount >= 3) {
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT s.id, s.title, s.tags_cache, SUBSTR(s.content, 1, 200) as preview
            FROM snippets s
            JOIN snippets_fts fts ON s.rowid = fts.rowid
            WHERE snippets_fts MATCH ?
            ORDER BY fts.rank
            LIMIT 10`,
      params: [query],
      method: "all",
    });
    rows = result.rows;
  } else {
    const like = `%${query}%`;
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT id, title, tags_cache, SUBSTR(content, 1, 200) as preview
            FROM snippets
            WHERE title LIKE ? OR content LIKE ? OR tags_cache LIKE ?
            LIMIT 10`,
      params: [like, like, like],
      method: "all",
    });
    rows = result.rows;
  }

  const content = rows.map((r) => ({
    id: r["id"],
    title: r["title"],
    tags: r["tags_cache"]
      ? (JSON.parse(r["tags_cache"] as string) as string[])
      : [],
    preview: r["preview"] ?? "",
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
  const chapters = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      sortOrder: treeNodes.sortOrder,
    })
    .from(treeNodes)
    .where(eq(treeNodes.nodeType, "chapter"));

  chapters.sort((a, b) => a.sortOrder - b.sortOrder);

  const scenes = await db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      title: treeNodes.title,
      synopsis: treeNodes.synopsis,
      sortOrder: treeNodes.sortOrder,
    })
    .from(treeNodes)
    .where(eq(treeNodes.nodeType, "scene"));

  const content = chapters.map((ch) => ({
    id: ch.id,
    title: ch.title,
    scenes: scenes
      .filter((s) => s.parentId === ch.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
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
// Dispatch map
// ---------------------------------------------------------------------------

type Executor = (
  params: Record<string, unknown>,
) => Promise<Omit<ToolResult, "toolCallId">>;

const EXECUTORS: Record<string, Executor> = {
  search_codex: searchCodex,
  list_codex_by_type: listCodexByType,
  get_codex_entry: getCodexEntry,
  list_codex_tags: listCodexTags,
  search_codex_by_tags: searchCodexByTags,
  list_chapters: () => listChapters(),
  get_scene: getScene,
  search_scenes: searchScenes,
  search_snippets: searchSnippets,
  get_chapter_summaries: () => getChapterSummaries(),
};

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
