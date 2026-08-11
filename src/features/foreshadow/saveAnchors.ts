import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { foreshadows, foreshadowSetups } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// Shape returned by extract helpers (subset of NewForeshadowSetup)
export interface SetupAnchorExtract {
  id: string; // setupId from mark
  foreshadowId: string;
  sceneId: string;
  fromPos: number;
  toPos: number;
}

export interface PayoffAnchorExtract {
  foreshadowId: string;
  sceneId: string;
  fromPos: number;
  toPos: number;
}

function isTauriRuntime(): boolean {
  // Keep tests on invoke path (they mock invoke payloads directly).
  if (typeof process !== "undefined" && process.env?.VITEST) return true;
  if (typeof window === "undefined") return false;
  // ネイティブ backend（Tauri `__TAURI_INTERNALS__` / Electron `"grimodex"` =
  // isElectron 相当）はどちらも invoke 経由。Electron 移行 Phase 3 バッチ1で
  // Electron を napi パスに載せる（api.ts と同判定 / src/lib/shell.ts と整合）。
  return "__TAURI_INTERNALS__" in window || "grimodex" in window;
}

// ── Extraction helpers (pure, no DB) ─────────────────────────────

export function extractSetupAnchors(
  sceneId: string,
  doc: ProseMirrorNode,
): SetupAnchorExtract[] {
  const result: SetupAnchorExtract[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "foreshadowSetup");
    if (!mark) return;
    const { setupId, foreshadowId } = mark.attrs as {
      setupId: string;
      foreshadowId: string;
    };
    if (!setupId || !foreshadowId) return;
    const len = node.text?.length ?? 0;
    result.push({
      id: setupId,
      foreshadowId,
      sceneId,
      fromPos: pos,
      toPos: pos + len,
    });
  });
  return result;
}

export function extractPayoffAnchors(
  sceneId: string,
  doc: ProseMirrorNode,
): PayoffAnchorExtract[] {
  const result: PayoffAnchorExtract[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "foreshadowPayoff");
    if (!mark) return;
    const { foreshadowId } = mark.attrs as { foreshadowId: string };
    if (!foreshadowId) return;
    const len = node.text?.length ?? 0;
    result.push({ foreshadowId, sceneId, fromPos: pos, toPos: pos + len });
  });
  return result;
}

// ── Save helpers (DB write) ───────────────────────────────────────

/**
 * Persist foreshadow anchors for a scene.
 *
 * Setup rows: UPSERT by id to preserve metadata (strength, aiStrength, etc.)
 * Payoff anchor: inline update on the foreshadows row itself
 *
 * Uses db_execute_batch to run all statements in a single SQLite transaction
 * (drizzle sqlite-proxy does not expose transactions natively).
 */
export async function saveForeshadowAnchors(
  sceneId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  // Extract first. 大多数のシーンは伏線マークを持たないため、両方空なら FK sweep
  // 用の全件 SELECT(SELECT id FROM foreshadows) はフィルタ対象が無く結果が使われない
  // → スキップする。空配列のまま invoke は続行するので、Rust 側の orphan sweep
  // (このシーンの既存 setup を isOrphan 化) は従来どおり走る（所見#8）。
  // ※「両方空なら早期 return」は scene-clear 時の orphan sweep を飛ばすため不可。
  const rawSetups = extractSetupAnchors(sceneId, doc);
  const rawPayoffs = extractPayoffAnchors(sceneId, doc);

  let setups = rawSetups;
  let payoffs = rawPayoffs;
  if (rawSetups.length > 0 || rawPayoffs.length > 0) {
    // FK sweep: filter out marks whose foreshadowId no longer exists in DB.
    // Prevents FK constraint violation when a foreshadow is deleted while marks remain in doc.
    const validIds = new Set(
      (await db.select({ id: foreshadows.id }).from(foreshadows)).map(
        (r) => r.id,
      ),
    );
    setups = rawSetups.filter((s) => validIds.has(s.foreshadowId));
    payoffs = rawPayoffs.filter((p) => validIds.has(p.foreshadowId));
  }

  if (isTauriRuntime()) {
    await invoke("foreshadow_save_anchors_for_scene", {
      sceneId,
      setups: setups.map((s) => ({
        id: s.id,
        foreshadowId: s.foreshadowId,
        sceneId: s.sceneId,
        fromPos: s.fromPos,
        toPos: s.toPos,
      })),
      payoffs: payoffs.map((p) => ({
        foreshadowId: p.foreshadowId,
        sceneId: p.sceneId,
        fromPos: p.fromPos,
        toPos: p.toPos,
      })),
      docContentSize: doc.content.size,
    });
    return;
  }

  throw new Error(
    "foreshadow_save_anchors_for_scene requires native backend (Tauri/Electron)",
  );
}

