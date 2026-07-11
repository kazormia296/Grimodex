/**
 * invoke ルーター（設計書 §2 / §5.2、Phase 2 S4）。
 *
 * `ipcMain.handle("grim:invoke")` 1 本に集約し、ルーティングの実体は
 * 純関数 `dispatchInvoke`（electron/shared/ipcContract.ts — node 環境で
 * 単体テスト済み）へ委譲する。ここは electron グルーのみ:
 * - 送信元窓の解決（set_window_vibrancy の対象束縛）
 * - IPC_UNIMPLEMENTED の main 側ログ（A6 fail-soft 監査の集計ポイント）
 */
import { BrowserWindow, ipcMain } from "electron";

import {
  dispatchInvoke,
  IPC,
  IPC_BACKEND_UNAVAILABLE_MARKER,
  IPC_UNIMPLEMENTED_MARKER,
} from "../shared/ipcContract.js";
import type {
  CommandArgs,
  Envelope,
  NapiBackendLike,
  SecretsResolver,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import {
  buildShellCommandHandlers,
  registerShellBridgeHandlers,
} from "./shellCommands.js";
import { focusPanelWindow, openPanelWindow } from "./windows.js";

function isRecord(value: unknown): value is CommandArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * app ready 後に 1 回だけ呼ぶ。`backend` は .node ロード失敗時 null
 * （napi コマンドは IPC_BACKEND_UNAVAILABLE の明示エラーで落ちる）。
 * `extraShellHandlers` は per-invoke に再生成できないステートフルな main-TS
 * コマンド（external_mount の registry/watcher など）を単一インスタンスから
 * 注入するための拡張点。invoke ごとの `buildShellCommandHandlers` の結果へ
 * merge する（キー衝突なし = 追加分のみ）。
 * `broadcast` はmanual license mutationの返却DTOを全窓へ即時同期する窓口。
 */
export function registerIpcRouter(
  backend: NapiBackendLike | null,
  extraShellHandlers: ShellCommandHandlers = {},
  secrets?: SecretsResolver,
  broadcast?: (channel: string, payload: unknown) => void,
): void {
  ipcMain.handle(
    IPC.invoke,
    async (event, cmd: unknown, args: unknown): Promise<Envelope> => {
      if (typeof cmd !== "string") {
        return {
          ok: false,
          error: "IPC_INVALID_REQUEST: command name must be a string",
        };
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const envelope = await dispatchInvoke(cmd, isRecord(args) ? args : {}, {
        backend,
        shell: { ...buildShellCommandHandlers(win), ...extraShellHandlers },
        secrets,
        broadcast,
      });
      if (
        !envelope.ok &&
        (envelope.error.startsWith(IPC_UNIMPLEMENTED_MARKER) ||
          envelope.error.startsWith(IPC_BACKEND_UNAVAILABLE_MARKER))
      ) {
        console.warn(`[grim:invoke] ${envelope.error}`);
      }
      return envelope;
    },
  );

  // パネル別窓（§6.5、S7）の実体を注入する（shellCommands は windows.ts に
  // 直接依存しない — PanelWindowDelegate のコメント参照）。
  registerShellBridgeHandlers({
    open: openPanelWindow,
    focusByLabel: focusPanelWindow,
  });
}
