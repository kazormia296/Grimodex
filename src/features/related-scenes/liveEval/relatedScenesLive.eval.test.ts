/**
 * related-scenes ライブ実埋め込み eval(この環境で実行可能)。
 *
 * production と同一の int8 ONNX(ruri/bge)で実埋め込みしたベクトル
 * (embeddings.generated.json, scripts/relatedScenesLiveEmbed.mjs が生成)を読み、
 * **実関数** selectRelatedPastScenes / buildSparseQuery / toFtsMatchQuery を使って
 * dense / hybrid(①) / +seed拡張(③) / +相対救済(②) の 4 モードを走らせ、
 * corpus.json の qrels に対する Recall@k・Precision・MRR を実測する。
 *
 * 計測ゲート(残課題 #1/#2)をこの環境で回すための harness:
 *  - #1 hybrid が dense の retrieval を改善するか(admission recall 単調 + ranking)
 *  - #2 ②③ の効き目と過剰 admit していないか(precision)
 *
 * 注意/正直な限界:
 *  - sparse は FTS5(SQLite)がこの env で動かないため **trigram 重なりサロゲート**で近似
 *    (FTS5 trigram tokenizer を模す。bm25 重みは厳密には異なる)。
 *  - embeddings.generated.json が無ければ skip(通常 CI では生成しないため)。生成方法は
 *    scripts/relatedScenesLiveEmbed.mjs のヘッダ参照。
 *  - ruri は稀少漢字でトークナイズが Python 版と僅差(golden avg 0.991)。
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { SemanticSearchHit } from "@/features/semantic-search/api";
import {
  selectRelatedPastScenes,
  type SelectRelatedScenesOptions,
} from "../selectRelatedScenes";
import { buildSparseQuery } from "../seedTerms";
import {
  buildSemanticRecallQuery,
  recallParamsForLang,
} from "@/features/chat/semanticRecall";
import { tokenizeFtsQuery, codepointLength } from "@/lib/fts";
import {
  RELATED_SCENES_MAX,
  RELATED_SCENES_RELATIVE_GAP,
} from "../fetchRelatedScenes";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  fs.readFileSync(path.join(DIR, "corpus.json"), "utf8"),
);
const EMB_PATH = path.join(DIR, "embeddings.generated.json");
const hasEmb = fs.existsSync(EMB_PATH);
const emb = hasEmb ? JSON.parse(fs.readFileSync(EMB_PATH, "utf8")).vectors : {};
// 生成物 (gitignore) が無い / corpus とズレている場合は安全に skip(CI を壊さない)。
const requiredKeys = ["ja", "en"].flatMap((l: string) => [
  ...corpus[l].scenes.map((s: { id: string }) => `${l}:s:${s.id}`),
  ...corpus[l].cases.map((c: { id: string }) => `${l}:q:${c.id}`),
]);
const embReady = hasEmb && requiredKeys.every((k) => Array.isArray(emb[k]));

function cos(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/** FTS5 trigram tokenizer を模した文字 3-gram 集合(小文字化)。 */
function trigrams(s: string): Set<string> {
  const cps = [...s.toLowerCase()];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= cps.length; i++)
    out.add(cps.slice(i, i + 3).join(""));
  return out;
}

/**
 * sparse(FTS5/bm25)サロゲート: クエリと各 scene の trigram 重なり数で順位付け。
 * production は to_fts_match(空白トークン≥3)→FTS5 trigram match だが、この env では
 * SQLite FTS5 を回せないため trigram 重なりで近似(語彙一致の順位という本質は保つ)。
 */
