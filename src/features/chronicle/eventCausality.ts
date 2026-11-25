import { hasChronicleDate } from "@/../electron/shared/readDomain/features/chronicle/chronicleSpan";
import type { EventRow } from "@/../electron/shared/readDomain/features/chronicle/eventRows";

export interface CausalRelation {
  /** 原因の出来事 id。 */
  causeId: string;
  /** 結果の出来事 id。 */
  effectId: string;
}

export interface CausalConflict {
  causeId: string;
  effectId: string;
  causeTime: number;
  effectTime: number;
}

/**
 * 因果エッジ(原因→結果)のうち「結果が原因より前(effectTime < causeTime)」の矛盾を
 * 検出する純関数。unknown／日時なしの event はスキップ(false-positive 回避)。
 * 決定性: 乱数/時刻なし。順序は (causeId, effectId) 昇順。
 */
export function findCausalityConflicts(args: {
  events: Pick<
    EventRow,
    "id" | "startTime" | "startGranularity" | "precision"
  >[];
  relations: CausalRelation[];
}): CausalConflict[] {
  const timeById = new Map<string, number>();
  for (const e of args.events) {
    if (
      e.precision !== "unknown" &&
      hasChronicleDate({
        startTime: e.startTime,
        startMinute: null,
        startGranularity: e.startGranularity,
      })
    ) {
      timeById.set(e.id, e.startTime!);
    }
  }
  const conflicts: CausalConflict[] = [];
  for (const r of args.relations) {
    const causeTime = timeById.get(r.causeId);
    const effectTime = timeById.get(r.effectId);
    if (causeTime == null || effectTime == null) continue;
    if (effectTime < causeTime) {
      conflicts.push({
        causeId: r.causeId,
        effectId: r.effectId,
        causeTime,
        effectTime,
      });
    }
  }
  conflicts.sort((a, b) =>
    a.causeId < b.causeId
      ? -1
      : a.causeId > b.causeId
        ? 1
        : a.effectId < b.effectId
          ? -1
          : a.effectId > b.effectId
            ? 1
            : 0,
  );
  return conflicts;
}

/** 因果矛盾に関与する eventId 集合(cause/effect 双方・マーカー警告用)。 */
export function causalIssueEventIds(conflicts: CausalConflict[]): Set<string> {
  const ids = new Set<string>();
  for (const c of conflicts) {
    ids.add(c.causeId);
    ids.add(c.effectId);
  }
  return ids;
}
