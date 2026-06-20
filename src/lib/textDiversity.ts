/**
 * 語彙ベースの多様性メトリクス。文字 bigram の集合類似度で測るため、日本語の
 * 単語分割や埋め込みモデル(Rust/ONNX 経由でテスト環境に無い)を必要としない。
 *
 * 用途: Verbalized Sampling の効果計測 — 同一テーマで VS-off / VS-on を実モデルに
 * 叩き、生成された案集合の「平均ペア相違度」を比較する (高いほど多様)。
 * 注意: これは語彙レベルの proxy。設定/構造レベルの多様性 (Artificial Hivemind)
 * までは捉えないため、最終判断は生成物の人手/LLM 確認と併用すること。
 */

/** 文字 bigram 集合。空白を除去し小文字化してから連続2文字を集める。 */
export function charBigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, "").toLowerCase();
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

/** Jaccard 類似度 |A∩B|/|A∪B|。両方空なら 1 (同一とみなす)。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * テキスト集合の平均ペア相違度 = 1 − 平均ペア Jaccard 類似度。
 * 0 = 全て同一、1 = 全ペアが完全に非類似。要素 < 2 のときは 0。
 */
export function meanPairwiseDistinctness(texts: string[]): number {
  const grams = texts.map(charBigrams);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      sum += 1 - jaccard(grams[i], grams[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}
