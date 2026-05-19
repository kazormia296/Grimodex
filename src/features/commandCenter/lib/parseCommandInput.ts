import type { CommandCenterMode } from "../providers/types";

export interface ParsedInput {
  mode: CommandCenterMode;
  /** prefix を剥がし、`-word` トークンを除いた検索本文 */
  text: string;
  /** `-word` で除外されたキーワード。空配列なら除外なし。 */
  excludes: string[];
}

/**
 * 入力を mode + 検索本文 + 除外語に分解する。
 *
 * - `>` で始まる場合は command モード。先頭の `>` と直後の空白を剥がす。
 * - `-word` (先頭ハイフン + 1 文字以上) のトークンは除外語として抽出される。
 *   除外語は post-filter で「item の title/subtitle に含まれているものを drop」する用途。
 *
 * 例:
 *   "邂逅 -雨"        → { mode: "search", text: "邂逅", excludes: ["雨"] }
 *   ">cmd -foo bar"   → { mode: "command", text: "cmd bar", excludes: ["foo"] }
 *   "-only"           → { mode: "search", text: "", excludes: ["only"] }
 *   "邂逅"            → { mode: "search", text: "邂逅", excludes: [] }
 *
 * ハイフン単体 (`-`) や空文字は除外語に含めない。
 */
export function parseCommandInput(raw: string): ParsedInput {
  let text = raw;
  let mode: CommandCenterMode = "search";
  if (text.startsWith(">")) {
    mode = "command";
    text = text.slice(1).trimStart();
  }

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const excludes: string[] = [];
  const positives: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("-")) {
      // ハイフン始まりは exclude 試行。残りが空ならドロップ。
      const word = tok.slice(1);
      if (word.length > 0) excludes.push(word);
    } else {
      positives.push(tok);
    }
  }

  return { mode, text: positives.join(" "), excludes };
}
