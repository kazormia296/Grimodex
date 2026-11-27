/**
 * アプリの UI を操作する agent ツール（設計書 §5 の PR3）の名前と、1 回の応答での呼び出し上限。
 *
 * 実装本体（appUiTools.ts）は layout／tab の store を import するので、起動の import グラフに
 * 載せない。ツール名とコマンド一覧は共有定義を再利用する。
 */
import {
  AGENT_RUNNABLE_COMMAND_IDS,
  APPLY_LAYOUT_PRESET_TOOL,
  MAX_UI_OPERATIONS_PER_TURN,
  RUN_APP_COMMAND_TOOL,
  UI_OPERATION_TOOL_NAMES,
} from "@/../electron/shared/mastraUiToolDefinitions";

export {
  AGENT_RUNNABLE_COMMAND_IDS,
  APPLY_LAYOUT_PRESET_TOOL,
  MAX_UI_OPERATIONS_PER_TURN,
  RUN_APP_COMMAND_TOOL,
  UI_OPERATION_TOOL_NAMES,
};
