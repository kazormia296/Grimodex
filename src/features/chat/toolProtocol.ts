/**
 * Hermes/ChatML 形式のテキストツール記法（`<tool_call>…</tool_call>` /
 * `<tool_response>…</tool_response>`）を assistant メッセージ本文から除去する。
 *
 * 背景: native function calling に対応しない一部のモデル（OpenRouter 経由の
 * Hermes/Qwen 系など）は、Web 検索 RAG ターンでツール呼び出しを「構造化
 * tool_calls」ではなく**本文テキスト**として吐き出す。web_search はサーバ側
 * 実行のクライアントツール非存在（[[grimodex-web-search-rag]]）なので、この
 * tool_call/tool_response はモデルが訓練 prior から捏造した擬似的なもの。Rust
 * パーサは構造化 tool_calls しか抽出しないため、このテキストが msg.content に
 * 残り、react-markdown が生のテキストノードとして可視レンダーしてしまう。
 *
 * 本ユーティリティは**読み取り側（描画・モデルへ戻す履歴）**で噛ませる純関数。
 * DB には生のまま保存し（可逆・出自の真実を保持）、消費境界で除去する方針。
 *
 * 実装は Rust の `strip_think_blocks`（src-tauri/src/ai.rs）と同一セマンティクス:
 * 開きタグを探し閉じタグまでを除去、閉じタグが無ければそこで打ち切り（残りを
 * 捨てる = streaming 途中の未閉じタグのちらつきも抑止）。タグが 1 つも無ければ
 * 入力を**そのまま**返す（通常メッセージへのゼロ影響を保証）。
 */

/** 除去対象の擬似ツール記法タグ（観測済みのもののみ。必要なら拡張）。 */
const TOOL_BLOCK_TAGS = ["tool_call", "tool_response"] as const;

/** `<tag>…</tag>` ブロックをすべて除去する。閉じタグ無しは以降を打ち切り。 */
function stripTagBlocks(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let out = "";
  let rest = text;
  let idx = rest.indexOf(open);
  while (idx !== -1) {
    out += rest.slice(0, idx);
    const after = rest.slice(idx);
    const closeRel = after.indexOf(close);
    if (closeRel === -1) {
      // 閉じタグ無し: 開きタグ以降を破棄（strip_think_blocks と同セマンティクス）。
      rest = "";
      break;
    }
    rest = after.slice(closeRel + close.length);
    idx = rest.indexOf(open);
  }
  out += rest;
  return out;
}

/**
 * assistant 本文から擬似ツール記法ブロックを除去する。
 * タグが含まれない場合は入力を byte-identical でそのまま返す。
 */
export function stripToolProtocol(text: string): string {
  if (!text) return text;
  const hasTag = TOOL_BLOCK_TAGS.some((tag) => text.includes(`<${tag}>`));
  if (!hasTag) return text;

  let out = text;
  for (const tag of TOOL_BLOCK_TAGS) {
    out = stripTagBlocks(out, tag);
  }
  // 除去で生じた連続空行を 1 段に畳んで前後をトリム。
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
