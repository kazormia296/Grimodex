// NIR-1 CP-4 G-04 v2 の凍結前 admission probe（設計案 §4。model-only の予測で、測定に数えない）。
// 製品と同じ int8 ONNX（bge-small-en-v1.5）と tokenizer、CLS プーリング、L2 正規化、英語は prefix なし。
// read-only：fixture・製品・docs は変えない。出力は --out に書く JSON と stdout だけ。
//
// 使い方:
//   node probe.mjs <fixture.json> --out <out.json>
//   node probe.mjs <fixture.json> --candidates <cand.json> --out <out.json>
// cand.json の形: [{ "order": 1, "target": { "kind": "irSummary" | "sceneBody", "sceneId": "g04-…" }, "text": "…" }, …]
//   kind=irSummary は qualifiedIr[sceneId].summary を、kind=sceneBody は scenes[id].body を置き換える。
//   候補ごとに 1 field だけを置き換えた仮の fixture で全条件を計算し、全候補の全結果を出す（最初の合格で止めない）。
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ---- 固定の経路 ----
const NM = "/tmp/onnxprobe/node_modules";
const R = "/home/grimodex/worktrees/Grimodex/claude-cp4-s5cand";
const TOKENIZER_DIR = `${R}/src-tauri/resources/semantic`;
const TOKENIZER_JSON = `${TOKENIZER_DIR}/bge-small-en-v15/tokenizer.json`;
const MODEL = "/home/grimodex/.cache/gdx-nir1/grimodex-product-6x99bC/user-data/models/bge-small-en-v15/model_int8.onnx";
const GOLDEN = `${R}/src-tauri/tests/fixtures/bge_small_en_v15_golden.json`;
const EXPECT_MODEL_SHA256 = "4f1831710bec8904589cf50c58ad4d9ed3e66386f4973173c13f1e9d3ae8e44b";
const EXPECT_TOKENIZER_SHA256 = "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66";

// ---- 製品の規則（緩めない）と fixture の設計の余裕 δ ----
const FLOOR_EN = 0.66; // policies/narrative/nir1-related-scenes-ranking.json irCosineFloors.en
const GATE_EN = 0.51; // semanticRecall.ts SEMANTIC_RECALL_MIN_SCORE_EN（= TOP1_GATE_EN、fetchNir1RelatedScenes の minScore）
const RESCUE_MARGIN = 0.05; // SEMANTIC_RECALL_RESCUE_MARGIN → 救済の下限 0.46
const RELATIVE_GAP = 0.05; // RELATED_SCENES_RELATIVE_GAP
const QUERY_TAIL_UTF16 = 500; // SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS（RAW_QUERY_TAIL_UTF16_UNITS）
const DELTA = 0.03; // user-confirmation-2026-11-01-g04-v2（設計案 §4.3）
const GOLDEN_MIN = 0.995; // 設計案 §4.1（依頼の 0.99 より厳しい側）
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const T_IR = r4(FLOOR_EN + DELTA); // 0.69
const T_CONTROL = r4(GATE_EN + DELTA); // 0.54
const T_OTHER = r4(GATE_EN - RESCUE_MARGIN - DELTA); // 0.43
const RESCUE_FLOOR = r4(GATE_EN - RESCUE_MARGIN); // 0.46

