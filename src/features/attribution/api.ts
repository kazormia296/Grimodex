import { db } from "@/db/client";
import { authorshipSpans } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { NewAuthorshipSpan, AuthorshipSpan } from "@/db/schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AuthorshipSource } from "./AuthorshipMark";

/**
 * Save authorship spans from a ProseMirror document to the database.
 * Replaces all existing spans for the given node.
 */
export async function saveAuthorshipSpans(
  nodeId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  await db.delete(authorshipSpans).where(eq(authorshipSpans.nodeId, nodeId));

  const spans = extractDbSpans(nodeId, doc);
  if (spans.length === 0) return;

  await db.insert(authorshipSpans).values(spans);
}

/**
 * Load authorship spans from the database for a given node.
 */
export async function loadAuthorshipSpans(
  nodeId: string,
): Promise<AuthorshipSpan[]> {
  return db
    .select()
    .from(authorshipSpans)
    .where(eq(authorshipSpans.nodeId, nodeId));
}

/**
 * Convert DB rows back to TipTap mark-compatible content array.
 * Returns an array of { from, to, attrs } suitable for applying marks.
 */
export function spansToMarkData(
  spans: AuthorshipSpan[],
): { from: number; to: number; attrs: Record<string, unknown> }[] {
  return spans.map((s) => ({
    from: s.fromPos,
    to: s.toPos,
    attrs: {
      source: s.source,
      model: s.model,
      chatMessageId: s.chatMsgId,
      timestamp: s.timestamp,
    },
  }));
}

// ── Internal helpers ───────────────────────────────────────────

function extractDbSpans(
  nodeId: string,
  doc: ProseMirrorNode,
): NewAuthorshipSpan[] {
  const spans: NewAuthorshipSpan[] = [];
  const now = new Date().toISOString();

  doc.descendants((node, pos) => {
    if (!node.isText) return;

    const len = node.text?.length ?? 0;
    const mark = node.marks.find((m) => m.type.name === "authorship");

    if (mark) {
      spans.push({
        id: crypto.randomUUID(),
        nodeId,
        fromPos: pos,
        toPos: pos + len,
        source: mark.attrs.source as AuthorshipSource,
        model: mark.attrs.model ?? null,
        chatMsgId: mark.attrs.chatMessageId ?? null,
        timestamp: mark.attrs.timestamp ?? now,
      });
    }
  });

  return spans;
}

/**
 * Save authorship spans with content hash (async version).
 */
export async function saveAuthorshipSpansWithHash(
  nodeId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  await db.delete(authorshipSpans).where(eq(authorshipSpans.nodeId, nodeId));

  const spans = extractDbSpans(nodeId, doc);
  if (spans.length === 0) return;

  await db.insert(authorshipSpans).values(spans);
}
