import type { LicenseStatus } from "./types";

/**
 * ライセンスの書き込み制限ゲート（ライセンス認証設計書 §6）。
 * `blockIfPolicyOff`（ai-policy/policyGuard.ts）と同型の defense 層。
 *
 * 制限されるのは trial_expired / license_stale / revoked のみ。
 * licensing 無効ビルド（status: "disabled" / licensingEnabled: false）は
 * いかなる status でも制限しない（ベータは全ゲート素通り、§9.1）。
 *
 * 配置規約（§14 インベントリ）: ゲートは store メソッド / UI 入口 / 既存
 * blockIfPolicyOff の隣に置く。DB 層 api.ts には置かない（importApi.ts が
 * create 系を共有しており、インポート・復元を巻き込むため）。
 */
export function isRestrictedLicenseState(
  licensingEnabled: boolean,
  status: LicenseStatus,
): boolean {
  void licensingEnabled;
  void status;
  throw new Error("Phase 2: 未実装");
}

/** store の同期キャッシュで「書き込み制限中か」を返す（React 外から呼べる）。 */
export function isWriteRestrictedByLicense(): boolean {
  throw new Error("Phase 2: 未実装");
}

/**
 * 制限中なら toast を出して true を返す defense ヘルパー。
 * チョークポイントは `if (blockIfUnlicensed()) return;` の形で早期 return する。
 */
export function blockIfUnlicensed(): boolean {
  throw new Error("Phase 2: 未実装");
}

/** エディタ editable 等のリアクティブ購読用フック。 */
export function useLicenseWriteRestricted(): boolean {
  throw new Error("Phase 2: 未実装");
}