/**
 * Clear all foreshadow marks from a scene's doc on load.
 * DB is the authority; marks are applied fresh via loadForeshadowAnchors.
 * This prevents stale marks (e.g. from copy-paste or crashes) from persisting.
 */
export function clearAllForeshadowMarks(
  applyTr: (fn: (tr: import("@tiptap/pm/state").Transaction) => void) => void,
): void {
  applyTr((tr) => {
    const docSize = tr.doc.content.size;
    if (docSize <= 2) return;
    const setupType = tr.doc.type.schema.marks["foreshadowSetup"];
    const payoffType = tr.doc.type.schema.marks["foreshadowPayoff"];
    if (setupType) tr.removeMark(1, docSize - 1, setupType);
    if (payoffType) tr.removeMark(1, docSize - 1, payoffType);
  });
}

/**
 * Remove foreshadowPayoff marks whose foreshadowId is in the given set.
 * Used when a payoff anchor is released on a currently-open scene.
 */
export function unsetForeshadowPayoffMarksByForeshadowIds(
  applyTr: (fn: (tr: import("@tiptap/pm/state").Transaction) => void) => void,
  foreshadowIds: string[],
): void {
  if (foreshadowIds.length === 0) return;
  const idSet = new Set(foreshadowIds);
  applyTr((tr) => {
    const payoffType = tr.doc.type.schema.marks["foreshadowPayoff"];
    if (!payoffType) return;
    const toRemove: { from: number; to: number }[] = [];
    tr.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type === payoffType);
      if (mark && idSet.has(mark.attrs.foreshadowId as string)) {
        toRemove.push({ from: pos, to: pos + node.nodeSize });
      }
    });
    for (const { from, to } of toRemove) {
      tr.removeMark(from, to, payoffType);
    }
  });
}

// ── Load helpers (DB read → mark data) ───────────────────────────

export interface MarkApplication {
  from: number;
  to: number;
  markName: "foreshadowSetup" | "foreshadowPayoff";
  attrs: Record<string, unknown>;
}

export async function loadForeshadowAnchors(
  sceneId: string,
): Promise<MarkApplication[]> {
  if (isTauriRuntime()) {
    return invoke<MarkApplication[]>("foreshadow_load_anchors_for_scene", {
      sceneId,
    });
  }

  const result: MarkApplication[] = [];

  const setups = await db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.sceneId, sceneId));

  for (const s of setups) {
    if (s.isOrphan) continue;
    result.push({
      from: s.fromPos,
      to: s.toPos,
      markName: "foreshadowSetup",
      attrs: { setupId: s.id, foreshadowId: s.foreshadowId },
    });
  }

  const payoffs = await db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.payoffSceneId, sceneId));

  for (const f of payoffs) {
    if (f.payoffFromPos == null || f.payoffToPos == null) continue;
    result.push({
      from: f.payoffFromPos,
      to: f.payoffToPos,
      markName: "foreshadowPayoff",
      attrs: { foreshadowId: f.id },
    });
  }

  return result;
}
