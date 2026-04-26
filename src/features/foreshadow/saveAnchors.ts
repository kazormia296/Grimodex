import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { foreshadows } from "@/db/schema";
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
  });
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
  return invoke<MarkApplication[]>("foreshadow_load_anchors_for_scene", {
    sceneId,
  });
}
