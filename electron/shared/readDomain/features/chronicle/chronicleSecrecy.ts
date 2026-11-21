import type {
  EventRow,
  ParticipantRow,
  EventRelationRow,
  SceneEventRow,
} from "./api";

/**
 * 作中年表イベントの AI 秘匿（reveal アンカー方式）。
 *
 * 設計: docs/superpowers/specs/2026-06-29-chronicle-event-secrecy-design.md
 *
 * 伏線(foreshadows.secret)と同理由でイベントを AI 文脈から除外する。ただし年表は
 * **読む順(reading order)** 軸で開示が起こる点が伏線と異なる:
 *   - fabula 軸(ordinal/atOrBefore)は「いつ起きたか」。裏設定は常に過去なので守れない。
 *   - reading order 軸は「読者がどこまで知ったか」。開示はこの軸で起こる。
 *
 * `secret=true` のイベントは、現在書いているシーンが reveal シーン**より前**の間だけ
 * AI から隠す。reveal は明示上書き(`reveal_scene_id`)が無ければ「読む順で最初に
 * スタンプされたシーン」から動的に導出する(初出シーンで自動開示)。reveal が無ければ
 * 恒久秘匿。fabula の ordinal とは別軸であることに注意。
 */

/** sceneId → 読む順 index(0-based・小さいほど前方)。computeGlobalSceneOrder の出力。 */
export type ReadingOrder = Map<string, number>;

/** 秘匿判定に必要な最小イベント形（EventRow も満たす）。 */
type SecrecyEvent = Pick<EventRow, "id" | "secret" | "revealSceneId">;

/** 読む順 index。未知シーンは +Infinity(fail-safe で「前方」扱いされない)。 */
export function readingPos(order: ReadingOrder, sceneId: string): number {
  return order.get(sceneId) ?? Number.POSITIVE_INFINITY;
}

/**
 * 開示アンカーの effective 値(動的算出)。
 *  - 明示 `revealSceneId` があればそれ(作者上書き)。
 *  - 無ければ「読む順 index が最小のスタンプ済シーン」(初出シーン)。
 *    scene_events の INSERT 順ではなく readingOrder 上の最小を取る。
 *  - スタンプ無し / すべて order 外 → null(恒久秘匿)。
 */
export function effectiveRevealSceneId(
  event: SecrecyEvent,
  sceneEvents: SceneEventRow[],
  readingOrder: ReadingOrder,
): string | null {
  if (event.revealSceneId != null) return event.revealSceneId;
  let best: string | null = null;
  let bestPos = Number.POSITIVE_INFINITY;
  for (const se of sceneEvents) {
    if (se.eventId !== event.id) continue;
    const pos = readingPos(readingOrder, se.sceneId);
    if (pos < bestPos) {
      bestPos = pos;
      best = se.sceneId;
    }
  }
  return best;
}

/**
 * 現在シーン `currentSceneId` を書く文脈で、イベントを AI から隠すべきか。
 * `readingPos(current) < readingPos(reveal)` のときだけ隠す(reveal 章以降は開示)。
 *
 * fail-closed:
 *  - secret=false → 常に表示。
 *  - 現在シーンが reading order に無い → 隠す(位置不明で開示しない)。
 *  - effective reveal が null → 隠す(恒久秘匿)。
 *  - reveal シーンが reading order に無い → 隠す(`∞ < finite` の事故開示を has() で遮断)。
 */
export function isEventHiddenFromAi(
  event: SecrecyEvent,
  currentSceneId: string,
  ctx: { readingOrder: ReadingOrder; sceneEvents: SceneEventRow[] },
): boolean {
  if (!event.secret) return false;
  if (!currentSceneId || !ctx.readingOrder.has(currentSceneId)) return true;
  const reveal = effectiveRevealSceneId(
    event,
    ctx.sceneEvents,
    ctx.readingOrder,
  );
  if (reveal == null) return true;
  if (!ctx.readingOrder.has(reveal)) return true;
  return (
    readingPos(ctx.readingOrder, currentSceneId) <
    readingPos(ctx.readingOrder, reveal)
  );
}

export interface VisibleChronicle {
  events: EventRow[];
  sceneEvents: SceneEventRow[];
  participants: ParticipantRow[];
  relations: EventRelationRow[];
  /** 可視イベント id 集合(下流の二次フィルタ用)。 */
  visibleEventIds: Set<string>;
}

/**
 * AI 向けに「可視 projection」を作る(spec §2.4.1)。
 * derive/anchor/pick の **前段** で events を絞り、scene_events / participants /
 * relations も連動フィルタする。これにより
 *  - secret event が anchor を決める
 *  - secret event の participant から人物が snapshot に載る
 *  - relation 経由で相手イベントのタイトルが漏れる
 * といった二次漏洩を一括で塞ぐ。relation は cause/effect の **どちらかが hidden** なら
 * ペアごと完全省略(部分マスクしない・伏線と同じ完全除外原則)。
 *
 * raw `sceneEvents` から effective reveal を算出するため、hidden 判定には引数の
 * (フィルタ前)sceneEvents をそのまま使う。
 */
export function projectVisibleChronicle(args: {
  events: EventRow[];
  sceneEvents: SceneEventRow[];
  participants: ParticipantRow[];
  relations: EventRelationRow[];
  currentSceneId: string;
  readingOrder: ReadingOrder;
}): VisibleChronicle {
  const { events, sceneEvents, participants, relations } = args;
  const ctx = { readingOrder: args.readingOrder, sceneEvents };
  const visibleEventIds = new Set(
    events
      .filter((e) => !isEventHiddenFromAi(e, args.currentSceneId, ctx))
      .map((e) => e.id),
  );
  return {
    events: events.filter((e) => visibleEventIds.has(e.id)),
    sceneEvents: sceneEvents.filter((se) => visibleEventIds.has(se.eventId)),
    participants: participants.filter((p) => visibleEventIds.has(p.eventId)),
    relations: relations.filter(
      (r) => visibleEventIds.has(r.causeId) && visibleEventIds.has(r.effectId),
    ),
    visibleEventIds,
  };
}
