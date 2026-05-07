/**
 * 復元 (pickup) の共通型 (設計書 §6 / §11 PickupResult)。
 *
 * 各 restorer は payload を受け取り、新 ID で entity を再生成する pure function。
 * 失敗時は `{ ok: false, reason }` を返す。UI 側はこれを toast / Popover 警告に
 * マップする (Phase 6)。
 *
 * 「リンク切れ」(参照先の Scene/Codex が既に存在しない) は restorer 内で検知
 * し、`brokenLinks` 配列で警告を返す。entity 自体は復元する。
 */
export interface RestoreResult {
  ok: true;
  /** 新規発行された ID。restorer ごとに entity 種別は異なる。 */
  newId: string;
  /** 元 entity が持っていた外部参照のうち、解決できなかった項目の説明。 */
  brokenLinks: string[];
}

export interface RestoreFailure {
  ok: false;
  reason: "rejected" | "no-target" | "duplicate" | "internal-error";
  message?: string;
}

export type RestoreOutcome = RestoreResult | RestoreFailure;
