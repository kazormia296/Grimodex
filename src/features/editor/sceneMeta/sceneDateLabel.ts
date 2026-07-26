import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  formatChronicleDate,
  type ChronicleCalendar,
  type DateLang,
} from "@/features/chronicle/chronicleTime";

/**
 * シーンの作中日付チップ表示用ラベル。開始日付を粒度に応じて整形する。
 * 未設定（粒度 none / 日番号 null）は null。
 */
export function formatSceneDateLabel(
  node: TreeNodeData,
  cal: ChronicleCalendar,
  lang: DateLang,
): string | null {
  const granularity = node.chronicleStartGranularity ?? "none";
  if (granularity === "none" || node.chronicleStartTime == null) return null;
  const label = formatChronicleDate(
    node.chronicleStartTime,
    node.chronicleStartMinute ?? null,
    granularity,
    cal,
    lang,
  );
  return label || null;
}
