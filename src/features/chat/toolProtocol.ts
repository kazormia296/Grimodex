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

/**
 * 開き／閉じタグの寛容マッチャ。完全一致 `<tool_call>` だけだと、悪性 Web
 * コンテンツ由来や Hermes/Qwen 系が吐く **大文字** (`<TOOL_CALL>`)・**属性付き**
 * (`<tool_call type="x">`)・**タグ内空白** (`<tool_call >`) の変種が素通りして
 * 表示・コピー・Codex/Snippet 抽出・要約に漏れる (d0766f59 緩和の回避)。
 * case-insensitive + 任意属性を許容して取りこぼしを塞ぐ。
 *
 * ストリーミング中はアクティブメッセージの delta 毎に呼ばれるため、RegExp は
 * モジュール定数として一度だけコンパイルする。全て非 global フラグで
 * lastIndex 状態を持たず、インスタンス共有は安全。
 */
interface TagMatchers {
  /** <tag>, <tag attr...>, <tag > を許容（属性は次の '>' まで）。 */
  open: RegExp;
  close: RegExp;
  /** 任意位置にタグの開きがあるか（byte-identical 早期 return 判定用）。 */
  hasOpen: RegExp;
}
const TAG_MATCHERS: readonly TagMatchers[] = TOOL_BLOCK_TAGS.map((tag) => ({
  open: new RegExp(`<${tag}(?:\\s[^>]*)?>`, "i"),
  close: new RegExp(`</${tag}\\s*>`, "i"),
  hasOpen: new RegExp(`<${tag}(?:\\s|>|/)`, "i"),
}));

/** `<tag …>…</tag>` ブロックをすべて除去する。閉じタグ無しは以降を打ち切り。 */
function stripTagBlocks(text: string, { open, close }: TagMatchers): string {
  let out = "";
  let rest = text;
  let m = open.exec(rest);
  while (m) {
    out += rest.slice(0, m.index);
    const after = rest.slice(m.index + m[0].length);
    const closeM = close.exec(after);
    if (!closeM) {
      // 閉じタグ無し: 開きタグ以降を破棄（strip_think_blocks と同セマンティクス）。
      rest = "";
      break;
    }
    rest = after.slice(closeM.index + closeM[0].length);
    m = open.exec(rest);
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
  const hasTag = TAG_MATCHERS.some((m) => m.hasOpen.test(text));
  if (!hasTag) return text;

  let out = text;
  for (const m of TAG_MATCHERS) {
    out = stripTagBlocks(out, m);
  }
  // 除去で生じた連続空行を 1 段に畳んで前後をトリム。
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
