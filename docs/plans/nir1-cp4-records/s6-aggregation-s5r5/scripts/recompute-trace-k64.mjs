// K6/4 の読みの再計算：keep test を候補の worktree で走らせた封印済みの証拠で、観測済みの trace の query を要約し直す。
// 測定のやり直しではなく、観測済みの記録の再分析（記録済みの K6/2 の要約は変えない）。
import fs from "node:fs";
const R = "/home/grimodex/worktrees/Grimodex/claude-g04-cand";
const { collectRatification5EvidenceWithKeepTest } = await import(`${R}/scripts/quality/nir1-graph-eval/admission.mjs`);
const { summarizeTrace } = await import(`${R}/scripts/quality/nir1-graph-eval/availability.mjs`);
const head = "22b74a25ff8dadfa45247e5bc866afe3afd48fb7";
const ev = await collectRatification5EvidenceWithKeepTest({ root: R, candidateHead: head, keepTestWorktree: R, keepTestLogDir: process.argv[2] });
console.log("hook evidence", JSON.stringify(ev.rsJoinHook).slice(0, 400));
const out = {};
for (const kind of ["editing", "browsing"]) {
  const j = JSON.parse(fs.readFileSync(`${R}/.artifacts/cp4/trace-${kind}-s5r5-1/receipt.json`, "utf8"));
  out[kind] = summarizeTrace({ trace: { kind, queries: j.queries }, fixedGraphMode: "restricted", candidate: ev, candidateHead: head });
  console.log(kind, JSON.stringify(out[kind]).slice(0, 3500));
}
fs.writeFileSync(process.argv[3], JSON.stringify({ evidence: ev, summaries: out }, null, 1));
