// 正式な試験の規模の見積り（事前登録 1.3）。【推測】：pilot の B−A（Sonnet）の観測値を入力にした計算で、
// 正式な試験の設計（質問の作り方・作品の選び方・主指標の定義）が pilot と同じであることを仮定する。
import { loadScores, questionArmScores } from "./scores.mjs";
import { round } from "./lib.mjs";

// --- 分布関数（外部ライブラリなし）---
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function tCdf(t, df) {
  const x = df / (df + t * t);
  const p = 0.5 * ibeta(df / 2, 0.5, x);
  return t > 0 ? 1 - p : p;
}
export function tQuantile(p, df) { // 下側確率 p の分位点（二分法）
  let lo = -200, hi = 200;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (tCdf(mid, df) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const zq = (p) => tQuantile(p, 1e6);

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };

const ALPHA = 0.05, POWER = 0.8;
const DELTAS = [0.03, 0.05, 0.1];
const CLUSTER_COUNTS = [4, 8, 12, 16, 24, 32]; // 作品×地点の cell 数（作品数 = cell 数 / 2、各作品 2 地点の前提）

export function computeSizing(dataDir) {
  const rows = loadScores(dataDir, "sonnet");
  const q = questionArmScores(rows);
  const qids = [...new Set([...q.values()].map((e) => e.qid))].sort();
  const d = qids.map((id) => {
    const a = q.get(`${id}|A`), b = q.get(`${id}|B`);
    return { qid: id, cellId: a.cellId, work: a.work, d: b.score - a.score, itemsA: a.items[0], itemsB: b.items[0] };
  });
  const n = d.length;
  const dMean = mean(d.map((x) => x.d));
  const dVar = variance(d.map((x) => x.d));

  // 項目の対応表（A と B の再現）。不一致率 = どちらか片方だけが再現した項目の割合。
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
  for (const x of d) x.itemsA.forEach((av, i) => { const bv = x.itemsB[i]; if (av && bv) n11++; else if (av) n10++; else if (bv) n01++; else n00++; });
  const nItems = n11 + n10 + n01 + n00;
  const psi = (n10 + n01) / nItems; // 不一致率
  const itemDiff = (n01 - n10) / nItems;

  // cell ごと
  const cells = {};
  for (const x of d) (cells[x.cellId] ??= []).push(x.d);
  const cellStats = Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { n: v.length, mean: round(mean(v)), sd: round(Math.sqrt(variance(v))) }]));

  // 一元配置の変量効果（cell が cluster）。不均衡なので n0 を使う。
  const K = Object.keys(cells).length;
  const grand = dMean;
  let ssb = 0, ssw = 0;
  for (const v of Object.values(cells)) { const m = mean(v); ssb += v.length * (m - grand) ** 2; ssw += v.reduce((s, x) => s + (x - m) ** 2, 0); }
  const msb = ssb / (K - 1), msw = ssw / (n - K);
  const n0 = (n - Object.values(cells).reduce((s, v) => s + v.length ** 2, 0) / n) / (K - 1);
  const sigmaC2raw = (msb - msw) / n0;
  const sigmaC2 = Math.max(0, sigmaC2raw);
  const sigmaE2 = msw;
  const icc = sigmaC2 / (sigmaC2 + sigmaE2);

  // 入れ子（作品 > 地点）の見積り。作品 2 件・地点 2 件ずつ。1 自由度で極めて不確か。
  const works = [...new Set(d.map((x) => x.work))].sort();
  const cellKeys = Object.keys(cells);
  const cellsOf = (w) => cellKeys.filter((k) => d.find((x) => x.cellId === k).work === w);
  const nBar = n / cellKeys.length;
  const workMeans = works.map((w) => mean(cellsOf(w).map((k) => mean(cells[k]))));
  const posVarPerWork = works.map((w) => { const m = cellsOf(w).map((k) => mean(cells[k])); return variance(m); });
  const posVar = mean(posVarPerWork); // cell 平均の作品内の分散 = σp² + σe²/nBar
  const sigmaP2 = Math.max(0, posVar - sigmaE2 / nBar);
  const betweenWork = variance(workMeans); // = σw² + (σp² + σe²/nBar)/2
  const sigmaW2raw = betweenWork - (sigmaP2 + sigmaE2 / nBar) / 2;
  const sigmaW2 = Math.max(0, sigmaW2raw);

  // pilot の B−A を「4 cell の平均」とみなした t 区間（cell の標本変動を含む。pilot 本体の bootstrap は cell を固定した層別）
  const cellMeans = Object.values(cells).map(mean);
  const cmMean = mean(cellMeans), cmSe = Math.sqrt(variance(cellMeans) / cellMeans.length);
  const cellTInterval = { meanOfCellMeans: round(cmMean), se: round(cmSe), df: cellMeans.length - 1, low: round(cmMean - tQuantile(0.975, cellMeans.length - 1) * cmSe), high: round(cmMean + tQuantile(0.975, cellMeans.length - 1) * cmSe) };

  const tz = (df) => tQuantile(1 - ALPHA / 2, df) + tQuantile(POWER, df);
  const zsum = zq(1 - ALPHA / 2) + zq(POWER);

  // (a) cluster を無視した対応のある差の質問数（楽観。下限）
  const noCluster = DELTAS.concat([round(dMean)]).map((delta) => ({
    delta, questions: Math.ceil((zsum * Math.sqrt(dVar) / delta) ** 2),
  }));
  // (a') 項目の不一致率（McNemar）から。項目は 1 質問に約 itemsPerQuestion 個あり、項目間の相関は無視する（楽観）。
  const itemsPerQuestion = nItems / n;
  const zA = zq(1 - ALPHA / 2), zB = zq(POWER);
  const mcnemar = DELTAS.concat([round(itemDiff)]).map((delta) => {
    const items = ((zA * Math.sqrt(psi) + zB * Math.sqrt(Math.max(0, psi - delta ** 2))) / delta) ** 2;
    return { delta, items: Math.ceil(items), questionsEquivalent: Math.ceil(items / itemsPerQuestion) };
  });

  // (b) cell を cluster とする。Var = σc²/C + σe²/(C·m)、C = cell 数、m = cell あたりの質問数。df = C−1 の t。
  const MS = [20, 40, 80];
  const requiredCells = (sc2) => DELTAS.flatMap((delta) => MS.map((m) => {
    for (let C = 3; C <= 400; C++) {
      if (tz(C - 1) * Math.sqrt(sc2 / C + sigmaE2 / (C * m)) <= delta) return { delta, questionsPerCell: m, cells: C, works: Math.ceil(C / 2), totalQuestions: C * m };
    }
    return { delta, questionsPerCell: m, cells: null, works: null, totalQuestions: null };
  }));
  // m 問/cell を固定したとき、cell 数ごとに検出できる最小の差（MDE）
  const mde = (sc2) => MS.flatMap((m) => [4, 8, 16, 32].map((C) => ({
    questionsPerCell: m, cells: C, works: Math.ceil(C / 2), mde: round(tz(C - 1) * Math.sqrt(sc2 / C + sigmaE2 / (C * m))),
  })));
  // 質問を無限に増やしても残る下限（cluster の分散だけで決まる）。δ がこれ以下なら cell を増やすしかない。
  const floorMde = (C, sc2) => round(tz(C - 1) * Math.sqrt(sc2 / C));

  // (c) 作品を cluster とする入れ子。Var = σw²/W + σp²/(W·P) + σe²/(W·P·m)、P = 2 地点/作品。
  const P = 2;
  const requiredWorksNested = DELTAS.flatMap((delta) => MS.map((m) => {
    for (let W = 3; W <= 400; W++) {
      if (tz(W - 1) * Math.sqrt(sigmaW2 / W + sigmaP2 / (W * P) + sigmaE2 / (W * P * m)) <= delta) return { delta, questionsPerCell: m, positionsPerWork: P, works: W, totalQuestions: W * P * m };
    }
    return { delta, questionsPerCell: m, positionsPerWork: P, works: null, totalQuestions: null };
  }));

  return {
    schema: "ir-chat-pilot-sizing/1",
    evidenceScope: "not-cp4-evidence",
    label: "【推測】pilot の観測値を入力にした計算。正式な試験の設計が pilot と同じであることを仮定する。区間は cell 4 件・作品 2 件からの見積りで極めて広い。",
    method: {
      outcome: "Sonnet 5.5 の B−A（質問ごとの項目の再現率の差）、答えのある 67 問、judge v3 の reproduced",
      test: `両側 α=${ALPHA}、検出力 ${POWER}。t 分位点（自由度 = cluster 数 − 1）。cluster を無視する行だけ正規分布`,
      models: {
        noCluster: "n = ((z_{α/2}+z_β)·SD_d/δ)²。cell・作品の相関を無視した下限。",
        mcnemar: "項目単位の対応のある二値。ψ=不一致率、δ=A と B の再現率の差。n_items = ((z_{α/2}√ψ + z_β√(ψ−δ²))/δ)²。項目間の相関と cluster を無視した下限。質問数への換算は 1 質問あたりの項目数で割る。",
        cellCluster: "cell（作品×地点）を cluster とする一元配置の変量効果。Var(平均 d) = σc²/C + σe²/(C·m)。作品数 = C/2（各作品 2 地点で、地点どうしが独立という楽観的な前提）。",
        workNested: "作品 > 地点 > 質問の入れ子。Var = σw²/W + σp²/(W·P) + σe²/(W·P·m)、P=2。σw² は作品 2 件の差からの 1 自由度の見積りで、信頼できない。",
      },
      assumptions: [
        "正式な試験の質問の型の配分・Gold の作り方・IR の選び方（質問つきの seed）・judge が pilot と同じ。",
        "質問ごとの差 d の分散は、B−A の大きさに依らず pilot の値のまま（δ を小さくしても SD_d を変えない）。",
        "σc²・σw²・σp² は 4 cell・2 作品からの積率法の推定で、負なら 0 に切る。真値の不確かさは大きく、この表は桁の目安にとどめる。",
        "pilot の B−A は評価側が質問つきの seed で IR を選んだ上限寄りの見積り（限界 16）。製品の経路の差はこれより小さい可能性が高く、その場合の必要数は増える。",
        "主指標の judge は Haiku 5.5 の judge v3 で、較正の範囲は限られる（calibration.json）。",
      ],
    },
    inputs: {
      questions: n, items: nItems, itemsPerQuestion: round(itemsPerQuestion, 3),
      meanDiff: round(dMean), sdDiff: round(Math.sqrt(dVar)),
      itemTable: { bothReproduced: n11, aOnly: n10, bOnly: n01, neither: n00 },
      discordanceRate: round(psi), itemRecallDiff: round(itemDiff),
      cellStats, cellTInterval,
      varianceComponents: {
        sigmaE2: round(sigmaE2, 5), sigmaC2: round(sigmaC2, 5), sigmaC2Unclipped: round(sigmaC2raw, 5), icc: round(icc, 4),
        cells: K, n0: round(n0, 3),
        nested: { sigmaW2: round(sigmaW2, 5), sigmaW2Unclipped: round(sigmaW2raw, 5), sigmaP2: round(sigmaP2, 5), workMeansOfCellMeans: Object.fromEntries(works.map((w, i) => [w, round(workMeans[i])])) },
      },
    },
    results: {
      noCluster, mcnemar,
      cellCluster: {
        requiredCellsAtPointEstimate: requiredCells(sigmaC2),
        requiredCellsIfCellVarianceDoubled: requiredCells(sigmaC2 * 2),
        requiredCellsIfCellVarianceZero: requiredCells(0),
        mdeAtPointEstimate: mde(sigmaC2),
        mdeFloorWithUnlimitedQuestions: [4, 8, 16, 32].map((C) => ({ cells: C, works: Math.ceil(C / 2), mde: floorMde(C, sigmaC2) })),
      },
      workNested: { requiredWorks: requiredWorksNested },
    },
  };
}
