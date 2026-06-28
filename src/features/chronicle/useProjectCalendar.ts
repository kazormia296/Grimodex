import { useEffect, useState } from "react";
import type { ChronicleCalendar } from "./chronicleTime";
import { getProjectCalendar, calendarFromRow } from "./api";

/**
 * プロジェクトの暦をロードして ChronicleCalendar に整形する軽量フック。
 * useSeasonConflicts と同じパース経路（calendarFromRow）を使う。矛盾検出は行わず
 * 日付エディタ用の暦だけが欲しい呼び出し元（SceneDateEditor）向け。
 * 暦未設定/未ロード時は calendar=null。
 */
export function useProjectCalendar(projectId: string | null): {
  calendar: ChronicleCalendar | null;
} {
  const [calendar, setCalendar] = useState<ChronicleCalendar | null>(null);

  useEffect(() => {
    if (!projectId) {
      setCalendar(null);
      return;
    }
    let cancelled = false;
    getProjectCalendar(projectId)
      .then((row) => {
        if (cancelled) return;
        setCalendar(row ? calendarFromRow(row) : null);
      })
      .catch(() => {
        if (!cancelled) setCalendar(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { calendar };
}
