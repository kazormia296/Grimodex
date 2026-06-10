import { create } from "zustand";
import type { LicenseStateDto } from "./types";

/**
 * ライセンス状態の Zustand store（ライセンス認証設計書 §5.1）。
 *
 * Rust の `get_license_state` が唯一の情報源で、起動時に App が `refresh()` を
 * 呼んで初期化する。ゲート判定（gate.ts）はこの store の同期キャッシュを読む —
 * 毎回 IPC しない（§6 実装ノート）。
 *
 * fail-open: 初期値は「無効ビルド相当」（licensingEnabled: false）。
 * 状態が取れるまで・取得に失敗した場合にゲートで執筆を止めない（fail-soft 原則）。
 */
export interface LicenseStoreState extends LicenseStateDto {
  /** `refresh()` が一度でも成功したか。 */
  initialized: boolean;
  /** `get_license_state` を呼んで状態を反映する。失敗しても reject しない。 */
  refresh: () => Promise<void>;
  /** activate / deactivate 等の応答 DTO を直接反映する。 */
  applyState: (dto: LicenseStateDto) => void;
}

export const useLicenseStore = create<LicenseStoreState>()(() => ({
  licensingEnabled: false,
  status: "disabled",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: null,
  activatedAt: null,
  lastValidatedAt: null,
  initialized: false,
  refresh: async () => {
    throw new Error("Phase 2: 未実装");
  },
  applyState: () => {
    throw new Error("Phase 2: 未実装");
  },
}));
