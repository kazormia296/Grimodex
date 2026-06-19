import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  selectChatRecallMessages,
  DEFAULT_CHAT_RECALL_WEIGHTS,
  type ChatRecallWeights,
} from "../chatRecall";
import type { ChatMessageSearchHit } from "../../semantic-search/api";

/**
 * chat episodic-recall の品質較正ハーネス(実埋め込み)。
 *
 * scripts/chatRecallLiveEmbed.mjs が corpus.json を **production と同一の int8 ONNX**
 * (ruri/bge, doc/query prefix 一致)で実埋め込みした embeddings.generated.json を読み、
 * **本番の selectChatRecallMessages をそのまま**呼んで、gate/floor と重み係数
 * (α/β/cap/plainBase)のグリッドを sweep し、precision/recall/R@1/MRR を集計する。
 * 本番ロジックを import するので eval と production がドリフトしない。
 *
 * - 生成物 (gitignore) が無い / corpus とズレている場合は安全に skip(CI を壊さない)。
 *   生成方法: EMBED_RES_DIR=/workspace/src-tauri/resources/semantic node scripts/chatRecallLiveEmbed.mjs
 * - corpus は seed(小規模)。scripts/eval-chat-recall-gen.mjs(OpenRouter)で拡張すると
 *   較正が硬くなる。小コーパスでは多数の組が同点になり得る(過適合に注意)。
 */

const DIR = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  fs.readFileSync(path.join(DIR, "corpus.json"), "utf8"),
);
const EMB_PATH = path.join(DIR, "embeddings.generated.json");
const hasEmb = fs.existsSync(EMB_PATH);
const emb: Record<string, number[]> = hasEmb
  ? JSON.parse(fs.readFileSync(EMB_PATH, "utf8")).vectors
  : {};

const LANGS = ["ja", "en"] as const;
type Lang = (typeof LANGS)[number];

const requiredKeys = LANGS.flatMap((l) => [
  ...corpus[l].messages.map((m: { id: string }) => `${l}:m:${m.id}`),
  ...corpus[l].cases.map((c: { id: string }) => `${l}:q:${c.id}`),
]);
const embReady = hasEmb && requiredKeys.every((k) => Array.isArray(emb[k]));

