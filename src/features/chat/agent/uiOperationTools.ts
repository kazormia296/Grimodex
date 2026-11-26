/**
 * アプリの UI を操作する agent ツール（設計書 §5 の PR3）の名前と、1 回の応答での呼び出し上限。
 *
 * 実装本体（appUiTools.ts）は layout／tab の store を import するので、起動の import グラフに
 * 載せない。ツール名とコマンド一覧は共有定義を再利用する。
 */
import {
  AGENT_RUNNABLE_COMMAND_IDS,
  APPLY_LAYOUT_PRESET_TOOL,
  RUN_APP_COMMAND_TOOL,
  UI_OPERATION_TOOL_NAMES,
} from "@/../electron/shared/mastraUiToolDefinitions";

export {
  AGENT_RUNNABLE_COMMAND_IDS,
  APPLY_LAYOUT_PRESET_TOOL,
  RUN_APP_COMMAND_TOOL,
  UI_OPERATION_TOOL_NAMES,
};

/**
 * 1 回の agent の応答（runAgentLoop 1 回）で UI 操作ツールを実行できる回数の上限。
 * 一般の tool 呼び出し上限（modelLimits の 10〜25）は 1 バッチの中の呼び出しを数えず、
 * 全ツールの合計でもあるため、操作の連打（本文に仕込まれた指示による暴走）を別に絞る。
 */
export const MAX_UI_OPERATIONS_PER_TURN = 10;