function sparseRank(
  query: string,
  scenes: { id: string; body: string }[],
  limit: number,
): string[] {
  const q = trigrams(query);
  // 空白トークン≥3 が 1 つも無いクエリは production でも LIKE 退避相当なのでそのまま近似。
  return scenes
    .map((s) => {
      const g = trigrams(s.body);
      let n = 0;
      for (const t of q) if (g.has(t)) n++;
      return { id: s.id, n };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

interface Metrics {
  recallAt1: number;
  recallAt3: number;
  recallAll: number;
  precision: number;
  mrr: number;
}
function score(returned: string[], qrels: string[]): Metrics {
  const rel = new Set(qrels);
  const hitAt = (k: number) =>
    returned.slice(0, k).filter((r) => rel.has(r)).length / qrels.length;
  let mrr = 0;
  for (let i = 0; i < returned.length; i++) {
    if (rel.has(returned[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }
  const inter = returned.filter((r) => rel.has(r)).length;
  return {
    recallAt1: hitAt(1),
    recallAt3: hitAt(3),
    recallAll: hitAt(RELATED_SCENES_MAX),
    precision: returned.length ? inter / returned.length : 0,
    mrr,
  };
}
function avg(ms: Metrics[]): Metrics {
  const k = ms.length || 1;
  const s = (f: (m: Metrics) => number) => ms.reduce((a, m) => a + f(m), 0) / k;
  return {
    recallAt1: s((m) => m.recallAt1),
    recallAt3: s((m) => m.recallAt3),
    recallAll: s((m) => m.recallAll),
    precision: s((m) => m.precision),
    mrr: s((m) => m.mrr),
  };
}

const MODES = [
  "dense",
  "hybrid",
  "hybrid+seed(3)",
  "hybrid+seed+rel(2)",
] as const;
type Mode = (typeof MODES)[number];

function runCase(
  lang: string,
  c: {
    id: string;
    currentBody: string;
    denseQueryText: string;
    currentOrder: number;
    qrels: string[];
  },
  mode: Mode,
): string[] {
  const cdef = corpus[lang];
  const scenes: { id: string; title: string; body: string; order: number }[] =
    cdef.scenes;
  const params = recallParamsForLang(lang);
  const qVec: number[] = emb[`${lang}:q:${c.id}`];

  const hits: SemanticSearchHit[] = scenes.map((s) => ({
    sceneId: s.id,
    sceneTitle: s.title,
    chunkText: s.body,
    charStart: 0,
    charEnd: s.body.length,
    score: cos(qVec, emb[`${lang}:s:${s.id}`]),
    dialogueRatio: 0,
  }));

  const sceneOrder = new Map<string, number>(
    scenes.map((s) => [s.id, s.order]),
  );
  sceneOrder.set("__current__", c.currentOrder);

  const tail = buildSemanticRecallQuery({
    userMessage: "",
    sceneBody: c.currentBody,
  });
  const sparseQuery =
    mode === "dense"
      ? ""
      : mode === "hybrid"
        ? tail
        : buildSparseQuery(tail, c.currentBody);
  const sparseSceneIds =
    mode === "dense" ? [] : sparseRank(sparseQuery, scenes, 10);

  const opts: SelectRelatedScenesOptions = {
    currentSceneId: "__current__",
    sceneOrder,
    minScore: params.gateScore,
    maxScenes: RELATED_SCENES_MAX,
    sparseSceneIds,
    rescueMargin: 0.05,
  };
  if (mode === "hybrid+seed+rel(2)") {
    opts.relativeRescue = { gap: RELATED_SCENES_RELATIVE_GAP };
  }
  return selectRelatedPastScenes(hits, opts).map((r) => r.sceneId);
}

describe.skipIf(!embReady)("related-scenes live eval (real embeddings)", () => {
  it("denseQueryText が buildSemanticRecallQuery と一致(埋め込みキー整合)", () => {
    for (const lang of ["ja", "en"]) {
      for (const c of corpus[lang].cases) {
        expect(
          buildSemanticRecallQuery({
            userMessage: "",
            sceneBody: c.currentBody,
          }),
        ).toBe(c.denseQueryText);
      }
    }
  });

  const report: Record<string, Record<Mode, Metrics>> = {};
  for (const lang of ["ja", "en", "all"])
    report[lang] = {} as Record<Mode, Metrics>;

  it("4 モードの実測 Recall@k / Precision / MRR を集計", () => {
    for (const mode of MODES) {
      const byLang: Record<string, Metrics[]> = { ja: [], en: [] };
      for (const lang of ["ja", "en"]) {
        for (const c of corpus[lang].cases) {
          byLang[lang].push(score(runCase(lang, c, mode), c.qrels));
        }
      }
      report.ja[mode] = avg(byLang.ja);
      report.en[mode] = avg(byLang.en);
      report.all[mode] = avg([...byLang.ja, ...byLang.en]);
    }
    // 人間可読レポート(計測値)。
    const f = (m: Metrics) =>
      `R@1=${m.recallAt1.toFixed(2)} R@3=${m.recallAt3.toFixed(2)} R@all=${m.recallAll.toFixed(2)} P=${m.precision.toFixed(2)} MRR=${m.mrr.toFixed(2)}`;
    const lines: string[] = [
      "",
      "=== related-scenes live eval (real ONNX embeddings) ===",
    ];
    for (const lang of ["ja", "en", "all"]) {
      lines.push(`[${lang}]`);
      for (const mode of MODES)
        lines.push(`  ${mode.padEnd(20)} ${f(report[lang][mode])}`);
    }
    const text = lines.join("\n");
    // 既定では静か(CI ノイズ回避)。レポートを見るには RS_EVAL_REPORT=1 か =path で実行。
    if (process.env.RS_EVAL_REPORT) {
      console.log(text);
      if (process.env.RS_EVAL_REPORT !== "1")
        fs.writeFileSync(process.env.RS_EVAL_REPORT, text);
    }
    expect(report.all.dense).toBeDefined();
  });

  it("#1 hybrid は admission recall で dense を下回らない(単調)", () => {
    // sparse/relative は admit を追加するのみ(削らない)。cap=RELATED_SCENES_MAX(=8)≥corpus
    // なので truncation 無し → recallAll は dense ≤ hybrid ≤ +seed ≤ +rel が保証される。
    for (const lang of ["ja", "en"]) {
      const r = report[lang];
      expect(r.hybrid.recallAll).toBeGreaterThanOrEqual(r.dense.recallAll);
      expect(r["hybrid+seed(3)"].recallAll).toBeGreaterThanOrEqual(
        r.hybrid.recallAll,
      );
      expect(r["hybrid+seed+rel(2)"].recallAll).toBeGreaterThanOrEqual(
        r["hybrid+seed(3)"].recallAll,
      );
    }
  });

  it("#1b dense 勝者アンカー: hybrid の R@1 は dense を下回らない(トレードオフ解消)", () => {
    // 旧 hybrid は RRF が語彙一致の弱関連を dense 勝者の上へ押し R@1 を落としていた
    // (all 0.40→0.29)。dense 勝者アンカー後は、confident 勝者がいる時 hybrid の rank1 =
    // dense の rank1 (同一シーン) になり、勝者不在なら dense は空(R@1=0)なので hybrid≥dense
    // が構造的に保証される。+seed/+rel も admit を足すだけで rank1 を奪わない。
    for (const lang of ["ja", "en", "all"]) {
      const r = report[lang];
      expect(r.hybrid.recallAt1).toBeGreaterThanOrEqual(r.dense.recallAt1);
      expect(r["hybrid+seed(3)"].recallAt1).toBeGreaterThanOrEqual(
        r.dense.recallAt1,
      );
      expect(r["hybrid+seed+rel(2)"].recallAt1).toBeGreaterThanOrEqual(
        r.dense.recallAt1,
      );
    }
    // 実測の到達点(本コーパス・決定的埋め込み): hybrid は R@1/R@3/recall/MRR で dense を
    // 同等以上にしつつ recall を 0.88→1.00 に引き上げる(precision のみ recall の対価で低下)。
    expect(report.all.hybrid.mrr).toBeGreaterThanOrEqual(report.all.dense.mrr);
  });

  it("#2 相対救済を入れても precision が崩壊しない(団子を溢れさせない)", () => {
    expect(report.all["hybrid+seed+rel(2)"].precision).toBeGreaterThan(0.3);
  });

  it("trigram sparse サロゲートは ③ で固有名詞語(Latin)を拾う(EN c3=Wrenna)", () => {
    // 健全性: EN の Wrenna は冒頭のみ。tail だけだと sparse で en-s6 を拾えないが、
    // buildSparseQuery が 'Wrenna' を seed 追加することで拾えるようになる。
    const c = corpus.en.cases.find((x: { id: string }) => x.id === "en-c3");
    const tail = buildSemanticRecallQuery({
      userMessage: "",
      sceneBody: c.currentBody,
    });
    const seeds = buildSparseQuery(tail, c.currentBody);
    expect(seeds.includes("Wrenna")).toBe(true);
    // tokenizer が Wrenna を ≥3 codepoint トークンとして残す(FTS マッチ可能)。
    expect(
      tokenizeFtsQuery(seeds).some(
        (t) => t === "Wrenna" && codepointLength(t) >= 3,
      ),
    ).toBe(true);
  });
});
