import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@/lib/notification";
import i18next from "i18next";

/**
 * desktopNotify.ts — 校閲 run 終端のデスクトップ (OS) 通知。
 *
 * 校閲のプロジェクト全体チェックは分単位で走るため、ユーザーは別ウィンドウへ
 * 移ったり最小化したりする。アプリ内トースト (PostEffectProgressToast) は
 * その間見えないので、**ウィンドウが非フォーカスのときだけ** OS 通知で
 * 終端 (完了 / 部分失敗 / 失敗) を知らせる。フォーカス中は常駐トーストが
 * 見えているので OS 通知は出さない (二重通知回避)。
 *
 * 権限は run 開始時 (`ensureNotificationPermission` — ユーザーがボタンを
 * 押した直後 = フォーカス中) に確保する。終端時は確認のみで、非フォーカス中に
 * OS の権限プロンプトを出さない。
 */

export type RunTerminalOutcome =
  | { kind: "done"; annotationCount: number; summary?: string }
  | { kind: "error"; error: string };

/** セッション中に権限要求を繰り返さないためのフラグ (拒否されたら黙る)。 */
let permissionEnsured = false;

/** テスト用: 権限要求の once フラグをリセットする。 */
export function resetNotificationPermissionForTest(): void {
  permissionEnsured = false;
}

/**
 * 通知権限を確保する (未許可なら OS プロンプトを 1 回だけ出す)。
 * run 開始時 = ユーザーがアプリを見ているタイミングで呼ぶこと。
 * Tauri 外 (vitest / ブラウザ) では plugin 呼び出しが throw するので無視する。
 */
export async function ensureNotificationPermission(): Promise<void> {
  if (permissionEnsured) return;
  permissionEnsured = true;
  try {
    if (!(await isPermissionGranted())) {
      await requestPermission();
    }
  } catch {
    /* 通知は best-effort。権限 API の失敗で run を妨げない */
  }
}

/**
 * ウィンドウが非フォーカス (別ウィンドウの背後・最小化) のときだけ、
 * run の終端をデスクトップ通知する。本文は常駐トーストと同じ文言を使う。
 */
export async function notifyRunTerminalIfUnfocused(
  meta: { effectType: string; scopeType: string },
  outcome: RunTerminalOutcome,
): Promise<void> {
  try {
    // hasFocus はウィンドウ最小化・他アプリ/他ウィンドウへのフォーカス移動の
    // 両方で false になる (webview のフォーカス状態)。
    if (document.hasFocus()) return;
    // 非フォーカス中に権限プロンプトは出さない: 未許可なら黙ってスキップ。
    if (!(await isPermissionGranted())) return;

    const effectLabel = i18next.t(
      `kouetsu.progressToast.effect.${meta.effectType}`,
      meta.effectType,
    );
    const scopeLabel = i18next.t(
      `kouetsu.progressToast.scope.${meta.scopeType}`,
      meta.scopeType,
    );
    const body =
      outcome.kind === "error"
        ? i18next.t("kouetsu.progressToast.failed", { error: outcome.error })
        : outcome.summary
          ? `${i18next.t("kouetsu.progressToast.donePartial", {
              count: outcome.annotationCount,
            })}\n${outcome.summary}`
          : outcome.annotationCount > 0
            ? i18next.t("kouetsu.progressToast.done", {
                count: outcome.annotationCount,
              })
            : i18next.t("kouetsu.progressToast.doneNoFindings");

    // ラッパーは async なので、失敗をこの try/catch で握るため await する
    await sendNotification({ title: `${effectLabel} · ${scopeLabel}`, body });
  } catch {
    /* 通知は best-effort。失敗しても run の結果表示 (トースト) は生きている */
  }
}
