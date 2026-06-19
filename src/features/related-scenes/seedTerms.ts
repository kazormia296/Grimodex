/**
 * 現在シーン本文から固有名詞らしい seed 語を抽出し、sparse (FTS5/bm25) クエリを補強する。
 *
 * dense の seed (本文末尾 500 字) は長いシーンで主題を代表しないことがある。本文全体から
 * 「カタカナ連続」「大文字始まりの Latin 語/連語」= 言語横断で固有名詞シグナルが強い
 * トークンを拾い、sparse 腕 (語彙一致) に渡して人名・地名の recall を補う。LLM 不要・決定的
 * なので、シーンを開く度に走る related-scenes パネルでも UI 遅延を生まない (HyDE は不可)。
 *
 * 制約: 漢字の固有名詞 (日本語の人名/地名の多く) は形態素解析なしには切り出せないため
 * 対象外 (JS 層に形態素器が無い)。カタカナ/Latin に限定する。漢字対応は将来課題
 * (Rust lindera 経由)。本関数は recall 補強の seed 生成のみで、最終的な FTS マッチ整形は
 * Rust 側 `to_fts_match` が行う。
 */

// カタカナ (全角 + 長音符 + 半角) の連続。中黒「・」は区切りとして除外。
const KATAKANA_RUN = /[ァ-ヺーㇰ-ㇿｦ-ﾟ]{2,}/g;
// 大文字始まりの Latin 語、およびその連語 (例: "Iron Crown")。
const LATIN_PROPER = /[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)*/g;

/**
 * 本文から固有名詞 seed 語を出現頻度順 (= 主題語優先) に最大 maxTerms 件返す。
 * 2 文字未満は除外。同頻度は出現順で安定化 (決定的)。
 */
export function extractProperNounSeeds(body: string, maxTerms = 8): string[] {
  if (!body) return [];
  const counts = new Map<string, number>();
  const add = (raw: string) => {
    const term = raw.trim();
    // コードポイント数で 2 未満を除外 (サロゲートを 1 と数える素朴 length は使わない)。
    if ([...term].length < 2) return;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  };
  for (const m of body.matchAll(KATAKANA_RUN)) add(m[0]);
  for (const m of body.matchAll(LATIN_PROPER)) add(m[0]);

  // 頻度降順。Map は挿入順を保つので、stable sort と合わせて同頻度は出現順で決定的。
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, maxTerms))
    .map(([term]) => term);
}

/**
 * dense seed (tail) に本文全体の固有名詞 seed を足した sparse 用クエリを組む。
 * seed が無ければ tail をそのまま返す (= 従来の sparse クエリ)。
 */
export function buildSparseQuery(tailQuery: string, body: string): string {
  const seeds = extractProperNounSeeds(body);
  return seeds.length > 0 ? `${tailQuery}\n${seeds.join(" ")}` : tailQuery;
}
