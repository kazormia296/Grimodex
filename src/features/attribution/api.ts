import { db } from "@/db/client";
import { authorshipSpans } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { NewAuthorshipSpan, AuthorshipSpan } from "@/db/schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AuthorshipSource } from "./AuthorshipMark";
import { sha256 } from "./agentTrace";

/**
 * Save authorship spans from a ProseMirror document to the database.
 * Replaces all existing spans for the given scene.
 */
export async function saveAuthorshipSpans(
  sceneId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  // Delete existing spans for this scene
  await db.delete(authorshipSpans).where(eq(authorshipSpans.sceneId, sceneId));

  // Extract spans from document
  const spans = extractDbSpans(sceneId, doc);
  if (spans.length === 0) return;

  // Batch insert
  await db.insert(authorshipSpans).values(spans);
}

/**
 * Load authorship spans from the database for a given scene.
 */
export async function loadAuthorshipSpans(
  sceneId: string,
): Promise<AuthorshipSpan[]> {
  return db
    .select()
    .from(authorshipSpans)
    .where(eq(authorshipSpans.sceneId, sceneId));
}

/**
 * Convert DB rows back to TipTap mark-compatible content array.
 * Returns an array of { from, to, attrs } suitable for applying marks.
 */
export function spansToMarkData(
  spans: AuthorshipSpan[],
): { from: number; to: number; attrs: Record<string, unknown> }[] {
  return spans.map((s) => ({
    from: s.offsetStart,
    to: s.offsetEnd,
    attrs: {
      source: s.source,
      model: s.model,
      chatMessageId: s.aiMessageId,
      traceId: s.traceId,
      toolName: s.toolName,
      toolVersion: s.toolVersion,
      manualOverride: s.manualOverride === 1,
      timestamp: s.createdAt,
    },
  }));
}

// ── Internal helpers ───────────────────────────────────────────

function extractDbSpans(
  sceneId: string,
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
        sceneId,
        offsetStart: pos,
        offsetEnd: pos + len,
        source: mark.attrs.source as AuthorshipSource,
        traceId: mark.attrs.traceId ?? null,
        model: mark.attrs.model ?? null,
        aiMessageId: mark.attrs.chatMessageId ?? null,
        manualOverride: mark.attrs.manualOverride ? 1 : 0,
        contentHash: null, // Populated below
        toolName: mark.attrs.toolName ?? null,
        toolVersion: mark.attrs.toolVersion ?? null,
        createdAt: mark.attrs.timestamp ?? now,
      });
    }
  });

  return spans;
}

/**
 * Save authorship spans with content hash (async version).
 * Use this when you need the content hash for Agent Trace compliance.
 */
export async function saveAuthorshipSpansWithHash(
  sceneId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  await db.delete(authorshipSpans).where(eq(authorshipSpans.sceneId, sceneId));

  const spans = extractDbSpans(sceneId, doc);
  if (spans.length === 0) return;

  const contentHash = await sha256(doc.textContent);
  const spansWithHash = spans.map((s) => ({ ...s, contentHash }));

  await db.insert(authorshipSpans).values(spansWithHash);
}
