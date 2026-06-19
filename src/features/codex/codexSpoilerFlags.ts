import { useEffect, useMemo, useState } from "react";
import type {
  ForeshadowRow,
  ForeshadowWithLabel,
} from "@/features/foreshadow/types";
import { listForeshadowsByCodexEntry } from "@/features/foreshadow/api";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { usePhaseStore } from "./phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";

export interface UnrevealedForeshadow {
  id: string;
  title: string;
}

export function computeUnrevealedSecretForeshadows(
  linkedByEntry: Map<string, ForeshadowRow[]>,
  sceneOrder: Map<string, number>,
  currentSceneId: string | null,
): Map<string, UnrevealedForeshadow[]> {
  const out = new Map<string, UnrevealedForeshadow[]>();
  if (!currentSceneId) return out;
  const currentOrder = sceneOrder.get(currentSceneId);
  if (currentOrder === undefined) return out;

  for (const [entryId, foreshadows] of linkedByEntry) {
    const unrevealed: UnrevealedForeshadow[] = [];
    for (const f of foreshadows) {
      if (!f.secret || f.abandoned) continue;
      if (f.payoffSceneId == null) {
        // payoffConfirmed=true かつ scene 未設定 = orphan_payoff（回収済みだが位置不明）。
        // 回収済み＝開示済みとみなし警告しない。未確定のみ未回収＝未開示として扱う。
        if (!f.payoffConfirmed) unrevealed.push({ id: f.id, title: f.title });
        continue;
      }
      const payoffOrder = sceneOrder.get(f.payoffSceneId);
      if (payoffOrder === undefined || payoffOrder > currentOrder) {
        unrevealed.push({ id: f.id, title: f.title });
      }
    }
    if (unrevealed.length > 0) out.set(entryId, unrevealed);
  }
  return out;
}

export function useUnrevealedSecretForeshadows(
  entryIds: string[],
): Map<string, UnrevealedForeshadow[]> {
  const idsKey = entryIds.join("|");
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const [linkedByEntry, setLinkedByEntry] = useState<
    Record<string, ForeshadowWithLabel[]>
  >({});

  // 既存シグナルでのキャッシュ無効化: 伏線ストア (load() が更新ごとに items を
  // 差し替える正本) の、ネタバレ判定に関与するフィールドだけの指紋を購読する。
  // 秘匿/回収シーン/破棄/回収確定/タイトルの編集、およびプロジェクト切替
  // (items 全差し替え) で指紋が変わり、stale なキャッシュを破棄して再取得する。
  // entry id 単位の対応は取得して初めて判るため、変化時はキャッシュ全体を捨てる
  // (指紋が実際に変わった時だけ走るので過剰購読にはならない)。
  const spoilerFingerprint = useForeshadowStore((s) =>
    s.items
      .map(
        (f) =>
          `${f.id}:${f.secret ? 1 : 0}:${f.payoffSceneId ?? ""}:${
            f.abandoned ? 1 : 0
          }:${f.payoffConfirmed ? 1 : 0}:${f.title}`,
      )
      .join("|"),
  );

  useEffect(() => {
    // 指紋が変われば既存キャッシュを破棄し、下の取得 effect に再取得させる。
    setLinkedByEntry({});
  }, [spoilerFingerprint]);

  useEffect(() => {
    let cancelled = false;
    const ids = idsKey ? idsKey.split("|") : [];
    const missing = ids.filter((id) => !(id in linkedByEntry));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (id) => {
        try {
          return [id, await listForeshadowsByCodexEntry(id)] as const;
        } catch {
          // 取得失敗は空配列としてキャッシュ（read-only バッジのため再試行せず、
          // 失敗時はその行の警告を出さない＝安全側）。
          return [id, [] as ForeshadowWithLabel[]] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setLinkedByEntry((prev) => {
        const next = { ...prev };
        for (const [id, fs] of pairs) next[id] = fs;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey, linkedByEntry]);

  return useMemo(() => {
    const idSet = new Set(idsKey ? idsKey.split("|") : []);
    const map = new Map<string, ForeshadowWithLabel[]>();
    for (const id of idSet) map.set(id, linkedByEntry[id] ?? []);
    return computeUnrevealedSecretForeshadows(
      map,
      globalSceneOrder,
      activeSceneId || null,
    );
  }, [idsKey, linkedByEntry, globalSceneOrder, activeSceneId]);
}
