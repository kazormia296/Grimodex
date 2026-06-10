import { create } from "zustand";
import { invoke } from "@/lib/tauri";
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
  /** 状態の取得に一度でも成功したか。 */
  initialized: boolean;
  /**
   * license_stale が「validate 試行を経て確認済み」か（設計書 §3 前方ジャンプ
   * 対策）。ローカル時計だけで stale に見えても、validate を 1 回試行して
   * 失敗を確認するまで制限を発動しない。確認経路は (1) バックグラウンド
   * validate 後の license:state_changed イベント (2) 手動再検証の失敗。
   */
  staleConfirmed: boolean;
  /** `get_license_state` を呼んで状態を反映する。失敗しても reject しない。 */
  refresh: () => Promise<void>;
  /** activate / deactivate 等の応答 DTO を直接反映する（stale 未確認扱い）。 */
  applyState: (dto: LicenseStateDto) => void;
  /**
   * validate 試行後の状態を反映する（license:state_changed イベント用）。
   * このとき license_stale なら「確認済み」として制限を発動させる。
   */
  applyValidatedState: (dto: LicenseStateDto) => void;
  /** キーでアクティベート。失敗は reject（UI がエラー文言を表示する契約）。 */
  activate: (key: string) => Promise<void>;
  /** この端末を解除。失敗は reject。 */
  deactivate: () => Promise<void>;
  /** 手動再検証（license_stale からの復帰ボタン用）。失敗は reject。 */
  revalidate: () => Promise<void>;
}

export const useLicenseStore = create<LicenseStoreState>()((set) => ({
  licensingEnabled: false,
  status: "disabled",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: null,
  activatedAt: null,
  lastValidatedAt: null,
  initialized: false,
  staleConfirmed: false,
  refresh: async () => {
    try {
      const dto = await invoke<LicenseStateDto>("get_license_state");
      // refresh はローカル時計ベースの状態。license_stale でも「未確認」
      // のまま = 制限はまだ発動しない（§3 validate-first）。
      set({ ...dto, initialized: true, staleConfirmed: false });
    } catch (error) {
      // fail-soft: 取得失敗でゲートを閉じない。既得状態（または fail-open の
      // 初期値）を維持する。
      console.warn("license: get_license_state failed", error);
    }
  },
  applyState: (dto) => {
    set({ ...dto, initialized: true, staleConfirmed: false });
  },
  applyValidatedState: (dto) => {
    set({
      ...dto,
      initialized: true,
      staleConfirmed: dto.status === "license_stale",
    });
  },
  activate: async (key) => {
    const dto = await invoke<LicenseStateDto>("activate_license", { key });
    set({ ...dto, initialized: true, staleConfirmed: false });
  },
  deactivate: async () => {
    const dto = await invoke<LicenseStateDto>("deactivate_license");
    set({ ...dto, initialized: true, staleConfirmed: false });
  },
  revalidate: async () => {
    try {
      const dto = await invoke<LicenseStateDto>("revalidate_license");
      set({ ...dto, initialized: true, staleConfirmed: false });
    } catch (error) {
      // 手動再検証の失敗 = validate 試行を経た確認。stale 表示中なら
      // ここから制限が確定する（§3）。
      set({ staleConfirmed: true });
      throw error;
    }
  },
}));
