import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";

export const LANE_SUMMARY_MODEL = "__lane_summary__";
export const LANE_CONTENT_MODEL = "__lane_content__";

export interface AgentAuthorshipSpanInput {
  fromPos: number;
  toPos: number;
  source: AuthorshipSource;
  model?: string | null;
  chatMsgId?: string | null;
  traceId?: string | null;
  /** "summary" | "content" for partial codex updates */
  lane?: "summary" | "content";
}

/**
 * Build synthetic [0, len] AI spans for plain text fields (summary etc.).
 */
export function syntheticAiSpans(
  text: string,
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  } = {},
): AgentAuthorshipSpanInput[] {
  const len = text.length;
  if (len === 0) return [];
  return [
    {
      fromPos: 0,
      toPos: len,
      source: "ai",
      model: opts.model ?? LANE_SUMMARY_MODEL,
      chatMsgId: opts.chatMessageId ?? null,
      traceId: opts.traceId ?? null,
      lane: "summary",
    },
  ];
}

/**
 * Extract AI authorship spans from ProseMirror JSON content string.
 * Walks text nodes and collects authorship marks with source='ai'.
 */
export function extractAiSpansFromPmJson(
  contentJson: string,
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  } = {},
): AgentAuthorshipSpanInput[] {
  if (!contentJson || contentJson === "{}") return [];
  try {
    const doc = JSON.parse(contentJson) as PmNode;
    const spans: AgentAuthorshipSpanInput[] = [];
    walkPm(doc, 0, spans, opts);
    return spans;
  } catch {
    return syntheticAiSpans(contentJson, opts);
  }
}

interface PmNode {
  type?: string;
  text?: string;
  content?: PmNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function walkPm(
  node: PmNode,
  pos: number,
  spans: AgentAuthorshipSpanInput[],
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  },
): number {
  if (node.type === "text" && node.text) {
    const len = node.text.length;
    const mark = node.marks?.find((m) => m.type === "authorship");
    if (mark?.attrs?.source === "ai") {
      spans.push({
        fromPos: pos,
        toPos: pos + len,
        source: "ai",
        model:
          (mark.attrs.model as string | null) ??
          opts.model ??
          LANE_CONTENT_MODEL,
        chatMsgId:
          (mark.attrs.chatMessageId as string | null) ??
          opts.chatMessageId ??
          null,
        traceId: (mark.attrs.traceId as string | null) ?? opts.traceId ?? null,
        lane: "content",
      });
    }
    return pos + len;
  }
  let cursor = pos;
  for (const child of node.content ?? []) {
    cursor = walkPm(child, cursor, spans, opts);
  }
  return cursor;
}
