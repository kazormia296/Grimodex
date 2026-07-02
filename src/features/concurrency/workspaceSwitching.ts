import { errorDetail } from "@/lib/debugLog";

/**
 * Rust 側 `with_db` (src-tauri/src/commands/mod.rs) が workspace 切替中の
 * DB アクセス拒否エラーに含める安定マーカー。Rust 側リテラルと必ず一致させる
 * こと (変更するときは両方同時に)。
 *
 * 用途: timelapse recorder の切替拒否バッチの再送抑止 (C1) と、autosave
 * 失敗 toast の i18n 文言差し替え。
 */
export const WORKSPACE_SWITCHING_MARKER = "WORKSPACE_SWITCHING";

/**
 * エラーが workspace 切替中の明示拒否かを判定する。drizzle 等にラップされた
 * 場合も拾えるよう cause チェーン込みの errorDetail で判定する。
 */
export function isWorkspaceSwitchingError(e: unknown): boolean {
  return errorDetail(e).includes(WORKSPACE_SWITCHING_MARKER);
}
