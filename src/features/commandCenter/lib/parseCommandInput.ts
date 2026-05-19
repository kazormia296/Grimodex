import type { CommandCenterMode } from "../providers/types";

export interface ParsedInput {
  mode: CommandCenterMode;
  text: string;
}

/**
 * 入力をモードと検索文字列に分解する。
 * - `>` で始まる場合は command モード。先頭の `>` と直後の空白を剥がす。
 * - それ以外は search モード。
 *
 * 例:
 *   "邂逅"   → { mode: "search",  text: "邂逅" }
 *   ">cmd"   → { mode: "command", text: "cmd" }
 *   ">  do"  → { mode: "command", text: "do" }
 *   "> "     → { mode: "command", text: "" }
 */
export function parseCommandInput(raw: string): ParsedInput {
  if (raw.startsWith(">")) {
    return { mode: "command", text: raw.slice(1).trimStart() };
  }
  return { mode: "search", text: raw };
}
