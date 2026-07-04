// ────────────────────────────────────────────────────────────────────
// Vivliostyle CLI 連携の型定義。
//
// IPC 契約（Rust 側 commands/vivliostyle.rs と固定契約）:
// - vivliostyle_detect / vivliostyle_build / vivliostyle_abort_build /
//   vivliostyle_save_output
// - イベント: vivliostyle:log / vivliostyle:done / vivliostyle:error
//   （payload は camelCase）
// ────────────────────────────────────────────────────────────────────

/** vivliostyle_detect の結果。null = PATH 上に CLI が見つからない。 */
export interface VivliostyleDetectResult {
  path: string;
  version: string;
}

/** ビルド出力形式。 */
export type VivliostyleFormat = "pdf" | "epub";

/** Rust 側 temp dir に書き出すファイル（book.html / theme.css）。 */
export interface VivliostyleBuildFile {
  name: string;
  contents: string;
}

/** vivliostyle:log イベント（CLI の stdout/stderr 1 行）。 */
export interface VivliostyleLogEvent {
  runId: string;
  line: string;
}

/** vivliostyle:done イベント。outputToken を save_output に渡す。 */
export interface VivliostyleDoneEvent {
  runId: string;
  outputToken: string;
}

/** vivliostyle:error イベント。 */
export interface VivliostyleErrorEvent {
  runId: string;
  message: string;
}
