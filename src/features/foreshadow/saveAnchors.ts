import { invoke } from "@tauri-apps/api/core";
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
  // FK sweep: filter out marks whose foreshadowId no longer exists in DB.
  // Prevents FK constraint violation when a foreshadow is deleted while marks remain in doc.
  const validIds = new Set(
    (await db.select({ id: foreshadows.id }).from(foreshadows)).map(
      (r) => r.id,
    ),
  );
  const setups = extractSetupAnchors(sceneId, doc).filter((s) =>
    validIds.has(s.foreshadowId),
  );
  const payoffs = extractPayoffAnchors(sceneId, doc).filter((p) =>
    validIds.has(p.foreshadowId),
  );

  // Collect UPSERT statements for setup anchors
  type Statement = { sql: string; params: unknown[]; method: string };
  const statements: Statement[] = [];

  const now = Date.now();

  for (const s of setups) {
    // UPSERT: insert or update positions only (preserve metadata like strength)
    statements.push({
      sql: `INSERT INTO foreshadow_setups
              (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution, is_orphan, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', 0, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              from_pos   = excluded.from_pos,
              to_pos     = excluded.to_pos,
              is_orphan  = 0,
              updated_at = excluded.updated_at`,
      params: [s.id, s.foreshadowId, s.sceneId, s.fromPos, s.toPos, now, now],
      method: "run",
    });
  }

  // Update payoff anchor positions on foreshadows rows
  for (const p of payoffs) {
    statements.push({
      sql: `UPDATE foreshadows
            SET payoff_scene_id = ?, payoff_from_pos = ?, payoff_to_pos = ?, updated_at = ?
            WHERE id = ?`,
      params: [p.sceneId, p.fromPos, p.toPos, now, p.foreshadowId],
      method: "run",
    });
  }

  // Mark setups in this scene that are no longer anchored as orphans
  const currentSetupIds = setups.map((s) => s.id);
  if (currentSetupIds.length > 0) {
    const placeholders = currentSetupIds.map(() => "?").join(", ");
    statements.push({
      sql: `UPDATE foreshadow_setups
            SET is_orphan = 1, updated_at = ?
            WHERE scene_id = ? AND id NOT IN (${placeholders})`,
      params: [now, sceneId, ...currentSetupIds],
      method: "run",
    });
  } else {
    statements.push({
      sql: `UPDATE foreshadow_setups SET is_orphan = 1, updated_at = ? WHERE scene_id = ?`,
      params: [now, sceneId],
      method: "run",
    });
  }

  if (statements.length === 0) return;

  await invoke("db_execute_batch", { statements });
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
  const result: MarkApplication[] = [];

  // Load setup anchors
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

  // Load payoff anchors (inline on foreshadows table)
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
