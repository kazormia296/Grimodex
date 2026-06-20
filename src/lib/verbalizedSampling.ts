/**
 * Verbalized Sampling (VS) — mode-collapse 緩和のための推論時プロンプト指示。
 *
 * 出典: Zhang et al. "Verbalized Sampling: How to Mitigate Mode Collapse and
 * Unlock LLM Diversity" (arXiv:2510.01171).
 *
 * 単一の「最も尤もらしい」応答に収束する代わりに、妥当な応答の分布を意識させ、
 * その「裾」からサンプリングさせることで平均値（典型的なステレオタイプ）から
 * 離れた多様な案を引き出す。学習不要・モデル非依存・推論時のプロンプトのみ。
 *
 * このヘルパは「サンプリングの方針」だけを返す。各サーフェスの出力フォーマット
 * （AI Branch のカード区切り等）は呼び出し側が定義する。
 */
export type VsLang = "ja" | "en";

export interface VsOptions {
  /** 裾しきい値。各案は「確率 < threshold に相当する」典型度の低い案にさせる。既定 0.1。 */
  threshold?: number;
  /**
   * 「まず非凡な切り口を考えてから」という CoT 前置きを足す。
   * 大型モデルで多様性・品質を押し上げる一方、小型/ローカルモデルでは認知負荷で
   * 品質が落ちうるため、呼び出し側でモデル能力に応じて切り替えること。既定 false。
   */
  cot?: boolean;
  /**
   * 各案に推定確率を添えさせるか。true=出力に確率を書かせる（呼び出し側がパース/
   * 並べ替えに使う想定）。false（既定）=裾からのサンプリングは内部で行い、確率の
   * 数値は出力させない（チャットのように生テキストを人が読む面向け）。
   */
  emitProbability?: boolean;
}

const DEFAULT_THRESHOLD = 0.1;

export function buildVsInstruction(lang: VsLang, opts: VsOptions = {}): string {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cot = opts.cot ?? false;
  const emitProbability = opts.emitProbability ?? false;

  if (lang === "en") {
    const lines: string[] = ["# Diversity directive (verbalized sampling)"];
    if (cot) {
      lines.push(
        "First, brainstorm several unconventional, non-obvious angles on this theme in your head, then build the ideas from those angles.",
      );
    }
    lines.push(
      `Do not converge on the typical, most-likely ideas. Treat the set of plausible ideas as a distribution and sample from its tails: each idea should be an atypical one whose probability would be below ${threshold}.`,
    );
    lines.push(
      "Make the ideas diverge from one another at the level of premise, setting and structure — not merely wording or tone. Avoid surface reskins of the same core idea.",
    );
    if (emitProbability) {
      lines.push(
        "Attach to each idea an estimated probability (0–1) reflecting how typical it is; prefer the lower-probability (rarer) ideas.",
      );
    } else {
      lines.push(
        "Estimate each idea's typicality internally to pick from the tails, but do not output the probability numbers themselves.",
      );
    }
    return lines.join("\n");
  }

  const lines: string[] = ["# 多様性の指示（Verbalized Sampling）"];
  if (cot) {
    lines.push(
      "まず、このテーマに対する非凡で意外な切り口を頭の中で複数挙げ、その切り口から案を構成してください。",
    );
  }
  lines.push(
    `典型的でありがちな案に収束させないでください。妥当な案の集合を一つの分布とみなし、その分布の裾からサンプリングすること。各案は、確率にして ${threshold} 未満に相当する、典型度の低い発想にしてください。`,
  );
  lines.push(
    "各案は、語り口や言い回しだけでなく、前提・設定・構造のレベルで互いに分岐させてください。同じ核を表層だけ変えた焼き直しは避けること。",
  );
  if (emitProbability) {
    lines.push(
      "各案には、その案がどれだけ典型的かを表す推定確率（0〜1）を添えてください。確率の低い（珍しい）案を優先します。",
    );
  } else {
    lines.push(
      "各案の典型度は内部で見積もるだけにとどめ、確率の数値は出力に書かないでください。",
    );
  }
  return lines.join("\n");
}
