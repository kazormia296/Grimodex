// 乾いた実行の Electron で、AI の外向きの命令を main の入口（ipcMain.handle の grim:invoke）で止める層。
// electron を import しない（試験できるように、electron-observer-b.mjs から分けた。plain-text-keystore.mjs と同じ形）。
//
// 目的：乾いた実行が、送信の直前の経路（製品の judgeCandidates）から、応答の処理・監査の完了・usage の記録まで通っても、
// 外へは何も出ないことを main の入口で保証する。外向きの命令は本物の handler に届かない。
//   - send_chat_message：外へ出さず、定型の偽の応答（REHEARSAL_RESPONSE。判定は空）で答える（リハーサル）。
//   - それ以外の外向きの命令：renderer には固定の token（IDL_DISPATCH_BLOCKED）の例外として返る。
// 数えるのは命令の名前ごとの件数だけ（引数・本文・エラーの自由文は持たない）。
import assert from "node:assert/strict";
import { findAiCommands } from "./lib.mjs";

export const DISPATCH_BLOCK_ENV = "GRIMODEX_IDL_BLOCK_DISPATCH";
/** 拒否したとき renderer に返る例外の token（safeErrorSummary の codes に載る形）。 */
export const DISPATCH_BLOCK_TOKEN = "IDL_DISPATCH_BLOCKED";
/**
 * AI 系の名前だが外向きでない命令（局所の設定・局所の監査の DB への追記）。通す。
 * ai_audit_append_batch は、製品の AI 送信が begin・dispatched・終端の事象を局所の DB に書く命令（外へ出ない）。
 */
export const DISPATCH_BLOCK_EXEMPT = Object.freeze([
  "get_ai_settings",
  "save_ai_settings",
  "ai_audit_append_batch",
]);
/** リハーサルで send_chat_message に返す偽の応答。判定は空（製品は「有効な結果なし」として扱う）。token 数は固定の値。 */
export const REHEARSAL_RESPONSE = Object.freeze({
  blocks: Object.freeze([
    Object.freeze({
      type: "text",
      content: JSON.stringify({ judgments: [] }),
    }),
  ]),
  stopReason: "end_turn",
  inputTokens: 1000,
  outputTokens: 100,
});

/**
 * 外へ出る可能性のある命令か（純関数）。lib.mjs の findAiCommands（AI の command と外部へ出る command）に当たる名前は、
 * 局所の命令（DISPATCH_BLOCK_EXEMPT）以外すべて、本物の handler に届けない（乾いた実行で AI の command が本物の handler に
 * 届けば dryCellStatus が不採用にする）。
 */
export function isBlockedDispatchCommand(command) {
  if (typeof command !== "string") return false; // 命令でない値は本物の handler が拒否する
  if (DISPATCH_BLOCK_EXEMPT.includes(command)) return false;
  return findAiCommands([command]).length > 0;
}

/**
 * ipcMain.handle を包んで、grim:invoke の外向きの命令を止める。electron-observer.mjs（共有の trace の層）より先に
 * 呼ぶこと：後から包まれる trace の層より外側になり、止めた命令は trace に出ない（本物の handler に届いた AI の命令だけが
 * trace に出るので、dryCellStatus の「AI の command が 0」の判定は変わらない）。
 * 返り値の state（globalThis.idlDispatchBlock に置く）は、有効であること・止めた命令の件数・リハーサルで答えた件数だけを持つ。
 */
export function installDispatchBlock(ipcMain, env) {
  assert.equal(
    env[DISPATCH_BLOCK_ENV],
    "1",
    "[precheck] DISPATCH_BLOCK_NOT_REQUESTED",
  );
  const state = { active: true, blocked: {}, rehearsed: 0 };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    originalHandle(
      channel,
      channel === "grim:invoke"
        ? async (event, ...args) => {
            const command = args[0];
            if (command === "send_chat_message") {
              // 外へは出さない。本物の handler は呼ばず、定型の応答で答える（毎回新しい object）。
              state.rehearsed++;
              return {
                ok: true,
                value: {
                  blocks: REHEARSAL_RESPONSE.blocks.map((block) => ({
                    ...block,
                  })),
                  stopReason: REHEARSAL_RESPONSE.stopReason,
                  inputTokens: REHEARSAL_RESPONSE.inputTokens,
                  outputTokens: REHEARSAL_RESPONSE.outputTokens,
                },
              };
            }
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
