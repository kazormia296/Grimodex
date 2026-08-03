import { db } from "@/db/client";
import { authorshipSpans } from "@/db/schema";
import { eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { loadProjectAttributionStats } from "./projectStats";
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
export type AuthorshipOwnerLane =
  | { kind: "node"; nodeId: string }
  | { kind: "codex"; codexEntryId: string }
  | { kind: "snippet"; snippetId: string }
  | { kind: "detail"; detailValueId: string; codexEntryId: string }
  | { kind: "phase"; phaseId: string; codexEntryId: string };

function spanWithOwnerLane(
  lane: AuthorshipOwnerLane,
  span: Omit<
    NewAuthorshipSpan,
    "nodeId" | "codexEntryId" | "snippetId" | "detailValueId" | "phaseId"
  >,
): NewAuthorshipSpan {
  const base = { ...span };
  switch (lane.kind) {
    case "node":
      return { ...base, nodeId: lane.nodeId };
    case "codex":
      return { ...base, codexEntryId: lane.codexEntryId };
    case "snippet":
      return { ...base, snippetId: lane.snippetId };
    case "detail":
      return {
        ...base,
        detailValueId: lane.detailValueId,
        codexEntryId: lane.codexEntryId,
      };
    case "phase":
      return {
        ...base,
        phaseId: lane.phaseId,
        codexEntryId: lane.codexEntryId,
      };
  }
}

async function replaceAuthorshipSpansForLaneAtomic(
  lane: AuthorshipOwnerLane,
  spans: NewAuthorshipSpan[],
): Promise<void> {
  await invoke("authorship_replace_lane", {
    payload: {
      lane,
      spans: spans.map((span) => ({
        id: span.id ?? crypto.randomUUID(),
        fromPos: span.fromPos,
        toPos: span.toPos,
        source: span.source,
        model: span.model ?? null,
        timestamp: span.timestamp ?? null,
        chatMsgId: span.chatMsgId ?? null,
        traceId: span.traceId ?? null,
      })),
    },
  });
}

async function replaceAuthorshipSpansAtomic(
  nodeId: string,
  spans: NewAuthorshipSpan[],
): Promise<void> {
  await replaceAuthorshipSpansForLaneAtomic({ kind: "node", nodeId }, spans);
}

/**
 * Atomic replace helper for non-scene owner lanes (Codex/Snippet/Detail/Phase).
 * Plain TEXT uses synthetic [0,len] spans; PM JSON should be marked before extraction.
 */
export async function replaceOwnerLaneAuthorshipSpans(
  lane: AuthorshipOwnerLane,
  spans: Omit<
    NewAuthorshipSpan,
    "nodeId" | "codexEntryId" | "snippetId" | "detailValueId" | "phaseId"
  >[],
): Promise<void> {
  const now = new Date().toISOString();
  const rows = spans.map((s) =>
    spanWithOwnerLane(lane, {
      id: s.id ?? crypto.randomUUID(),
      fromPos: s.fromPos,
      toPos: s.toPos,
      source: s.source,
      model: s.model ?? null,
      chatMsgId: s.chatMsgId ?? null,
      traceId: s.traceId ?? null,
      timestamp: s.timestamp ?? now,
    }),
  );
  await replaceAuthorshipSpansForLaneAtomic(lane, rows);
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
 * Returns a map of nodeId → AI percentage. Empty scenes (total 0) are omitted.
 *
 * Attribution パネル (loadProjectAttributionStats) と同じ分母
 * (treeNodes.charCount、span 超過時は ai+unknown へ bump) に委譲する。
 * 以前はマーク付き span 合計を分母にしていたため、マーク無し本文
 * (帰属追跡導入前のテキスト等) が分母から抜け、フッター/Scenes バッジの
 * AI% がパネルより過大に表示されていた。
 */
export async function loadBatchAiRatio(
  nodeIds: string[],
): Promise<Record<string, number>> {
  if (nodeIds.length === 0) return {};

  const stats = await loadProjectAttributionStats(nodeIds);

  const result: Record<string, number> = {};
  for (const [id, st] of Object.entries(stats)) {
    if (st.total > 0) result[id] = Math.round((st.ai / st.total) * 100);
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
