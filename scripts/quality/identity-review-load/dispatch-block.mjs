// 乾いた実行の Electron で、AI の外向きの命令を main の入口（ipcMain.handle の grim:invoke）で拒否する層。
// electron を import しない（試験できるように、electron-observer-b.mjs から分けた。plain-text-keystore.mjs と同じ形）。
//
// 目的：乾いた実行が、送信の直前の経路（製品の judgeCandidates）まで通っても、外へは何も出ないことを main の入口で保証する。
// 拒否した命令は本物の handler に届かない。renderer には固定の token（IDL_DISPATCH_BLOCKED）の例外として返る。
// 数えるのは命令の名前ごとの件数だけ（引数・本文・エラーの自由文は持たない）。
import assert from "node:assert/strict";
import { findAiCommands } from "./lib.mjs";

export const DISPATCH_BLOCK_ENV = "GRIMODEX_IDL_BLOCK_DISPATCH";
/** 拒否したとき renderer に返る例外の token（safeErrorSummary の codes に載る形）。 */
export const DISPATCH_BLOCK_TOKEN = "IDL_DISPATCH_BLOCKED";
/** AI 系の名前だが外向きでない命令（設定の読み書きだけ。bConfigureAi が使う）。 */
export const DISPATCH_BLOCK_EXEMPT = Object.freeze([
  "get_ai_settings",
  "save_ai_settings",
]);

/**
 * 拒否する命令か（純関数）。lib.mjs の findAiCommands（AI の command と外部へ出る command）に当たる名前は、
 * 設定の読み書き以外すべて拒否する（乾いた実行で AI の command が 1 件でも本物の handler に届けば dryCellStatus が不採用にする）。
 */
export function isBlockedDispatchCommand(command) {
  if (typeof command !== "string") return false; // 命令でない値は本物の handler が拒否する
  if (DISPATCH_BLOCK_EXEMPT.includes(command)) return false;
  return findAiCommands([command]).length > 0;
}

/**
 * ipcMain.handle を包んで、grim:invoke の外向きの命令を拒否する。electron-observer.mjs（共有の trace の層）より先に
 * 呼ぶこと：後から包まれる trace の層より外側になり、拒否した命令は trace に出ない（本物の handler に届いた AI の命令だけが
 * trace に出るので、dryCellStatus の「AI の command が 0」の判定は変わらない）。
 * 返り値の state（globalThis.idlDispatchBlock に置く）は、有効であること・拒否した命令の件数だけを持つ。
 */
export function installDispatchBlock(ipcMain, env) {
  assert.equal(
    env[DISPATCH_BLOCK_ENV],
    "1",
    "[precheck] DISPATCH_BLOCK_NOT_REQUESTED",
  );
  const state = { active: true, blocked: {} };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    originalHandle(
      channel,
      channel === "grim:invoke"
        ? async (event, ...args) => {
            const command = args[0];
            if (isBlockedDispatchCommand(command)) {
              state.blocked[command] = (state.blocked[command] ?? 0) + 1;
              throw new Error(DISPATCH_BLOCK_TOKEN);
            }
            return listener(event, ...args);
          }
        : listener,
    );
  return state;
}
