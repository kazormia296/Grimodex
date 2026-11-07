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
// 1. golden による再現性の検証
const gold = JSON.parse(fs.readFileSync(`${R}/src-tauri/tests/fixtures/bge_small_en_v15_golden.json`, "utf8"));
let gmin = 1, gsum = 0;
for (const s of gold.samples) { const c = cos(await embed(s.prefixed), s.embedding); gmin = Math.min(gmin, c); gsum += c; }
console.log(`golden: n=${gold.samples.length} avg=${(gsum / gold.samples.length).toFixed(5)} min=${gmin.toFixed(5)} query_prefix=${JSON.stringify(gold.query_prefix)} document_prefix=${JSON.stringify(gold.document_prefix)}`);
// 2. fixture
const fx = JSON.parse(fs.readFileSync(`${R}/evals/nir1-graph/g04-scope-exact-unknown.v1.json`, "utf8"));
const q = fx.query;
const queries = { "本文のみ": q.body, "題+改行+本文": `${q.title}\n${q.body}` };
const scenes = fx.scenes.map((s) => ({ id: s.id, role: s.role, gold: s.gold, ro: s.readingOrder, body: s.body }));
const irs = fx.qualifiedIr.map((r) => ({ id: r.sceneId, text: JSON.stringify({ summary: r.summary, actuality: r.actuality, attribution: r.attribution, narrativeFrame: r.narrativeFrame }) }));
const qv = {}; for (const [k, t] of Object.entries(queries)) qv[k] = await embed(t);
const sv = {}; for (const s of scenes) sv[s.id] = await embed(s.body);
const iv = {}; for (const r of irs) iv[r.id] = await embed(r.text);
// 3. DB に保存された IR ベクトル（cold workspace）との照合
const dbp = `${R}/.artifacts/cp4/s5r4-g-04-base/setup/G-04/base/cold-workspace/grimodex.db`;
const py = `import sqlite3,struct,json
c=sqlite3.connect('file:${dbp}?mode=ro&immutable=1',uri=True)
print(json.dumps([[r[0],list(struct.unpack('<384f',r[1]))] for r in c.execute('select revision_id,embedding from narrative_nir1_chronicle_vectors')]))`;
const dbv = JSON.parse(execFileSync("python3", ["-I", "-c", py], { maxBuffer: 1 << 26 }).toString());
const out = { golden: { avg: gsum / gold.samples.length, min: gmin }, queries: {}, dbIrMatch: [] };
for (const [qk, v] of Object.entries(qv)) {
  console.log(`\n== 質問: ${qk} ==`);
  const rows = scenes.map((s) => ({ id: s.id, role: s.role, gold: s.gold, ro: s.ro, cos: cos(v, sv[s.id]) })).sort((a, b) => b.cos - a.cos);
  console.log("Scene 本文との cosine（Raw の gate 0.51、救済 0.46〜）:"); for (const r of rows) console.log(`  ${r.cos.toFixed(4)}  ${r.id.padEnd(16)} role=${String(r.role).padEnd(8)} gold=${r.gold} readingOrder=${r.ro}`);
  const med = [...rows.map((r) => r.cos)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`  （参考）中央値=${med.toFixed(4)}  相対救済の下限 0.46、中央値+0.05=${(med + 0.05).toFixed(4)}`);
  console.log("IR 文との cosine（IR floor 0.66）:"); for (const r of irs) console.log(`  ${cos(v, iv[r.id]).toFixed(4)}  ${r.id}  ${r.text.slice(0, 90)}…`);
  out.queries[qk] = { scenes: rows, ir: irs.map((r) => ({ id: r.id, cos: cos(v, iv[r.id]) })), median: med };
}
console.log("\n== 保存済みの IR ベクトル（DB）と、私の埋め込みの一致 ==");
for (const [rev, vec] of dbv) { const n = l2(vec); for (const r of irs) { const c = cos(n, iv[r.id]); if (c > 0.9) console.log(`  revision ${rev.slice(0, 8)} ↔ ${r.id}: cos=${c.toFixed(5)}`); out.dbIrMatch.push({ rev, ir: r.id, cos: c }); } 
  for (const [qk, v] of Object.entries(qv)) console.log(`  revision ${rev.slice(0, 8)} と質問(${qk})の cosine=${cos(n, v).toFixed(4)}`); }
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