// ---- 引数 ----
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const fixturePath = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const outPath = opt("--out");
const candPath = opt("--candidates");
if (!fixturePath || !outPath) { console.error("usage: node probe.mjs <fixture.json> [--candidates cand.json] --out out.json"); process.exit(2); }

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const shaFile = (p) => sha256(fs.readFileSync(p));
const scriptPath = fileURLToPath(import.meta.url);
const out = {
  probe: "nir1-g04-v2-admission-probe",
  note: "model-only の予測。測定に数えない。sparse（FTS5）と RRF の順位は再現しない。語彙の検査は pnpm eval:fixtures に任せる。",
  startedAt: new Date().toISOString(),
  script: { path: scriptPath, sha256: shaFile(scriptPath) },
  tool: {
    transformers: JSON.parse(fs.readFileSync(`${NM}/@huggingface/transformers/package.json`, "utf8")).version,
    onnxruntimeNode: JSON.parse(fs.readFileSync(`${NM}/onnxruntime-node/package.json`, "utf8")).version,
    node: process.version,
    nodeModules: NM,
  },
  model: { path: MODEL, sha256: shaFile(MODEL), tokenizerPath: TOKENIZER_JSON, tokenizerSha256: shaFile(TOKENIZER_JSON) },
  rules: { floorEn: FLOOR_EN, gateEn: GATE_EN, rescueFloor: RESCUE_FLOOR, relativeGap: RELATIVE_GAP, delta: DELTA,
    pass: { irOnlyIrMin: T_IR, controlRawMin: T_CONTROL, otherRawMax: T_OTHER },
    median: "selectRelatedScenes.ts:77-81（偶数長は中央 2 値の平均）。合否は中央値に依存させない（参考列だけ）",
    controlIr: "条件にしない（README:165）。値だけ出す" },
  fixture: { path: fixturePath, sha256: shaFile(fixturePath) },
};
out.model.sha256MatchesExpected = out.model.sha256 === EXPECT_MODEL_SHA256;
out.model.tokenizerSha256MatchesExpected = out.model.tokenizerSha256 === EXPECT_TOKENIZER_SHA256;
if (!out.model.sha256MatchesExpected || !out.model.tokenizerSha256MatchesExpected) {
  console.error("model/tokenizer sha256 mismatch", out.model); process.exit(1);
}

// 候補の文字列と sha256 は測定（埋め込み）の前に先に出す。
let candidates = null;
if (candPath) {
  candidates = JSON.parse(fs.readFileSync(candPath, "utf8"));
  out.candidatesFile = { path: candPath, sha256: shaFile(candPath) };
  out.candidatesDeclared = candidates.map((c) => ({ order: c.order, target: c.target, text: c.text, textSha256: sha256(Buffer.from(c.text, "utf8")) }));
  console.log("== 候補（測定の前に記録） ==");
  for (const c of out.candidatesDeclared) console.log(`  #${c.order} ${c.target.kind}:${c.target.sceneId} sha256=${c.textSha256} ${JSON.stringify(c.text)}`);
  fs.writeFileSync(`${outPath}.declared.json`, JSON.stringify({ script: out.script, candidatesFile: out.candidatesFile, candidatesDeclared: out.candidatesDeclared, at: new Date().toISOString() }, null, 1));
}

// ---- model ----
const require = createRequire(NM + "/");
const ort = require("onnxruntime-node");
const { AutoTokenizer, env } = await import(`${NM}/@huggingface/transformers/dist/transformers.node.mjs`);
env.allowRemoteModels = false;
env.localModelPath = TOKENIZER_DIR;
const tok = await AutoTokenizer.from_pretrained("bge-small-en-v15", { local_files_only: true });
const session = await ort.InferenceSession.create(MODEL);
const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
const cache = new Map();
async function embed(text) {
  if (cache.has(text)) return cache.get(text);
  const enc = await tok(text); const ids = enc.input_ids, mask = enc.attention_mask; const seq = ids.dims[1];
  const feeds = { input_ids: new ort.Tensor("int64", ids.data, ids.dims), attention_mask: new ort.Tensor("int64", mask.data, mask.dims) };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(seq).fill(0n), [1, seq]);
  const o = (await session.run(feeds)).last_hidden_state; const H = o.dims[2];
  const v = l2(Array.from(o.data.slice(0, H))); // CLS プーリング
  cache.set(text, v); return v;
}

// ---- golden ----
const gold = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
let gmin = 1, gsum = 0;
for (const s of gold.samples) { const c = cos(await embed(s.prefixed), s.embedding); gmin = Math.min(gmin, c); gsum += c; }
out.golden = { path: GOLDEN, sha256: shaFile(GOLDEN), n: gold.samples.length, avg: gsum / gold.samples.length, min: gmin, requiredMin: GOLDEN_MIN, ok: gmin >= GOLDEN_MIN,
  queryPrefix: gold.query_prefix ?? null, documentPrefix: gold.document_prefix ?? null };
