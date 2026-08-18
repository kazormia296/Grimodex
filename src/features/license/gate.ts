import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { useLicenseStore } from "./store";
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
  staleConfirmed: boolean,
): boolean {
  if (!licensingEnabled) return false;
  if (status === "trial_expired" || status === "revoked") return true;
  // license_stale はローカル時計だけで確定させない。validate を 1 回試行して
  // 失敗を確認する（staleConfirmed）まで制限を発動しない — 時計の前方ジャンプ
  // で誤ってロックしないため（設計書 §3、コミット前レビュー確定指摘）。
  if (status === "license_stale") return staleConfirmed;
  return false;
}

/** store の同期キャッシュで「書き込み制限中か」を返す（React 外から呼べる）。 */
export function isWriteRestrictedByLicense(): boolean {
  const s = useLicenseStore.getState();
  return isRestrictedLicenseState(
    s.licensingEnabled,
    s.status,
    s.staleConfirmed,
  );
}

/**
 * 制限中なら toast を出して true を返す defense ヘルパー。
 * チョークポイントは `if (blockIfUnlicensed()) return;` の形で早期 return する。
 *
 * `toastId` は「1 回のユーザー操作が複数チョークポイントに展開される」経路の
 * ための重複抑止。素の toast は同じ文言をヒット数だけ積み上げるため、
 * チャンクごとにループする backfill や、合成タスクが修復タスクを呼ぶような
 * 入れ子経路では文言の山になる。id を渡すと sonner が 1 枚に畳む。
 * 単発のユーザー操作では省略してよい。
 */
export function blockIfUnlicensed(toastId?: string): boolean {
  if (!isWriteRestrictedByLicense()) return false;
  toast.error(
    i18next.t("license.writeBlocked"),
    toastId ? { id: toastId } : undefined,
  );
  return true;
}

/** エディタ editable 等のリアクティブ購読用フック。 */
export function useLicenseWriteRestricted(): boolean {
  return useLicenseStore((s) =>
    isRestrictedLicenseState(s.licensingEnabled, s.status, s.staleConfirmed),
  );
}

/**
 * 作成系 store メソッドのゲートが throw するエラーメッセージ（正本）。
 * 戻り値が Promise<Entity> のため早期 return できず throw で拒否する契約。
 */
export const LICENSE_WRITE_RESTRICTED_ERROR = "license: write restricted";

/**
 * e がライセンス制限による拒否か。gate が toast 済みなので、呼び出し側の
 * catch はこれを見て汎用の「失敗しました」トーストを重ねないこと。
 */
export function isLicenseRestrictedError(e: unknown): boolean {
  return e instanceof Error && e.message === LICENSE_WRITE_RESTRICTED_ERROR;
}
