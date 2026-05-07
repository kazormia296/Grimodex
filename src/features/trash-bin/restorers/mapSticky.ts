/**
 * Map Sticky 復元 (設計書 §6, §16.5)。
 *
 * 新 ID 発行。boardId が現存しなければ rejected。座標はドロップ位置上書き
 * (Map ペイン D&D) または payload の元位置のいずれか。
 */
import { createSticky } from "@/features/map/mapApi";
import { db } from "@/db/client";
import { mapBoards } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { MapStickyPayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export interface MapStickyRestoreOptions {
  /** ドロップされた board (Map ペイン上で開いているボード) */
  boardIdOverride?: string;
  /** ドロップ点 (flow 座標)。未指定なら payload の元位置を使う。 */
  dropX?: number;
  dropY?: number;
}

async function boardExists(boardId: string): Promise<boolean> {
  const rows = await db
    .select({ id: mapBoards.id })
    .from(mapBoards)
    .where(eq(mapBoards.id, boardId))
    .limit(1);
  return rows.length > 0;
}

export async function restoreMapSticky(
  item: TrashItemData,
  options: MapStickyRestoreOptions,
): Promise<RestoreOutcome> {
  if (item.subKind !== "map-sticky") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as MapStickyPayload;
  const brokenLinks: string[] = [];

  // boardId は (drop 先 > payload の元) の優先順で解決
  let boardId = options.boardIdOverride ?? payload.boardId;
  if (!(await boardExists(boardId))) {
    if (
      options.boardIdOverride &&
      options.boardIdOverride !== payload.boardId
    ) {
      // override が無効なら設計書 §6-C に従いルート相当の挙動 = 失敗
      return { ok: false, reason: "no-target", message: "boardId not found" };
    }
    // payload の元 board が消えているならフォールバック失敗
    return {
      ok: false,
      reason: "no-target",
      message: "original board missing",
    };
  }
  if (boardId !== payload.boardId) brokenLinks.push("board");

  const x = options.dropX ?? payload.x;
  const y = options.dropY ?? payload.y;

  try {
    const result = await createSticky({
      boardId,
      x,
      y,
      paletteId: payload.paletteId,
      colorSlot: payload.colorSlot,
      title: payload.title ?? undefined,
      body: payload.body,
    });
    return { ok: true, newId: result.sticky.id, brokenLinks };
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
