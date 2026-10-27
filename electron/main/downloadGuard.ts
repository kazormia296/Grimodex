/**
 * Chromium の download（renderer の `<a download>`。IPC を通らない）の保存先の検査
 * （K3/2 SF-1 の 8。DA-1）。
 *
 * `will-download` を扱わないと、renderer が決めた名前と内容で Electron の既定の保存
 * dialog が開き、利用者が選んだ path に書く。利用者が profile data directory を開いて
 * 保存すると、状態ファイルなどが renderer の内容に置き換わる。
 *
 * 方法（DR-DA1-5 の候補 (a)）:
 * 1. handler の中で同期に `item.setSavePath` を OS の temp 直下の新規 directory
 *    （mkdtemp）の固定名 file に向ける。Chromium は profile data directory に書かない。
 * 2. 完了後に Main が `showSavePathDialog`（初期値は単一のファイル名にした
 *    `item.getFilename()`）で利用者に保存先を選ばせ、guard で検査してから copy する。
 * 3. temp の directory は完了、取消、失敗のどれでも削除する。
 * 保存先を確定するのは利用者の操作で、renderer が決められるのは名前（単一の
 * ファイル名にされる）と内容だけである。通常の保存先への書出しは今までどおり。
 * 拒否と失敗は平文と path を含まない typed な通知で示す。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";

import { ProfileDataGuardError } from "./profileDataGuard.js";
import type { ProfileDataGuard } from "./profileDataGuard.js";

export type DownloadNotice =
  /** 保存先が profile data directory の中だった、または解決できなかった。 */
  | "rejected-destination"
  /** download が中断された、または保存に失敗した。 */
  | "failed";

export interface DownloadItemLike {
  getFilename(): string;
  setSavePath(savePath: string): void;
  cancel(): void;
  once(
    event: "done",
    listener: (event: unknown, state: string) => void,
  ): unknown;
}

export interface DownloadWebContentsLike {
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export interface DownloadSessionLike {
  on(
    event: "will-download",
    listener: (
      event: unknown,
      item: DownloadItemLike,
      webContents: DownloadWebContentsLike,
    ) => void,
  ): unknown;
}

export interface SaveDestinationOptions {
  suggestedName: string;
  filterName: string;
  extensions: string[];
}

export interface DownloadGuardDeps {
  guard: ProfileDataGuard;
  /** OS の temp directory（profile data directory の外）。 */
  tmpdir: () => string;
  /** 利用者に保存先を選ばせる。キャンセルは null。 */
  pickSavePath: (
    webContents: DownloadWebContentsLike,
    options: SaveDestinationOptions,
  ) => Promise<string | null>;
  notify: (notice: DownloadNotice) => void;
}

const TEMP_PREFIX = "grimodex-download-";
const TEMP_FILE_NAME = "download.bin";

export function handleWillDownload(
  item: DownloadItemLike,
  webContents: DownloadWebContentsLike,
  deps: DownloadGuardDeps,
): void {
  let tempDir: string;
  try {
    tempDir = mkdtempSync(path.join(deps.tmpdir(), TEMP_PREFIX));
  } catch {
    item.cancel();
    deps.notify("failed");
    return;
  }
  const tempFile = path.join(tempDir, TEMP_FILE_NAME);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // temp は OS の temp directory。削除できなくても状態ファイルには届かない。
    }
  };

  // 保存先を同期に決める（決めなければ Electron の既定の保存 dialog が開く）。
  try {
    item.setSavePath(tempFile);
  } catch {
    item.cancel();
    cleanup();
    deps.notify("failed");
    return;
  }

  // temp が profile data directory の中なら取り消す（temp の名前は renderer が決められない
  // ので、これは profile data directory を temp の下に置いた構成への安全網）。
  void deps.guard.assertOutside(tempDir).catch(() => {
    // 完了時の経路がすでに処理を終えて temp を削除していたら、ここでの拒否は temp が消えて解決
    // できなかっただけで（遅い disk で、この検査が飛行中のうちに削除が先に済む）、取り消すものも
    // 通知するものも残っていない。重ねて通知すると同じ拒否が 2 件出る。
    if (cleaned) return;
    item.cancel();
    cleanup();
    deps.notify("rejected-destination");
  });

  let destroyed = false;
  const onDestroyed = (): void => {
    destroyed = true;
    item.cancel();
  };
  if (webContents.isDestroyed()) {
    onDestroyed();
  } else {
    webContents.once("destroyed", onDestroyed);
  }

  item.once("done", (_event, state) => {
    try {
      webContents.removeListener("destroyed", onDestroyed);
    } catch {
      // destroyed 済みの webContents
    }
    if (state !== "completed" || destroyed || cleaned) {
      cleanup();
      // 利用者の取消や窓を閉じた取消は通知しない。
      if (state === "interrupted") deps.notify("failed");
      return;
    }
    void saveCompletedDownload(item, webContents, tempFile, deps)
      .catch((error: unknown) => {
        deps.notify(
          error instanceof ProfileDataGuardError
            ? "rejected-destination"
            : "failed",
        );
      })
      .finally(cleanup);
  });
}

async function saveCompletedDownload(
  item: DownloadItemLike,
  webContents: DownloadWebContentsLike,
  tempFile: string,
  deps: DownloadGuardDeps,
): Promise<void> {
  const destination = await deps.pickSavePath(webContents, {
    suggestedName: item.getFilename(),
    filterName: "All files",
    extensions: ["*"],
  });
  if (destination === null) return;
  // 書く前に、保存先の実体が profile data directory の中なら拒否する。
  await deps.guard.assertOutside(destination);
  await copyFile(tempFile, destination);
}

const guardedSessions = new WeakSet<object>();

/** session の `will-download` に guard を付ける（同じ session には 1 回だけ）。 */
export function installDownloadGuard(
  session: DownloadSessionLike,
  deps: DownloadGuardDeps,
): void {
  if (guardedSessions.has(session)) return;
  guardedSessions.add(session);
  session.on("will-download", (_event, item, webContents) => {
    handleWillDownload(item, webContents, deps);
  });
}
