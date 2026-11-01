// 変異 1 件を環境変数で受ける load hook。
// SPN_MUTATION: {"id","file","find","replace"}（file は nir1-graph-eval の下の名前）
// SPN_HITS: 当たった数を JSONL で追記する path
// SPN_MUTATION が無ければ load を記録するだけ（mode=probe）。
import { appendFileSync } from "node:fs";

const DIR = "/scripts/quality/nir1-graph-eval/";
const raw = process.env.SPN_MUTATION;
const mutation = raw ? JSON.parse(raw) : null;
const hits = process.env.SPN_HITS;
const probe = process.env.SPN_PROBE; // probe 時の対象 file 名

function record(entry) {
  if (hits) appendFileSync(hits, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
}

export async function load(url, context, nextLoad) {
  const target = mutation?.file ?? probe;
  if (!target || !url.startsWith("file:") || !url.endsWith(DIR + target))
    return nextLoad(url, context);
  const result = await nextLoad(url, context);
  const source = Buffer.from(result.source).toString("utf8");
  if (!mutation) {
    record({ mode: "probe", url });
    return result;
  }
  const count = source.split(mutation.find).length - 1;
  record({ mode: "mutation", id: mutation.id, url, count });
  if (count !== 1)
    throw new Error(`[spn-hook] ${mutation.id}: find matched ${count} times in ${url} (must be exactly 1)`);
  const at = source.indexOf(mutation.find);
  const mutated = source.slice(0, at) + mutation.replace + source.slice(at + mutation.find.length);
  return { format: result.format ?? "module", source: mutated, shortCircuit: true };
}
