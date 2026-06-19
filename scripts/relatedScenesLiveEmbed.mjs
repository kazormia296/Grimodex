/**
 * related-scenes ライブ eval の「埋め込み段」(standalone)。
 *
 * production と同一の int8 ONNX(src-tauri/resources/semantic/<dir>/model_int8.onnx)を
 * transformers.js(トークナイザ)+ onnxruntime-node(推論)で **この環境で実行**し、
 * corpus.json の全 scene 本文 + 各 case の dense クエリを実埋め込みして
 * embeddings.generated.json(key→ベクトル)へ書き出す。書き出し前に golden fixture と
 * 突き合わせて再現性(cos≥閾値)を検証する(ズレた埋め込み器で eval すると無意味なため)。
 *
 * 依存: @huggingface/transformers と onnxruntime-node。CI/通常 env には入れない方針なので、
 * 別の場所へインストールしたものを EMBED_NODE_MODULES で指す(既定 /tmp/onnxprobe/node_modules)。
 *   例: npm install --prefix /tmp/onnxprobe @huggingface/transformers
 *       node scripts/relatedScenesLiveEmbed.mjs
 *
 * Rust ort は本サンドボックスで glibc 不整合により動かないが、onnxruntime-node(JS ネイティブ)は
 * 動くことを確認済み。これがこの環境で実モデルを回す唯一の経路。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NM = process.env.EMBED_NODE_MODULES || "/tmp/onnxprobe/node_modules";
const require = createRequire(NM + "/");
const ort = require("onnxruntime-node");
const { AutoTokenizer, env } = await import(`${NM}/@huggingface/transformers/dist/transformers.node.mjs`);

// モデル/golden は大きく、checkout によっては未取得のことがある。env で上書き可。
const RES = process.env.EMBED_RES_DIR || path.join(ROOT, "src-tauri/resources/semantic");
const FIX = process.env.EMBED_FIX_DIR || path.join(ROOT, "src-tauri/tests/fixtures");
const CORPUS = path.join(ROOT, "src/features/related-scenes/liveEval/corpus.json");
const OUT = path.join(ROOT, "src/features/related-scenes/liveEval/embeddings.generated.json");

env.allowRemoteModels = false;
env.localModelPath = RES;

const SPECS = {
  ja: { dir: "ruri-v3-30m", pooling: "mean", fixture: "ruri_v3_30m_golden.json", minAvg: 0.99, minMin: 0.95 },
  en: { dir: "bge-small-en-v15", pooling: "cls", fixture: "bge_small_en_v15_golden.json", minAvg: 0.995, minMin: 0.99 },
};

function l2(v) { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); }
function cos(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

async function loadModel(spec) {
  const tok = await AutoTokenizer.from_pretrained(spec.dir, { local_files_only: true });
  const session = await ort.InferenceSession.create(path.join(RES, spec.dir, "model_int8.onnx"));
  return { tok, session, pooling: spec.pooling };
}

async function embed(model, text) {
  const enc = await model.tok(text);
  const ids = enc.input_ids, mask = enc.attention_mask;
  const seq = ids.dims[1];
  const feeds = {
    input_ids: new ort.Tensor("int64", ids.data, ids.dims),
    attention_mask: new ort.Tensor("int64", mask.data, mask.dims),
  };
  if (model.session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(seq).fill(0n), [1, seq]);
  }
  const res = await model.session.run(feeds);
  const out = res.last_hidden_state;
  const H = out.dims[2], data = out.data;
  const m = Array.from(mask.data, Number);
  const v = new Array(H).fill(0);
  if (model.pooling === "cls") {
    for (let h = 0; h < H; h++) v[h] = data[h];
  } else {
    let den = 0;
    for (let t = 0; t < seq; t++) { if (!m[t]) continue; den++; for (let h = 0; h < H; h++) v[h] += data[t * H + h]; }
    for (let h = 0; h < H; h++) v[h] /= Math.max(den, 1);
  }
  return l2(v);
}

async function validate(model, spec) {
  const gold = JSON.parse(fs.readFileSync(path.join(FIX, spec.fixture), "utf8"));
  let min = 1, sum = 0, n = 0;
  for (const s of gold.samples) {
    const v = await embed(model, s.prefixed);
    const c = cos(v, s.embedding);
    min = Math.min(min, c); sum += c; n++;
  }
  const avg = sum / n;
  const ok = avg >= spec.minAvg && min >= spec.minMin;
  console.log(`  golden[${spec.dir}] cos avg=${avg.toFixed(5)} min=${min.toFixed(5)} → ${ok ? "OK" : "FAIL"}`);
  if (!ok) throw new Error(`golden validation failed for ${spec.dir} (avg=${avg.toFixed(5)} min=${min.toFixed(5)})`);
}

const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
const vectors = {};
const meta = { generatedFor: "related-scenes live eval", models: {} };

for (const lang of ["ja", "en"]) {
  const spec = SPECS[lang];
  console.log(`[${lang}] loading ${spec.dir} …`);
  const model = await loadModel(spec);
  console.log(`[${lang}] validating against golden …`);
  await validate(model, spec);
  const c = corpus[lang];
  for (const s of c.scenes) vectors[`${lang}:s:${s.id}`] = await embed(model, s.body);
  for (const cs of c.cases) vectors[`${lang}:q:${cs.id}`] = await embed(model, cs.denseQueryText);
  meta.models[lang] = { dir: spec.dir, pooling: spec.pooling, scenes: c.scenes.length, cases: c.cases.length };
  console.log(`[${lang}] embedded ${c.scenes.length} scenes + ${c.cases.length} queries`);
}

fs.writeFileSync(OUT, JSON.stringify({ meta, vectors }));
console.log(`wrote ${OUT} (${Object.keys(vectors).length} vectors)`);
