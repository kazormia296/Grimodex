import { provisionalBaseDay } from "@/../electron/shared/readDomain/features/chronicle/chronicleProvisionalDate";

/** 画面で新しく作る出来事の日と、その確度（CED/1 の N5）。 */
export interface ChronicleCreateDay {
  day: number;
  precision: "exact" | "unknown";
}

/**
 * 画面で作る出来事には、常に日時を入れる。順は、作者が選んだ位置、画面の中央
 * （年表が日付の表示で幅が測れているとき）、どちらも無ければ「最も後の日の翌日」
 * （年表にも場面にも日付が無ければ暦の起点の日）。最後の場合だけ、確度は「不明」。
 */
export function chronicleCreateDay(args: {
  selectedDay: number | null;
  viewCenterDay: number | null;
  events: Parameters<typeof provisionalBaseDay>[0];
  sceneDates: Parameters<typeof provisionalBaseDay>[1];
}): ChronicleCreateDay {
  const day = args.selectedDay ?? args.viewCenterDay;
  if (day != null) return { day, precision: "exact" };
  return {
    day: provisionalBaseDay(args.events, args.sceneDates),
    precision: "unknown",
  };
}
