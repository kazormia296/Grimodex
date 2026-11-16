/**
 * アプリの UI を操作する agent ツール（設計書 §5 の PR3）の名前と、1 回の応答での呼び出し上限。
 *
 * 実装本体（appUiTools.ts）は layout／tab の store を import するので、起動の import グラフに
 * 載せないよう、名前と上限だけをここに置く（import を持たない）。
 */
export const RUN_APP_COMMAND_TOOL = "run_app_command";
export const APPLY_LAYOUT_PRESET_TOOL = "apply_layout_preset";

export const UI_OPERATION_TOOL_NAMES: readonly string[] = Object.freeze([
  RUN_APP_COMMAND_TOOL,
  APPLY_LAYOUT_PRESET_TOOL,
]);

/**
 * 1 回の agent の応答（runAgentLoop 1 回）で UI 操作ツールを実行できる回数の上限。
 * 一般の tool 呼び出し上限（modelLimits の 10〜25）は 1 バッチの中の呼び出しを数えず、
 * 全ツールの合計でもあるため、操作の連打（本文に仕込まれた指示による暴走）を別に絞る。
 */
export const MAX_UI_OPERATIONS_PER_TURN = 10;

/**
 * run_app_command が受け付けるコマンド id（registry の `agent: true` かつ `risk: "view"`）。
 * toolDefinitions の inputSchema の enum に使う。registry を import すると layout／tab の store が
 * 起動の import グラフに載るので、ここに直書きし、registry との一致は appUiTools.test.ts で固定する。
 */
export const AGENT_RUNNABLE_COMMAND_IDS: readonly string[] = Object.freeze([
  "toggleLeftOverlay",
  "toggleRightOverlay",
  "searchWorkspace",
  "focusScenes",
  "focusCodex",
  "focusSnippets",
  "focusAttribution",
  "focusCodexQuick",
  "focusTimeline",
  "focusChronicle",
  "focusMap",
  "focusKouetsu",
  "focusForeshadow",
  "focusTrashBin",
  "focusGrid",
  "focusMatrix",
  "focusWritingStats",
  "openSettings",
]);
