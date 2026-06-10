import type {
  ChatSession,
  ChatMessage,
  ChatSummary,
} from "@/features/chat/chatTypes";
import type {
  PinnedCodexEntryWithData,
  PinnedSnippetEntryWithData,
} from "@/features/chat/chatApi";

export interface ChatSessionExport {
  schemaVersion: 2;
  session: {
    id: string;
    title: string;
    model: string | null;
    createdAt: string;
    updatedAt: string;
    nodeId: string | null;
    codexAnchorId: string | null;
  };
  pinnedCodex: Array<{
    id: string;
    name?: string;
    title?: string;
    type: "codex" | "snippet";
    withChildren?: boolean;
    pinSource?: string;
  }>;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number | null;
    metadata: unknown;
    isStarred: boolean;
    isSummarized: boolean;
    createdAt: string;
  }>;
  summaries: Array<{
    id: string;
    summary: string;
    tokenCount: number | null;
    createdAt: string;
    sourceMessageIds: string[];
  }>;
}

function parseMetadata(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function serializeChatSession(
  session: ChatSession,
  messages: ChatMessage[],
  summaries: ChatSummary[],
  pinnedCodex: PinnedCodexEntryWithData[],
  pinnedSnippets: PinnedSnippetEntryWithData[],
): ChatSessionExport {
  return {
    schemaVersion: 2,
    session: {
      id: session.id,
      title: session.title,
      model: session.model ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      nodeId: session.nodeId,
      codexAnchorId: session.codexAnchorId,
    },
    pinnedCodex: [
      ...pinnedCodex.map((e) => ({
        id: e.id,
        name: e.name,
        type: "codex" as const,
        withChildren: e.withChildren,
        pinSource: e.pinSource,
      })),
      ...pinnedSnippets.map((s) => ({
        id: s.id,
        title: s.title,
        type: "snippet" as const,
      })),
    ],
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      model: m.model ?? null,
      tokensIn: m.tokensIn ?? null,
      tokensOut: m.tokensOut ?? null,
      durationMs: m.durationMs ?? null,
      metadata: parseMetadata(m.metadata),
      isStarred: Boolean(m.isStarred),
      isSummarized: Boolean(m.isSummarized),
      createdAt: m.createdAt,
    })),
    summaries: summaries.map((s) => ({
      id: s.id,
      summary: s.summary,
      tokenCount: s.tokenCount ?? null,
      createdAt: s.createdAt,
      sourceMessageIds: s.sourceMessageIds,
    })),
  };
}
