/**
 * 製品の download の保存先の検査の配線（K3/2 SF-1 の 8。DA-1）。
 * 検査の本体は downloadGuard.ts。ここは electron の session、dialog、
 * 既定の profile data directory の guard をつなぐ。
 */
import os from "node:os";

import { app, BrowserWindow, dialog, session } from "electron";
import type { WebContents } from "electron";

import { installDownloadGuard } from "./downloadGuard.js";
import type { DownloadGuardDeps, DownloadNotice } from "./downloadGuard.js";
import { getDefaultProfileDataGuard } from "./profileDataGuardDefault.js";
import { showSavePathDialog } from "./shellCommands.js";

const NOTICE_MESSAGES: Readonly<Record<DownloadNotice, string>> = {
  "rejected-destination":
    "この保存先には書き出せません。別の保存先を選んでください。",
  failed: "ファイルを保存できませんでした。もう一度お試しください。",
};

function buildProductDeps(): DownloadGuardDeps {
  const guard = getDefaultProfileDataGuard();
  return {
    guard,
    tmpdir: () => os.tmpdir(),
    pickSavePath: (webContents, options) =>
      showSavePathDialog(
        BrowserWindow.fromWebContents(webContents as unknown as WebContents),
        options,
        guard,
      ),
    notify: (notice) => {
      // 平文と path を含めない。
      console.warn(`[download-guard] ${notice}`);
      dialog.showErrorBox("保存できませんでした", NOTICE_MESSAGES[notice]);
    },
  };
}

/** app ready 後に 1 回呼ぶ。既定の session と、後から作られる全 session に付ける。 */
export function installProductDownloadGuard(): void {
  const deps = buildProductDeps();
  installDownloadGuard(session.defaultSession, deps);
  app.on("session-created", (created) => {
    installDownloadGuard(created, deps);
  });
}
