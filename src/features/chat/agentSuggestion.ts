// 「Agent mode で送ると良さそうか」「Agent mode で再試行を勧めるべきか」を
// 判定する軽量ヒューリスティクス。LLM 呼び出しは行わない。
//
// - shouldSuggestAgentMode: 送信前。入力テキストから探索性の高さを推定
// - looksLikeMissingInfo:   応答後。AI が「情報が足りない」と返したか推定
//
// どちらも誤検知より見逃しを優先 (高精度低再現率)。チップやボタンの
// 表示にだけ使うので、見落としても害は薄い。

// 探索を要求しがちな日本語キーワード。ja/en で別配列にし、
// 中点や形態素の揺れには target.includes で素朴対応する。
const JA_EXPLORATION_KEYWORDS = [
  "について",
  "教えて",
  "詳しく",
  "整理して",
  "比較",
  "まとめて",
  "全部",
  "すべて",
  "全体",
  "関連",
  "背景",
  "経緯",
  "どんな",
  "どういう",
  "どうやって",
  "なぜ",
  "どうして",
  "誰",
  "何が",
  "どこ",
  "いつ",
  "一覧",
];

const EN_EXPLORATION_KEYWORDS = [
  "what is",
  "what are",
  "what's",
  "who is",
  "who are",
  "who's",
  "where is",
  "where are",
  "where's",
  "why ",
  "why's",
  "how ",
  "how's",
  "tell me",
  "explain",
  "summarize",
  "summary",
  "compare",
  "list ",
  "all of",
  "everything",
  "relate",
  "related",
  "background",
  "context",
  "overview",
];

// 「情報が足りない」「Codex に該当無し」を示唆する応答パターン。
// ja のみ。fiction の地の文で頻出する「わかりません」単独は弾く。
const MISSING_INFO_PATTERNS = [
  /情報が(?:見当たりません|ありません|不足|足りません)/,
  /(?:該当|記載)(?:する情報|が)?(?:はありません|がありません|無し)/,
  /(?:Codex|コーデックス|資料)(?:に|から).{0,10}(?:見当たりません|ありません|確認できません)/,
  /現時点(?:では|で)(?:.{0,15})(?:把握できていません|わかりません|不明)/,
  /(?:お答えできる|答えられる)(?:十分な)?情報(?:が|は)(?:ありません|不足)/,
];

export interface AgentSuggestionInput {
  text: string;
  hasMentions: boolean; // @言及があれば既に対象が特定されている
}

/**
 * 送信前のヒューリスティクス。Agent mode をユーザーに勧めるかどうか。
 *
 * ルール (advisor 指摘反映):
 * - キーワード必須: 探索系の語が一つも無ければ false (長文の draft 依頼を拾わない)
 * - 長さ補強: キーワードがあっても短すぎる (< 12 文字) は誤爆しやすいので false
 * - @言及があれば false: 既に Spotlight 経由で対象が確定している想定
 */
export function shouldSuggestAgentMode(input: AgentSuggestionInput): boolean {
  const text = input.text.trim();
  if (text.length < 12) return false;
  if (input.hasMentions) return false;

  const lower = text.toLowerCase();
  const hitJa = JA_EXPLORATION_KEYWORDS.some((kw) => text.includes(kw));
  const hitEn = EN_EXPLORATION_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hitJa && !hitEn) return false;

  return true;
}

/**
 * 応答後ヒューリスティクス。AI が「情報が足りない」と返したように見えるか。
 *
 * 高精度低再現率を維持: 創作テキスト中の "わかりません" 単独はマッチさせない。
 */
export function looksLikeMissingInfo(assistantText: string): boolean {
  if (!assistantText) return false;
  return MISSING_INFO_PATTERNS.some((re) => re.test(assistantText));
}