if (!out.golden.ok) { fs.writeFileSync(outPath, JSON.stringify(out, null, 1)); console.error(`golden min ${gmin} < ${GOLDEN_MIN}: probe 無効`); process.exit(1); }

// ---- 製品の定義 ----
function median(xs) { // selectRelatedScenes.ts:77-81
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b); const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function rawQuery(body) { // buildSemanticRecallQueryParts（userMessage 空、本文の末尾 500 UTF-16）
  const b = String(body ?? "").trim();
  return b.length > QUERY_TAIL_UTF16 ? b.slice(-QUERY_TAIL_UTF16) : b;
}
const irStatement = (r) => JSON.stringify({ summary: r.summary, actuality: r.actuality, attribution: r.attribution, narrativeFrame: r.narrativeFrame });

const ALLOWED = (fx) => new Set([
  ...fx.qualifiedIr.filter((r) => fx.scenes.find((s) => s.id === r.sceneId)?.role === "ir-only").map((r) => `irSummary:${r.sceneId}`),
  ...fx.scenes.filter((s) => s.role === "review" && s.gold === 0).map((s) => `sceneBody:${s.id}`),
]);

async function evaluate(fx) {
  const query = rawQuery(fx.query.body);
  const qv = await embed(query);
  const pool = [];
  for (const s of fx.scenes) {
    if (!(s.readingOrder < fx.query.readingOrder)) continue;
    pool.push({ id: s.id, role: s.role ?? null, gold: s.gold ?? null, body: s.body, cos: cos(qv, await embed(s.body)) });
  }
  const med = median(pool.map((p) => p.cos));
  const maxCos = Math.max(...pool.map((p) => p.cos));
  const hasWinner = maxCos >= GATE_EN;
  for (const p of pool) {
    p.gate = p.cos >= GATE_EN;
    p.atOrAboveRescueFloor = p.cos >= RESCUE_FLOOR; // sparse 救済の下限（sparse は再現しない）
    p.relativeRescue = hasWinner && p.cos >= RESCUE_FLOOR && p.cos - med >= RELATIVE_GAP;
    p.predictedRawDense = p.gate || p.relativeRescue;
  }
  const ir = [];
  for (const r of fx.qualifiedIr ?? []) {
    const text = irStatement(r);
    const role = fx.scenes.find((s) => s.id === r.sceneId)?.role ?? null;
    const c = cos(qv, await embed(text));
    ir.push({ sceneId: r.sceneId, role, statement: text, statementSha256: sha256(Buffer.from(text, "utf8")), cos: c, atOrAboveFloor: c >= FLOOR_EN });
  }
  // 合格条件（中央値に依存しない）
  const items = [];
  for (const r of ir) if (r.role === "ir-only") items.push({ item: `irSummary:${r.sceneId}`, condition: `IR cos >= ${T_IR}`, value: r.cos, pass: r.cos >= T_IR, margin: r.cos - T_IR });
  for (const p of pool) {
    if (p.role === "control") items.push({ item: `controlRaw:${p.id}`, condition: `Raw cos >= ${T_CONTROL}`, value: p.cos, pass: p.cos >= T_CONTROL, margin: p.cos - T_CONTROL });
    else items.push({ item: `sceneBody:${p.id}`, role: p.role, gold: p.gold, condition: `Raw cos <= ${T_OTHER}`, value: p.cos, pass: p.cos <= T_OTHER, margin: T_OTHER - p.cos });
  }
  const irOnlyCount = ir.filter((r) => r.role === "ir-only").length;
  const controlCount = pool.filter((p) => p.role === "control").length;
  const structural = { irOnlyIrRows: irOnlyCount, controlScenes: controlCount, ok: irOnlyCount === 0 && controlCount === 1 };
  const allowed = ALLOWED(fx);
  const failing = items.filter((i) => !i.pass).map((i) => i.item);
  const failingOutsideAllowed = failing.filter((i) => !allowed.has(i));
  return {
    query, querySha256: sha256(Buffer.from(query, "utf8")),
    poolMedian: med, poolMax: maxCos, hasWinner, medianPlusGap: med + RELATIVE_GAP,
    pool: pool.map(({ body, ...p }) => ({ ...p, bodySha256: sha256(Buffer.from(body, "utf8")), body })),
    ir, items, structural,
    allPass: structural.ok && failing.length === 0,
    failingItems: failing,
    failingOutsideAllowed,
    stopRequired: !structural.ok || failingOutsideAllowed.length > 0,
    allowedItems: [...allowed],
  };
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
out.base = await evaluate(fixture);

if (candidates) {
  const allowed = ALLOWED(fixture);
  out.candidateResults = [];
  for (const c of candidates) {
    const key = `${c.target.kind}:${c.target.sceneId}`;
    const rec = { order: c.order, target: c.target, text: c.text, textSha256: sha256(Buffer.from(c.text, "utf8")), targetAllowed: allowed.has(key) };
    if (!rec.targetAllowed) { rec.error = "target は変えてよい入力の集合の外"; out.candidateResults.push(rec); continue; }
    const fx = structuredClone(fixture);
    if (c.target.kind === "irSummary") fx.qualifiedIr.find((r) => r.sceneId === c.target.sceneId).summary = c.text;
    else fx.scenes.find((s) => s.id === c.target.sceneId).body = c.text;
    const ev = await evaluate(fx);
    const targetItem = ev.items.find((i) => i.item === key);
    rec.targetItem = targetItem; // 対象項目の条件の合否
    rec.targetPass = !!targetItem?.pass;
    // 置換が他の項目に効くのは query の pool 中央値の参考列だけ（各 cosine は独立）。全体の表も残す。
    rec.evaluation = ev;
    out.candidateResults.push(rec);
  }
}
out.finishedAt = new Date().toISOString();
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

// ---- stdout ----
const show = (ev, indent = "") => {
  console.log(`${indent}median=${ev.poolMedian.toFixed(4)} median+gap=${ev.medianPlusGap.toFixed(4)} max=${ev.poolMax.toFixed(4)} hasWinner=${ev.hasWinner}`);
  for (const p of ev.pool.slice().sort((a, b) => b.cos - a.cos)) console.log(`${indent}  Raw ${p.cos.toFixed(4)} ${p.id.padEnd(18)} role=${String(p.role).padEnd(8)} gold=${p.gold} gate=${p.gate} relRescue=${p.relativeRescue} >=0.46=${p.atOrAboveRescueFloor}`);
  for (const r of ev.ir) console.log(`${indent}  IR  ${r.cos.toFixed(4)} ${r.sceneId.padEnd(18)} role=${r.role} >=floor=${r.atOrAboveFloor}`);
  for (const i of ev.items) console.log(`${indent}  [${i.pass ? "PASS" : "FAIL"}] ${i.item.padEnd(28)} ${i.condition.padEnd(18)} value=${i.value.toFixed(4)} margin=${i.margin.toFixed(4)}`);
  console.log(`${indent}allPass=${ev.allPass} failing=${JSON.stringify(ev.failingItems)} outsideAllowed=${JSON.stringify(ev.failingOutsideAllowed)} stopRequired=${ev.stopRequired}`);
};
console.log(`script sha256=${out.script.sha256}`);
console.log(`tool=${JSON.stringify(out.tool)} model=${out.model.sha256} tokenizer=${out.model.tokenizerSha256}`);
console.log(`golden n=${out.golden.n} avg=${out.golden.avg.toFixed(5)} min=${out.golden.min.toFixed(5)} ok=${out.golden.ok}`);
console.log(`fixture sha256=${out.fixture.sha256}`);
console.log("== base =="); show(out.base);
for (const c of out.candidateResults ?? []) {
  console.log(`== 候補 #${c.order} ${c.target.kind}:${c.target.sceneId} sha256=${c.textSha256} targetPass=${c.targetPass ?? false} ${c.error ?? ""}`);
  if (c.evaluation) show(c.evaluation, "   ");
}
