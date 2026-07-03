import { useEffect } from "react";
import { isTauri } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { checkForUpdate } from "./api";
import { useUpdaterStore } from "./updaterStore";

/** 起動後にサイレントで更新確認するまでの遅延 (ms)。起動処理との競合を避ける。 */
const CHECK_DELAY_MS = 10_000;

/**
 * アプリ起動 ~10 秒後に 1 度だけサイレント更新確認する hook。App.tsx に 1 度だけ
 * マウントする想定。dev / 非 Tauri では何もしない。更新があれば updaterStore を
 * available にして UpdateToast を出す。更新なし・失敗はトーストを出さず (失敗は
 * debugLog.warn のみ)、deb/rpm など非対応形式のエラーも同様に握りつぶす。
 */
export function useUpdateChecker(): void {
  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const update = await checkForUpdate();
          if (cancelled || !update) return;
          useUpdaterStore
            .getState()
            .setAvailable(update.version, update.body ?? null);
        } catch (e) {
          // 非対応形式 (deb/rpm 等) や取得失敗はサイレント。トーストは出さない。
          debugLog.warn(
            "updater",
            "自動更新チェックに失敗しました",
            errorDetail(e),
          );
        }
      })();
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
}
