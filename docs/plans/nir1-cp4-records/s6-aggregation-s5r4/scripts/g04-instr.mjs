// G-04/base の診断（測定に数えない）。製品と同じ int8 ONNX（bge-small-en-v1.5、CLS、L2 正規化、英語は prefix なし）で、
// 質問と各 Scene 本文・IR 文の cosine を測る。read-only。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const NM = "/tmp/onnxprobe/node_modules";
const R = "/home/grimodex/worktrees/Grimodex/claude-cp4-s5cand";
const require = createRequire(NM + "/");
const ort = require("onnxruntime-node");
const { AutoTokenizer, env } = await import(`${NM}/@huggingface/transformers/dist/transformers.node.mjs`);
env.allowRemoteModels = false;
env.localModelPath = `${R}/src-tauri/resources/semantic`;
const MODEL = "/home/grimodex/.cache/gdx-nir1/grimodex-product-6x99bC/user-data/models/bge-small-en-v15/model_int8.onnx";
const tok = await AutoTokenizer.from_pretrained("bge-small-en-v15", { local_files_only: true });
const session = await ort.InferenceSession.create(MODEL);
const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
async function embed(text) {
  const enc = await tok(text); const ids = enc.input_ids, mask = enc.attention_mask; const seq = ids.dims[1];
  const feeds = { input_ids: new ort.Tensor("int64", ids.data, ids.dims), attention_mask: new ort.Tensor("int64", mask.data, mask.dims) };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(seq).fill(0n), [1, seq]);
  const out = (await session.run(feeds)).last_hidden_state; const H = out.dims[2];
  return l2(Array.from(out.data.slice(0, H)));
}

// ---- 英語 query に bge の instruction prefix を付けた場合の cosine（read-only。測定に数えない。製品は prefix なし）----
const fx = JSON.parse(fs.readFileSync(`${R}/evals/nir1-graph/g04-scope-exact-unknown.v1.json`, "utf8"));
const INSTR = "Represent this sentence for searching relevant passages: ";
const qBody = fx.query.body;
const qs = { "prefix なし（現状）": qBody, "instruction あり": INSTR + qBody };
const docs = fx.scenes.map((s) => ({ id: s.id, kind: "scene", gold: s.gold, text: s.body }));
for (const r of fx.qualifiedIr) docs.push({ id: "IR:" + r.sceneId, kind: "ir", text: JSON.stringify({ summary: r.summary, actuality: r.actuality, attribution: r.attribution, narrativeFrame: r.narrativeFrame }) });
const dv = {}; for (const d of docs) dv[d.id] = await embed(d.text);
const qv = {}; for (const [k, t] of Object.entries(qs)) qv[k] = await embed(t);
console.log("gate(Raw)=0.51  floor(IR)=0.66\n");
console.log("文書".padEnd(22), "prefix なし  instruction あり  差");
const out = [];
for (const d of docs) { const a = cos(qv["prefix なし（現状）"], dv[d.id]), b = cos(qv["instruction あり"], dv[d.id]); out.push({ id: d.id, gold: d.gold ?? null, none: a, instr: b }); console.log(d.id.padEnd(22), a.toFixed(4).padStart(9), b.toFixed(4).padStart(12), (b - a >= 0 ? "+" : "") + (b - a).toFixed(4)); }
fs.writeFileSync(process.argv[2], JSON.stringify({ note: "read-only。製品は prefix なし。測定に数えない", instruction: INSTR, rows: out }, null, 1));
