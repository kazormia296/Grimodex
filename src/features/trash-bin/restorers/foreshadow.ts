/**
 * Foreshadow 復元 (設計書 §6, §16.6)。
 *
 * 新 ID 発行。foreshadowSetups は CASCADE で消えており、payload にも保持して
 * いないため復元しない。payoffSceneRef が現存しなければ broken-link として警告
 * したうえで payoffSceneId=null で再作成する。
 */
import { createForeshadow, updateForeshadow } from "@/features/foreshadow/api";
import { getNode } from "@/features/tree/api";
import type { ForeshadowLoadBearing } from "@/features/foreshadow/types";
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
  const newId = crypto.randomUUID();
  const brokenLinks: string[] = [];

  // payoffSceneRef の検証 (broken-link 検知。entity 自体は復元する。)
  let payoffSceneId: string | null = payload.payoffSceneRef;
  if (payoffSceneId) {
    const exists = await getNode(payoffSceneId);
    if (!exists) {
      payoffSceneId = null;
      brokenLinks.push("payoffScene");
    }
  }

  try {
    await createForeshadow({
      id: newId,
      projectId: options.projectId,
      title: payload.title,
      intent: payload.intent ?? null,
      loadBearing:
        (payload.loadBearing as ForeshadowLoadBearing | null) ?? null,
    });
    // notes / payoff* / state 軸は createForeshadow の payload 経由では渡せない
    // ため updateForeshadow で 2 段階に上書き。
    await updateForeshadow(newId, {
      notes: payload.notes ?? null,
      payoffSceneId,
      payoffFromPos: payload.payoffFromPos ?? null,
      payoffToPos: payload.payoffToPos ?? null,
      payoffConfirmed: payload.payoffConfirmed,
      abandoned: payload.abandoned,
    });
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
