// 基準の再現：封印した ancestor だけの証拠（keep test なし）で、記録済みの要約が再現できるかを確かめる。
import fs from "node:fs";
const R = "/home/grimodex/worktrees/Grimodex/claude-cp4-s5cand";
const { collectRatification5Evidence } = await import(`${R}/scripts/quality/nir1-graph-eval/admission.mjs`);
const { summarizeTrace } = await import(`${R}/scripts/quality/nir1-graph-eval/availability.mjs`);
const head = "86427ee53a73e669e34631c5774fbd56960ac050";
const ev = collectRatification5Evidence({ root: R, candidateHead: head });
console.log("evidence regime pieces", JSON.stringify({ hook: ev.rsJoinHook, d: ev.dPrime.ancestor, w: ev.wfWindow.ancestor }));
for (const kind of ["editing", "browsing"]) {
  const j = JSON.parse(fs.readFileSync(`${R}/.artifacts/cp4/trace-${kind}-s5r4-1/receipt.json`, "utf8"));
  const out = summarizeTrace({ trace: { kind, queries: j.queries }, fixedGraphMode: "restricted", candidate: ev, candidateHead: head });
  const rec = j.summary.k64;
  const pick = (s) => ({ status: s.status, regime: s.regime, Q: s.Q, U: s.U, lapse: s.lapse?.total, outcomes: s.outcomes, mainReason: s.mainReason, notApplied: s.k64NotApplied });
  console.log(kind, "recomputed", JSON.stringify(pick(out)));
  console.log(kind, "recorded  ", JSON.stringify(pick(rec)));
}
