/**
 * timeline_consistency の決定論的データ衛生チェック (純関数・LLM 不要)。
 *
 * story_time_order は fractional-index の TEXT キーで、辞書順比較で全順序を持つが
 * 大小差や「隙間」の概念は無い。よって決定論で誤検出ゼロに出せるのは構造的破綻だけ:
 *  - duplicate_order: 2 シーン以上が同一の story_time_order キーを共有 (順序が曖昧)。
 *  - malformed_order: 非 null だが空/空白のキー (異常データ)。
 *
 * 「読み順 vs 物語順の逆転」は回想など正当なケースが多く誤検出になるので扱わない
 * (それは LLM 側 timeline effect の領分)。この関数は in-session でユニットテスト可能な
 * 「ハイブリッドの検証可能な半分」(deferred な実 LLM 往復に依存しない)。
 */

export type TimelineHygieneKind = "duplicate_order" | "malformed_order";

export interface TimelineHygieneScene {
  id: string;
  title: string;
  storyTimeOrder: string | null;
}

export interface TimelineHygieneFinding {
  kind: TimelineHygieneKind;
  sceneId: string;
  sceneTitle: string;
  storyTimeOrder: string | null;
  /** duplicate_order のとき: 同一キーを共有する他シーンの id。 */
  conflictsWith?: string[];
}

export function detectTimelineHygiene(
  scenes: TimelineHygieneScene[],
): TimelineHygieneFinding[] {
  const findings: TimelineHygieneFinding[] = [];
  const byKey = new Map<string, TimelineHygieneScene[]>();

  for (const s of scenes) {
    // 未配置 (null) は時系列スコープ外。
    if (s.storyTimeOrder == null) continue;
    if (s.storyTimeOrder.trim() === "") {
      findings.push({
        kind: "malformed_order",
        sceneId: s.id,
        sceneTitle: s.title,
        storyTimeOrder: s.storyTimeOrder,
      });
      continue;
    }
    const arr = byKey.get(s.storyTimeOrder) ?? [];
    arr.push(s);
    byKey.set(s.storyTimeOrder, arr);
  }

  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    for (const s of group) {
      findings.push({
        kind: "duplicate_order",
        sceneId: s.id,
        sceneTitle: s.title,
        storyTimeOrder: key,
        conflictsWith: group.filter((g) => g.id !== s.id).map((g) => g.id),
      });
    }
  }

  return findings;
}
