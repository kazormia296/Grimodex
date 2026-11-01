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

// ---- spike: 索引時強化の feasibility（手書きの候補。LLM の出力ではない。測定に数えない）----
const fx = JSON.parse(fs.readFileSync(`${R}/evals/nir1-graph/g04-scope-exact-unknown.v1.json`, "utf8"));
const q = fx.query;
const Q = { "本文のみ": q.body, "題+改行+本文": `${q.title}\n${q.body}` };
const irStmt = (id) => { const r = fx.qualifiedIr.find((x) => x.sceneId === id); return JSON.stringify({ summary: r.summary, actuality: r.actuality, attribution: r.attribution, narrativeFrame: r.narrativeFrame }); };
const landing = irStmt("g04-lio-landing");
const cands = [
  ["基準: lio-landing の IR 文（現状）", landing],
  ["基準: control の IR 文（採用された）", irStmt("g04-control")],
  ["想定質問 1", "Whom did the ferryman Bren carry across the river?"],
  ["想定質問 2", "Which scene shows Bren the ferryman carrying someone across?"],
  ["想定質問 3", "Who did Bren ferry across the river at dusk?"],
  ["関係文 1", "Bren the ferryman carried Lio across the river at dusk."],
  ["関係文 2", "Lio was carried across the river by the ferryman Bren."],
  ["IR 文 + 想定質問 1（索引文書の拡張）", landing + " " + "Whom did the ferryman Bren carry across the river?"],
];
const out = { note: "手書きの候補。LLM の出力ではない。feasibility の確認だけ。測定に数えない", rows: [] };
const qv = {}; for (const [k, t] of Object.entries(Q)) qv[k] = await embed(t);
console.log("IR floor(en)=0.66  Raw gate(en)=0.51\n");
for (const [name, text] of cands) {
  const v = await embed(text);
  const row = { name, text: text.slice(0, 120), cos: Object.fromEntries(Object.entries(qv).map(([k, qq]) => [k, cos(qq, v)])) };
  out.rows.push(row);
  console.log(`${name.padEnd(34)} 本文のみ=${row.cos["本文のみ"].toFixed(4)}  題+本文=${row.cos["題+改行+本文"].toFixed(4)}`);
}
// pin を解決した query（Fable の指摘：知識の解決。「選んだ渡し守」を pin の人物名に置換）
const qPinned = "Which earlier scene shows whom Bren, my chosen ferryman, carried across?";
const pv = await embed(qPinned);
console.log("\n-- pin を解決した query（'my chosen ferryman' に人物名 Bren を足した版）と、現状の IR 文との cosine --");
for (const [name, text] of cands.slice(0, 2)) { const c = cos(pv, await embed(text)); out.rows.push({ name: `pin 解決 query × ${name}`, cos: { pinned: c } }); console.log(`${name.padEnd(34)} ${c.toFixed(4)}`); }
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
