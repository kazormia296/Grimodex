import {
  check,
  type Update,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "@/lib/tauri";
import { useUpdaterStore } from "./updaterStore";

/**
 * @tauri-apps/plugin-updater / plugin-process の薄いラッパ。
 * store 遷移のうち check 系 (checking/available/upToDate/error) は
 * 呼び出し側 (hook / 設定 UI) が silent かどうかで出し分けるためここでは触らず、
 * ダウンロード進捗 (downloading/ready) のみ本モジュールが store に流す。
 */

/**
 * 直近の check() で得た更新オブジェクト。「今すぐ更新」ボタンが
 * downloadAndInstall を呼ぶ際に参照する。非シリアライズ値なので store には
 * 載せずモジュール内に保持する。
 */
let pendingUpdate: Update | null = null;

/**
 * 更新確認。非 Tauri 環境では no-op で null を返す。null は「更新なし」。
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  const update = await check();
  pendingUpdate = update;
  return update;
}

/**
 * 直近の更新をダウンロード＆インストールし、進捗を updaterStore に流す。
 * Finished で ready にし、最後にアプリを再起動する。pendingUpdate が無ければ no-op。
 */
export async function startUpdateDownload(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;
  const store = useUpdaterStore.getState();
  let total = 0;
  let downloaded = 0;
  await update.downloadAndInstall((event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        store.setDownloading(0, total);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        store.setDownloading(downloaded, total);
        break;
      case "Finished":
        store.setReady();
        break;
    }
  });
  // インストール完了 → 再起動。Windows は installMode 次第でインストーラ側が
  // 再起動を担うため、relaunch 失敗は握りつぶす (restartApp 内で処理)。
  await restartApp();
}

/**
 * アプリを再起動する。非 Tauri では no-op。失敗は握りつぶす
 * (Windows passive インストーラが再起動を担うケース等)。
 */
export async function restartApp(): Promise<void> {
  if (!isTauri()) return;
  try {
    await relaunch();
  } catch {
    // no-op: インストーラ側の再起動に委ねる
  }
}

/** テスト用: 保持中の更新オブジェクトをクリアする。 */
export function _resetUpdaterApiForTests(): void {
  pendingUpdate = null;
}
