import { useEffect, useMemo, useState } from "react";
import type {
  ForeshadowRow,
  ForeshadowWithLabel,
} from "@/features/foreshadow/types";
import { listForeshadowsByCodexEntry } from "@/features/foreshadow/api";
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
        unrevealed.push({ id: f.id, title: f.title });
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
