// 乾いた実行の Electron で、AI の外向きの命令を main の入口（ipcMain.handle の grim:invoke）で止める層。
// electron を import しない（試験できるように、electron-observer-b.mjs から分けた。plain-text-keystore.mjs と同じ形）。
//
// 目的：乾いた実行が、送信の直前の経路（製品の judgeCandidates）から、応答の処理・監査の完了・usage の記録まで通っても、
// 外へは何も出ないことを main の入口で保証する。**許可リスト方式**：局所の既知の命令（DISPATCH_LOCAL_ALLOW）だけを本物の
// handler に届け、それ以外はすべて届けない。
//   - send_chat_message：外へ出さず、定型の偽の応答（REHEARSAL_RESPONSE。判定は空）で答える（リハーサル）。
//   - それ以外の許可リストに無い命令：renderer には固定の token（IDL_DISPATCH_BLOCKED）の例外として返る。
// 数えるのは命令の名前ごとの件数だけ（引数・本文・エラーの自由文は持たない）。
import assert from "node:assert/strict";

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
 * 乾いた実行の page が呼ぶ、局所の命令の許可リスト。**許可リスト方式**（ここに無い命令は、AI の名前に当たらなくても本物の
 * handler に届けない）：拒否リスト（findAiCommands）だけでは、updater・インストーラ・外部の process を起こす命令など、AI の
 * 名前を持たない外向きの命令を取りこぼす（独立レビューの P1）。集合は、乾いた実行を拒否リストの方式で 3 回
 * （2026-11-23 19:38・20:10・20:26。4 作品ずつ）回したときに、page が本物の handler に届けた命令の和集合そのもの
 * （挙動は変わらない）。page が新しい命令を呼ぶようになれば、止まって dispatchBlock.blocked に名前が出るので、
 * 局所の命令だと確かめてからここに足す。
 */
export const DISPATCH_LOCAL_ALLOW = Object.freeze([
  ...DISPATCH_BLOCK_EXEMPT,
  "codex_create",
  "codex_match_text",
  "codex_rebuild_matcher",
  "codex_update",
  "db_execute",
  "extract_codex_candidates",
  "get_global_settings",
  "get_model_capability_snapshot",
  "has_api_key",
  "open_workspace",
  "project_create",
  "tree_node_create",
]);

/**
 * 本物の handler に届けない命令か（純関数）。許可リスト（DISPATCH_LOCAL_ALLOW）に無い命令はすべて届けない
 * （send_chat_message を含む。乾いた実行で AI の command が本物の handler に届けば dryCellStatus が不採用にする）。
 * 命令でない値（文字列でない）は本物の handler が拒否するので、ここでは止めない。
 */
export function isBlockedDispatchCommand(command) {
  if (typeof command !== "string") return false;
  return !DISPATCH_LOCAL_ALLOW.includes(command);
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
