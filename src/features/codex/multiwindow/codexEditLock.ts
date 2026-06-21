/**
 * Codex 本文の「別窓同時編集」を避けるための advisory single-writer lock。
 *
 * 設計（docs/Grimodex_マルチウインドウ検討.md §G2）:
 * - 衝突マージ UX は作らない。「1 entry = 1 窓ずつ編集」を担保するだけ。
 * - トランスポート非依存の純レデューサ。窓間配信（broadcast emit）が
 *   acquire/release/heartbeat イベントを流し込み、各窓は同じ reducer で
 *   同一の holder 判定に決定的に収束する。
 * - holder は先勝ち。ただし「同時 acquire（同 ts）」は windowId 辞書順で
 *   タイブレークし、到着順に依存せず両窓が同じ holder に収束する。
 * - holder が閉じ忘れ/クラッシュした場合に備え、TTL で失効。生存中は
 *   heartbeat で期限を延長する。
 *
 * 純粋性: now / ttl は必ず引数で受け取る（Date.now を内部で呼ばない）。
 */

export type LockEventType = "acquire" | "release" | "heartbeat";

export interface LockEvent {
  type: LockEventType;
  entryId: string;
  windowId: string;
  ts: number;
}

/** entryId -> 現 holder（windowId）と最終観測時刻 ts。 */
export type LockState = Record<string, { windowId: string; ts: number }>;

function isExpired(ts: number, now: number, ttlMs: number): boolean {
  return now - ts > ttlMs;
}

/**
 * challenger が incumbent を打ち負かすか。
 * 早い ts が勝ち、同 ts は windowId 辞書順（小さい方）が勝つ。
 * → 到着順に依存しない決定的タイブレーク。
 */
function beats(
  challenger: { windowId: string; ts: number },
  incumbent: { windowId: string; ts: number },
): boolean {
  if (challenger.ts !== incumbent.ts) return challenger.ts < incumbent.ts;
  return challenger.windowId < incumbent.windowId;
}

/** イベントを 1 つ適用した新しい LockState を返す（入力は破壊しない）。 */
export function reduceLock(
  state: LockState,
  ev: LockEvent,
  ttlMs: number,
): LockState {
  const next: LockState = { ...state };
  const cur = next[ev.entryId];

  switch (ev.type) {
    case "acquire": {
      if (!cur) {
        next[ev.entryId] = { windowId: ev.windowId, ts: ev.ts };
      } else if (cur.windowId === ev.windowId) {
        // 自窓の再取得 = 期限延長（時刻は前進のみ）。
        next[ev.entryId] = {
          windowId: ev.windowId,
          ts: Math.max(cur.ts, ev.ts),
        };
      } else if (isExpired(cur.ts, ev.ts, ttlMs)) {
        // 失効した holder は奪える。
        next[ev.entryId] = { windowId: ev.windowId, ts: ev.ts };
      } else if (beats({ windowId: ev.windowId, ts: ev.ts }, cur)) {
        // 有効な holder でも、より早い ts / 同 ts かつ辞書順で上なら入れ替え。
        next[ev.entryId] = { windowId: ev.windowId, ts: ev.ts };
      }
      // それ以外は現 holder 維持（先勝ち）。
      return next;
    }
    case "heartbeat": {
      if (cur && cur.windowId === ev.windowId) {
        next[ev.entryId] = {
          windowId: ev.windowId,
          ts: Math.max(cur.ts, ev.ts),
        };
      }
      // 他窓 / holder 不在の heartbeat は無視（holder は奪わない）。
      return next;
    }
    case "release": {
      if (cur && cur.windowId === ev.windowId) {
        delete next[ev.entryId];
      }
      return next;
    }
    default:
      return next;
  }
}

/** entry の現 holder（windowId）。holder 不在 / 失効なら null。 */
export function holderOf(
  state: LockState,
  entryId: string,
  now: number,
  ttlMs: number,
): string | null {
  const cur = state[entryId];
  if (!cur) return null;
  if (isExpired(cur.ts, now, ttlMs)) return null;
  return cur.windowId;
}

/** selfWindowId が entry を編集してよいか（holder 不在 / 自分 / 失効なら可）。 */
export function canEdit(
  state: LockState,
  entryId: string,
  selfWindowId: string,
  now: number,
  ttlMs: number,
): boolean {
  const holder = holderOf(state, entryId, now, ttlMs);
  return holder === null || holder === selfWindowId;
}
