/**
 * Pin (SceneCodexPin) 復元 (設計書 §6, §16.7 改)。
 *
 * Pin は Scene と Codex Entry の join 行。両端が現存しなければ復元できない。
 * 一致チェックは payload の sceneId/entryId が今も DB に存在するかで判定。
 */
import { upsertScenePin } from "@/features/codex/sceneCodexPinsApi";
import { getNode } from "@/features/tree/api";
import { getCodexEntry } from "@/features/codex/api";
import type { PinPayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export async function restorePin(item: TrashItemData): Promise<RestoreOutcome> {
  if (item.subKind !== "pin") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as PinPayload;
  const brokenLinks: string[] = [];

  const [scene, entry] = await Promise.all([
    getNode(payload.sceneId),
    getCodexEntry(payload.entryId),
  ]);
  if (!scene) brokenLinks.push("scene");
  if (!entry) brokenLinks.push("entry");
  if (!scene || !entry) {
    return {
      ok: false,
      reason: "no-target",
      message: "scene or codex entry no longer exists",
    };
  }

  try {
    await upsertScenePin(payload.sceneId, payload.entryId);
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // pin は composite PK なので「新 ID」は (sceneId, entryId) のペア。
  // RestoreResult.newId は便宜的に entryId を返す (UI ハイライト用)。
  return { ok: true, newId: payload.entryId, brokenLinks };
}
