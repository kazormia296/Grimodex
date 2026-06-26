export interface TwoPlacesConflict {
  eventA: string;
  eventB: string;
  codexId: string;
  locationA: string;
  locationB: string;
}

interface TwoPlacesInputEvent {
  id: string;
  primaryCodexId: string | null;
  startTime: number | null;
  endTime: number | null;
  locationCodexId: string | null;
}

/**
 * 「同一人物が同時刻に別の場所にいる」矛盾を検出する純関数。
 * 対象 = primaryCodexId・startTime・endTime・locationCodexId が全て揃う区間 event。
 * 重なり判定は strict（max(start) < min(end)）＝接点のみ(連続移動)は矛盾としない。
 * 決定性: ペアは (eventA, eventB) 昇順、各ペア eventA < eventB。
 */
export function findTwoPlacesConflicts(args: {
  events: TwoPlacesInputEvent[];
}): TwoPlacesConflict[] {
  const candidates = args.events.filter(
    (e) =>
      e.primaryCodexId != null &&
      e.startTime != null &&
      e.endTime != null &&
      e.locationCodexId != null,
  );

  const byCodex = new Map<string, TwoPlacesInputEvent[]>();
  for (const e of candidates) {
    const arr = byCodex.get(e.primaryCodexId as string);
    if (arr) arr.push(e);
    else byCodex.set(e.primaryCodexId as string, [e]);
  }

  const conflicts: TwoPlacesConflict[] = [];
  for (const [codexId, evs] of byCodex) {
    const sorted = [...evs].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.locationCodexId === b.locationCodexId) continue;
        const overlap =
          Math.max(a.startTime as number, b.startTime as number) <
          Math.min(a.endTime as number, b.endTime as number);
        if (!overlap) continue;
        conflicts.push({
          eventA: a.id,
          eventB: b.id,
          codexId,
          locationA: a.locationCodexId as string,
          locationB: b.locationCodexId as string,
        });
      }
    }
  }
  conflicts.sort((p, q) =>
    p.eventA < q.eventA
      ? -1
      : p.eventA > q.eventA
        ? 1
        : p.eventB < q.eventB
          ? -1
          : p.eventB > q.eventB
            ? 1
            : 0,
  );
  return conflicts;
}

/** 2か所同時矛盾に関与する eventId 集合（マーカー警告用）。 */
export function twoPlacesEventIds(conflicts: TwoPlacesConflict[]): Set<string> {
  const ids = new Set<string>();
  for (const c of conflicts) {
    ids.add(c.eventA);
    ids.add(c.eventB);
  }
  return ids;
}
