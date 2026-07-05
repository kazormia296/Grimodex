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