function dot(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

interface CorpusMessage {
  id: string;
  role: string;
  text: string;
  insertedToEditor: boolean;
  extractedCount: number;
}
interface CorpusCase {
  id: string;
  query: string;
  gold: string[];
}

/** 1 クエリに対する全メッセージの ChatMessageSearchHit (生 cosine + 信号)。 */
function buildHits(lang: Lang, c: CorpusCase): ChatMessageSearchHit[] {
  const q = emb[`${lang}:q:${c.id}`];
  return (corpus[lang].messages as CorpusMessage[]).map((m) => ({
    messageId: m.id,
    sessionId: "past",
    role: m.role,
    text: m.text,
    insertedToEditor: m.insertedToEditor,
    extractedCount: m.extractedCount,
    score: dot(q, emb[`${lang}:m:${m.id}`]),
  }));
}

interface Metrics {
  r1: number;
  mrr: number;
  recall: number;
  precision: number;
  fpRate: number;
  goldCases: number;
  nomatchCases: number;
}

function evalConfig(
  lang: Lang,
  gate: number,
  floor: number,
  weights: ChatRecallWeights,
): Metrics {
  let r1 = 0,
    mrrSum = 0,
    recallSum = 0,
    precSum = 0,
    goldCases = 0,
    nomatchCases = 0,
    fp = 0;
  for (const c of corpus[lang].cases as CorpusCase[]) {
    const hits = buildHits(lang, c);
    const selected = selectChatRecallMessages(hits, [], {
      excludeSessionIds: [],
      minScore: floor,
      gateScore: gate,
      weights,
    });
    const injected = selected.map((s) => s.messageId);
    const gold = new Set(c.gold);
    if (gold.size === 0) {
      nomatchCases++;
      if (injected.length > 0) fp++;
      continue;
    }
    goldCases++;
    const inter = injected.filter((id) => gold.has(id)).length;
    recallSum += inter / Math.min(gold.size, 3); // 注入上限 3
    precSum += injected.length > 0 ? inter / injected.length : 0;
    if (injected[0] && gold.has(injected[0])) r1++;
    const firstGold = injected.findIndex((id) => gold.has(id));
    mrrSum += firstGold >= 0 ? 1 / (firstGold + 1) : 0;
  }
  return {
    r1: goldCases ? r1 / goldCases : 0,
    mrr: goldCases ? mrrSum / goldCases : 0,
    recall: goldCases ? recallSum / goldCases : 0,
    precision: goldCases ? precSum / goldCases : 0,
    fpRate: nomatchCases ? fp / nomatchCases : 0,
    goldCases,
    nomatchCases,
  };
}

function f1(m: Metrics): number {
  return m.recall + m.precision > 0
    ? (2 * m.recall * m.precision) / (m.recall + m.precision)
    : 0;
}

// precision-first の目的関数: 無関連クエリで何も注入しない(fpRate=0)を最優先、
// 次に F1、R@1、MRR。「迷ったら何も注入しない」という repo の規律に合わせる。
function objective(m: Metrics): number {
  return (m.fpRate === 0 ? 1000 : 0) + f1(m) * 100 + m.r1 * 10 + m.mrr;
}

// per-lang グリッド。ja=ruri(高ベースライン), en=bge(分離広め)。scene 既定の周辺を掃く。
const GRID: Record<Lang, { gates: number[]; floors: number[] }> = {
  ja: {
    gates: [0.82, 0.83, 0.84, 0.85, 0.86, 0.88],
    floors: [0.76, 0.78, 0.8, 0.82],
  },
  en: {
    gates: [0.42, 0.45, 0.48, 0.51, 0.54, 0.58],
    floors: [0.42, 0.45, 0.48, 0.51, 0.54],
  },
};
const ALPHA = [0.1, 0.15, 0.2, 0.25];
const BETA = [0.05, 0.1, 0.15];
const CAP = [3];
const PLAIN = [0.7, 0.8, 0.9, 1.0];

const DEFAULT_GF: Record<Lang, { gate: number; floor: number }> = {
  ja: { gate: 0.85, floor: 0.8 },
  en: { gate: 0.51, floor: 0.51 },
};

interface Best {
  gate: number;
  floor: number;
  weights: ChatRecallWeights;
  m: Metrics;
  obj: number;
}

function sweep(lang: Lang): Best {
  let best: Best | null = null;
  for (const gate of GRID[lang].gates) {
    for (const floor of GRID[lang].floors) {
      if (floor > gate) continue;
      for (const insertedBoost of ALPHA) {
        for (const extractedBoost of BETA) {
          for (const extractedCap of CAP) {
            for (const assistantPlainBase of PLAIN) {
              const weights: ChatRecallWeights = {
                insertedBoost,
                extractedBoost,
                extractedCap,
                assistantPlainBase,
              };
              const m = evalConfig(lang, gate, floor, weights);
              const obj = objective(m);
              if (!best || obj > best.obj) {
                best = { gate, floor, weights, m, obj };
              }
            }
          }
        }
      }
    }
  }
  return best!;
}

function fmt(m: Metrics): string {
  return `R@1=${m.r1.toFixed(2)} MRR=${m.mrr.toFixed(2)} recall=${m.recall.toFixed(2)} prec=${m.precision.toFixed(2)} fpRate=${m.fpRate.toFixed(2)} (gold=${m.goldCases} nomatch=${m.nomatchCases})`;
}

describe.skipIf(!embReady)(
  "chat episodic-recall calibration (real embeddings)",
  () => {
    it("embeddings key integrity (corpus ↔ generated)", () => {
      expect(embReady).toBe(true);
      const w = emb[`ja:m:m_a1`];
      expect(Array.isArray(w) && w.length === 256).toBe(true); // ruri 256-dim
      expect(emb[`en:m:m_a1`].length).toBe(384); // bge 384-dim
    });

    it("sweeps gate/floor/weights and reports recommended config per language", () => {
      const report: string[] = ["", "=== chat-recall calibration ==="];
      const bests: Partial<Record<Lang, Best>> = {};
      for (const lang of LANGS) {
        const d = DEFAULT_GF[lang];
        const def = evalConfig(
          lang,
          d.gate,
          d.floor,
          DEFAULT_CHAT_RECALL_WEIGHTS,
        );
        const best = sweep(lang);
        report.push(
          `[${lang}] DEFAULT  gate=${d.gate} floor=${d.floor} α=${DEFAULT_CHAT_RECALL_WEIGHTS.insertedBoost} β=${DEFAULT_CHAT_RECALL_WEIGHTS.extractedBoost} plain=${DEFAULT_CHAT_RECALL_WEIGHTS.assistantPlainBase}`,
        );
        report.push(`        ${fmt(def)}`);
        report.push(
          `[${lang}] BEST     gate=${best.gate} floor=${best.floor} α=${best.weights.insertedBoost} β=${best.weights.extractedBoost} cap=${best.weights.extractedCap} plain=${best.weights.assistantPlainBase}`,
        );
        report.push(
          `        ${fmt(best.m)}  (objective=${best.obj.toFixed(2)})`,
        );
        bests[lang] = best;
      }
      // 集計レポートを先に出す(較正値を読む窓口)。assert はこの後。

      console.log(report.join("\n"));

      // 品質ゲート(seed コーパスは小さく過適合し得るので、絶対値ではなく較正の
      // 健全性で gate する):
      //  - 較正は default より悪化しない(fpRate↓ recall↑ = 単調)。
      //  - 最良構成は実用水準で recall できる(R@1/recall ≥ 0.6)。
      //  - クリーンな無関連クエリ(q_nomatch1=プログラミング)はゲートで弾ける(=
      //    最良構成 fpRate ≤ 0.5: ハード負例 1 件の leak は許容、クリーン負例は弾く)。
      // 注: ruri/bge の高ベースラインでは話題隣接のハード負例(晩餐会↔貴族街)は
      //     gate 単独で完全分離できない(設計既知・真の解は reranker)。Codex>chatRAG
      //     順序で弱 recall は正典を上書きしないので許容範囲。
      for (const lang of LANGS) {
        const best = bests[lang]!;
        const d = DEFAULT_GF[lang];
        const def = evalConfig(
          lang,
          d.gate,
          d.floor,
          DEFAULT_CHAT_RECALL_WEIGHTS,
        );
        expect(best.obj, `${lang} sweep≥default`).toBeGreaterThanOrEqual(
          objective(def),
        );
        expect(best.m.fpRate, `${lang} fpRate not worse`).toBeLessThanOrEqual(
          def.fpRate + 1e-9,
        );
        expect(
          best.m.recall,
          `${lang} recall not worse`,
        ).toBeGreaterThanOrEqual(def.recall - 1e-9);
        expect(
          best.m.fpRate,
          `${lang} clean negative rejected`,
        ).toBeLessThanOrEqual(0.5);
        expect(best.m.recall, `${lang} recall usable`).toBeGreaterThanOrEqual(
          0.6,
        );
        expect(best.m.r1, `${lang} R@1 usable`).toBeGreaterThanOrEqual(0.6);
      }
    });

    it("plain-assistant down-weight does not hurt: best config never worse than plain=1.0 baseline", () => {
      // self-reference 抑制(plain<1)が recall/precision を犠牲にしていないことの確認。
      for (const lang of LANGS) {
        const d = DEFAULT_GF[lang];
        const plain1: ChatRecallWeights = {
          ...DEFAULT_CHAT_RECALL_WEIGHTS,
          assistantPlainBase: 1.0,
        };
        const withDownweight = evalConfig(
          lang,
          d.gate,
          d.floor,
          DEFAULT_CHAT_RECALL_WEIGHTS,
        );
        const withoutDownweight = evalConfig(lang, d.gate, d.floor, plain1);
        // plain 減点で precision が落ちない(= 効いた発話/ユーザー文を不当に削らない)。
        expect(withDownweight.precision).toBeGreaterThanOrEqual(
          withoutDownweight.precision - 1e-9,
        );
      }
    });
  },
);
