/**
 * 「Codex に昇格しますか？」プロンプトの発火判定 (柔→硬の橋渡し)。
 *
 * 設計 (ユーザー合意): エピソード recall が同じ過去発言を何度も引くなら、それは
 * 恒久的な事実 (Codex = 硬い層) に昇格する価値があるサイン。ただし canon 化は
 * 必ず人が確認する — ここは「閾値を超えたら既存の抽出 UI を促す」トリガーだけを
 * 担い、自動で書き込むことは一切しない (recall-only を保つ)。
 *
 * 状態は in-memory・セッション単位 (リロード/セッション切替でリセット)。同じ発言を
 * 1 ターンで二重カウントしない。dismiss された発言は二度と提案しない。
 */

/** この回数 recall されたら昇格を提案する (per-session)。 */
export const CHAT_RECALL_PROMOTE_THRESHOLD = 3;

export interface RecallPromoteState {
  /** messageId -> 累積 recall 回数 (このセッション内)。 */
  freq: Map<string, number>;
  /** ユーザーが「後で」を選んだ messageId (再提案しない)。 */
  dismissed: Set<string>;
}

export interface RecallPromoteSuggestion {
  messageId: string;
  text: string;
}

export function createRecallPromoteTracker(): RecallPromoteState {
  return { freq: new Map(), dismissed: new Set() };
}

/**
 * 1 ターン分の recall 結果を記録し、閾値到達 & 未 dismiss の最初の 1 件を昇格候補
 * として返す (無ければ null)。同じ messageId はこのターンで二重カウントしない。
 */
export function trackRecallForPromote(
  state: RecallPromoteState,
  messages: Array<{ messageId: string; text: string }>,
): RecallPromoteSuggestion | null {
  let suggestion: RecallPromoteSuggestion | null = null;
  const seenThisTurn = new Set<string>();
  for (const m of messages) {
    if (seenThisTurn.has(m.messageId)) continue;
    seenThisTurn.add(m.messageId);
    if (state.dismissed.has(m.messageId)) continue;
    const next = (state.freq.get(m.messageId) ?? 0) + 1;
    state.freq.set(m.messageId, next);
    if (next >= CHAT_RECALL_PROMOTE_THRESHOLD && !suggestion) {
      suggestion = { messageId: m.messageId, text: m.text };
    }
  }
  return suggestion;
}

/** 「後で」: 以後この発言を提案しない。頻度カウントも捨てる。 */
export function dismissRecallPromote(
  state: RecallPromoteState,
  messageId: string,
): void {
  state.dismissed.add(messageId);
  state.freq.delete(messageId);
}

/** セッション切替/リセット時に履歴を空に戻す。 */
export function resetRecallPromote(state: RecallPromoteState): void {
  state.freq.clear();
  state.dismissed.clear();
}
