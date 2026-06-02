import { db } from "@/db/client";
import { authorshipSpans } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import type { NewAuthorshipSpan, AuthorshipSpan } from "@/db/schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AuthorshipSource } from "./AuthorshipMark";
import { markStart, markEnd } from "@/lib/perfLog";

/**
 * 既存 spans の DELETE と新 spans の INSERT を 1 トランザクションで実行する。
 *
 * 以前は `db.delete(...)` と `db.insert(...)` を別々の IPC で行っていたため、両者の
 * 間でクラッシュ/失敗すると spans が削除されたまま再挿入されず、そのシーンの帰属
 * メタデータが全損する atomicity バグがあった。db_execute_batch(Rust 側 execute_batch_tx
 * = BEGIN..COMMIT)で原子化する。SQL は drizzle のクエリビルダ .toSQL() から生成し、
 * 生 SQL を手書きしない（規約準拠）。spans が空でも DELETE は実行し、scene-clear 時の
 * 既存 spans 掃除を保つ。
 */
async function replaceAuthorshipSpansAtomic(
  nodeId: string,
  spans: NewAuthorshipSpan[],
): Promise<void> {
  const del = db
    .delete(authorshipSpans)
    .where(eq(authorshipSpans.nodeId, nodeId))
    .toSQL();
  const statements: { sql: string; params: unknown[]; method: string }[] = [
    { sql: del.sql, params: del.params, method: "run" },
  ];
  if (spans.length > 0) {
    const ins = db.insert(authorshipSpans).values(spans).toSQL();
    statements.push({ sql: ins.sql, params: ins.params, method: "run" });
  }
  await invoke("db_execute_batch", { statements });
}

/**
 * Save authorship spans from a ProseMirror document to the database.
 * Replaces all existing spans for the given node (DELETE+INSERT を 1 tx で原子的に).
 */
export async function saveAuthorshipSpans(
  nodeId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  markStart("saveAuthorship.extract");
  const spans = extractDbSpans(nodeId, doc);
  markEnd("saveAuthorship.extract");
  // span 件数を topMarks に露出させて、fix 戦略の判断材料にする
  markStart(`saveAuthorship.spanCount.${spans.length}`);
  markEnd(`saveAuthorship.spanCount.${spans.length}`);

  markStart("saveAuthorship.replaceAtomic");
  await replaceAuthorshipSpansAtomic(nodeId, spans);
  markEnd("saveAuthorship.replaceAtomic");
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
      traceId: s.traceId,
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
        traceId: mark.attrs.traceId ?? null,
        timestamp: mark.attrs.timestamp ?? now,
      });
    }
  });

  return spans;
}

/**
 * Batch-compute AI attribution ratio (0–100 integer) per scene node.
 * Returns a map of nodeId → AI percentage. Nodes with no spans are omitted.
 */
export async function loadBatchAiRatio(
  nodeIds: string[],
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {};

  const spans = await db
    .select()
    .from(authorshipSpans)
    .where(inArray(authorshipSpans.nodeId, nodeIds));

  // Aggregate per node
  const totals: Record<string, { ai: number; total: number }> = {};
  for (const span of spans) {
    const id = span.nodeId;
    if (!id) continue;
    const len = span.toPos - span.fromPos;
    if (!totals[id]) totals[id] = { ai: 0, total: 0 };
    totals[id].total += len;
    if (span.source === "ai") totals[id].ai += len;
  }

  const result: Record<string, number> = {};
  for (const [id, { ai, total }] of Object.entries(totals)) {
    if (total > 0) result[id] = Math.round((ai / total) * 100);
  }
  return result;
}

/**
 * Save authorship spans with content hash (async version).
 */
export async function saveAuthorshipSpansWithHash(
  nodeId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  const spans = extractDbSpans(nodeId, doc);
  await replaceAuthorshipSpansAtomic(nodeId, spans);
}
