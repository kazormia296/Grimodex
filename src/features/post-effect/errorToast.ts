import { toast } from "sonner";
import i18next from "i18next";
import { invoke } from "@/lib/tauri";

/** ログフォルダ（~/.grimodex/logs/）を OS のファイルマネージャで開く。 */
export async function openLogDir(): Promise<void> {
  await invoke("open_log_dir");
}

/**
 * post_effect 系の失敗トースト。localLLM の 400 のように「詳細ログを見ないと
 * 原因が分からない」失敗が起きる経路なので、常に「ログを開く」アクションを
 * 付けて `~/.grimodex/logs/lint-tauri.*.log` へ誘導する。
 */
export function postEffectErrorToast(title: string, description?: string) {
  toast.error(title, {
    description,
    action: {
      label: i18next.t("kouetsu.openLog", "ログを開く"),
      onClick: () => {
        openLogDir().catch(() => {
          toast.error(
            i18next.t(
              "kouetsu.openLogFailed",
              "ログフォルダを開けませんでした",
            ),
          );
        });
      },
    },
  });
}

/**
 * multi 実行の部分失敗トースト。done イベントの `summary` は「一部シーンの
 * 解析に失敗した（成功分の指摘は保存済み）」ときだけ入る。error トーストだと
 * 全滅に見えるため warning で出し、詳細ログへの導線は同様に付ける。
 * summary が無ければ何もしない（完全成功パスから無条件で呼べる）。
 */
export function postEffectPartialToast(summary: string | undefined): boolean {
  if (!summary) return false;
  toast.warning(
    i18next.t("kouetsu.partialFailure", "一部のシーンで解析に失敗しました"),
    {
      description: summary,
      action: {
        label: i18next.t("kouetsu.openLog", "ログを開く"),
        onClick: () => {
          openLogDir().catch(() => {
            toast.error(
              i18next.t(
                "kouetsu.openLogFailed",
                "ログフォルダを開けませんでした",
              ),
            );
          });
        },
      },
    },
  );
  return true;
}
