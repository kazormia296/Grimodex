import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import {
  chatSessions,
  chatMessages,
  codexEntries,
  snippets,
} from "@/db/schema";
import { eq, desc, inArray } from "drizzle-orm";

export interface SessionExtractions {
  codex: Array<{ id: string; name: string; type: string }>;
  snippets: Array<{ id: string; title: string }>;
}
import type { ChatSession, MessageRole } from "./chatTypes";

export interface SessionWithStats extends ChatSession {
  msgCount: number;
  codexCount: number;
  snippetCount: number;
  firstUserMessage: string | null;
}

export interface MessageSearchHit {
  msgId: string;
  sessionId: string;
  sessionTitle: string;
  nodeId: string | null;
  role: MessageRole;
  content: string;
  highlightedContent: string;
  createdAt: string;
  sessionUpdatedAt: string;
}

function toSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    nodeId: row.nodeId,
    title: row.title,
    titleManual: row.titleManual,
    model: row.model,
    pinnedCodex: row.pinnedCodex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List all sessions for a project with aggregated stats:
 * message count, codex extraction count, snippet extraction count,
 * and the first user message preview.
 */
export async function listSessionsWithStats(
  projectId: string,
): Promise<SessionWithStats[]> {
  const sessionRows = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.projectId, projectId))
    .orderBy(desc(chatSessions.updatedAt));

  if (sessionRows.length === 0) return [];

  const sessionIds = sessionRows.map((s) => s.id);

  // Fetch all messages for these sessions in one query
  const msgs = await db
    .select({
      id: chatMessages.id,
      sessionId: chatMessages.sessionId,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(inArray(chatMessages.sessionId, sessionIds))
    .orderBy(chatMessages.createdAt);

  const msgIds = msgs.map((m) => m.id);

  // Fetch codex extraction counts
  const codexRows =
    msgIds.length > 0
      ? await db
          .select({ sourceChatMessageId: codexEntries.sourceChatMessageId })
          .from(codexEntries)
          .where(inArray(codexEntries.sourceChatMessageId, msgIds))
      : [];

  // Fetch snippet extraction counts
  const snippetRows =
    msgIds.length > 0
      ? await db
          .select({ sourceChatMessageId: snippets.sourceChatMessageId })
          .from(snippets)
          .where(inArray(snippets.sourceChatMessageId, msgIds))
      : [];

  // Aggregate per session
  const msgsBySession: Record<string, typeof msgs> = {};
  for (const msg of msgs) {
    if (!msgsBySession[msg.sessionId]) msgsBySession[msg.sessionId] = [];
    msgsBySession[msg.sessionId].push(msg);
  }

  const codexByMsg: Record<string, number> = {};
  for (const ce of codexRows) {
    if (ce.sourceChatMessageId) {
      codexByMsg[ce.sourceChatMessageId] =
        (codexByMsg[ce.sourceChatMessageId] ?? 0) + 1;
    }
  }

  const snippetByMsg: Record<string, number> = {};
  for (const sn of snippetRows) {
    if (sn.sourceChatMessageId) {
      snippetByMsg[sn.sourceChatMessageId] =
        (snippetByMsg[sn.sourceChatMessageId] ?? 0) + 1;
    }
  }

  return sessionRows.map((s) => {
    const sessionMsgs = msgsBySession[s.id] ?? [];
    const nonSystemMsgs = sessionMsgs.filter((m) => m.role !== "system");
    const firstUserMsg = sessionMsgs.find((m) => m.role === "user");

    let codexCount = 0;
    let snippetCount = 0;
    for (const msg of sessionMsgs) {
      codexCount += codexByMsg[msg.id] ?? 0;
      snippetCount += snippetByMsg[msg.id] ?? 0;
    }

    return {
      ...toSession(s),
      msgCount: nonSystemMsgs.length,
      codexCount,
      snippetCount,
      firstUserMessage: firstUserMsg
        ? firstUserMsg.content.slice(0, 100)
        : null,
    };
  });
}

/**
 * List codex entries and snippets extracted from a specific chat session.
 */
export async function listExtractionsBySession(
  sessionId: string,
): Promise<SessionExtractions> {
  const msgs = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId));

  if (msgs.length === 0) return { codex: [], snippets: [] };

  const msgIds = msgs.map((m) => m.id);

  const codex = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
    })
    .from(codexEntries)
    .where(inArray(codexEntries.sourceChatMessageId, msgIds));

  const snips = await db
    .select({ id: snippets.id, title: snippets.title })
    .from(snippets)
    .where(inArray(snippets.sourceChatMessageId, msgIds));

  return { codex, snippets: snips };
}

/**
 * Full-text search over chat messages using the FTS5 virtual table.
 * Returns message hits with surrounding context and session metadata.
 */
export async function searchChatMessages(
  projectId: string,
  query: string,
): Promise<MessageSearchHit[]> {
  if (!query.trim()) return [];

  interface RawRow {
    msg_id: string;
    session_id: string;
    session_title: string;
    node_id: string | null;
    role: string;
    content: string;
    highlighted_content: string;
    created_at: string;
    session_updated_at: string;
  }

  const sql = `
    SELECT
      m.id          AS msg_id,
      m.session_id,
      s.title       AS session_title,
      s.node_id,
      m.role,
      m.content,
      snippet(chat_messages_fts, 0, '\x01', '\x02', '...', 20) AS highlighted_content,
      m.created_at,
      s.updated_at  AS session_updated_at
    FROM chat_messages_fts
    JOIN chat_messages m ON chat_messages_fts.rowid = m.rowid
    JOIN chat_sessions s ON m.session_id = s.id
    WHERE chat_messages_fts MATCH ?
      AND s.project_id = ?
      AND m.role != 'system'
    ORDER BY rank
    LIMIT 50
  `;

  const result = await invoke<{ rows: RawRow[] }>("db_execute", {
    sql,
    params: [query, projectId],
    method: "all",
  });

  return result.rows.map((row) => ({
    msgId: row.msg_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    nodeId: row.node_id,
    role: row.role as MessageRole,
    content: row.content,
    highlightedContent: row.highlighted_content,
    createdAt: row.created_at,
    sessionUpdatedAt: row.session_updated_at,
  }));
}
