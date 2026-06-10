/**
 * ライセンス状態（ライセンス認証設計書 §3）。
 * Rust の `get_license_state` が返す状態名と 1:1。
 * `disabled` は licensing 無効ビルド（ベータ配布）限定 — フロントは全ゲートを
 * 素通りさせ License UI を一切出さない。
 */
export type LicenseStatus =
  | "trial"
  | "trial_expired"
  | "licensed"
  | "grace"
  | "license_stale"
  | "revoked"
  | "disabled";

/** `get_license_state` / `activate_license` 等が返す DTO（IPC は camelCase）。 */
export interface LicenseStateDto {
  licensingEnabled: boolean;
  status: LicenseStatus;
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  keyTail: string | null;
  activatedAt: string | null;
  lastValidatedAt: string | null;
}
