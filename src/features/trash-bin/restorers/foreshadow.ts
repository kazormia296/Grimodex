/**
 * Foreshadow 復元 (設計書 §6, §16.6)。
 *
 * 新 ID 発行。foreshadowSetups は CASCADE で消えており、payload にも保持して
 * いないため復元しない。payoffSceneRef が現存しなければ broken-link として警告
 * したうえで payoffSceneId=null で再作成する。
 */
import { createForeshadow } from "@/features/foreshadow/api";
import { getNode } from "@/features/tree/api";
import type { ForeshadowLoadBearing } from "@/features/foreshadow/types";
import { isCreateResultEntityPresent } from "@/lib/createResultMetadata";
import type { ForeshadowPayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export interface ForeshadowRestoreOptions {
  projectId: string;
}

export async function restoreForeshadow(
  item: TrashItemData,
  options: ForeshadowRestoreOptions,
): Promise<RestoreOutcome> {
  if (item.subKind !== "foreshadow") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as ForeshadowPayload;
  // A persisted Trash row represents one logical restore. Deriving the new
  // entity/request identity from it keeps a lost-response retry crash-safe.
  const newId = `restored-foreshadow:${item.id}`;
  const brokenLinks: string[] = [];

  // payoffSceneRef の検証 (broken-link 検知。entity 自体は復元する。)
  let payoffSceneId: string | null = payload.payoffSceneRef;
  if (payoffSceneId) {
    const exists = await getNode(payoffSceneId);
    if (!exists || exists.projectId !== options.projectId) {
      payoffSceneId = null;
      brokenLinks.push("payoffScene");
    }
  }

  try {
    const created = await createForeshadow(
      {
        id: newId,
        projectId: options.projectId,
        title: payload.title,
        intent: payload.intent ?? null,
        notes: payload.notes ?? null,
        payoffSceneId,
        payoffFromPos: payoffSceneId ? (payload.payoffFromPos ?? null) : null,
        payoffToPos: payoffSceneId ? (payload.payoffToPos ?? null) : null,
        payoffConfirmed: payload.payoffConfirmed,
        abandoned: payload.abandoned,
        secret: payload.secret ?? true,
        loadBearing:
          (payload.loadBearing as ForeshadowLoadBearing | null) ?? null,
        codexLinkDirtyAt:
          payload.codexLinkDirtyAt == null
            ? null
            : new Date(payload.codexLinkDirtyAt),
      },
      { origin: "restore" },
    );
    if (!isCreateResultEntityPresent(created)) {
      throw new Error("foreshadow restore replay refers to a deleted entity");
    }
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // setups は復元できない旨を明示 (1 つでも setup があったかは payload 側で
  // 不明なので必ず警告に積む)
  brokenLinks.push("setups");
  return { ok: true, newId, brokenLinks };
}
