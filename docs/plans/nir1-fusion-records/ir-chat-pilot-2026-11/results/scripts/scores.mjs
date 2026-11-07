// answers.jsonl と judge.v3.jsonl から、質問ごとの項目の再現（主指標の正本は judge v3 の reproduced）を作る。
// 回答や judge の本文・説明文は読み出さない（text・note は触らない）。
import path from "node:path";
import { readJsonl } from "./lib.mjs";

export function latestJudgeByAnswer(judgeRows) {
  const m = new Map();
  for (const e of judgeRows) {
    if (e.source !== "answer" || !e.ok) continue; // 失敗した試行は使わない。ok の最後の行を採る。
    m.set(e.answerId, e);
  }
  return m;
}

export function loadScores(dataDir, pass) {
  const dir = path.join(dataDir, `main-${pass}`);
  const answers = readJsonl(path.join(dir, "answers.jsonl"));
  const judge = latestJudgeByAnswer(readJsonl(path.join(dir, "judge.v3.jsonl")));
  const rows = [];
  for (const a of answers) {
    const j = judge.get(a.id);
    if (!j) { rows.push({ id: a.id, qid: a.qid, cellId: a.cellId, work: a.work, type: a.type, arm: a.arm, rep: a.rep, missing: true }); continue; }
    const items = j.reproduced || [];
    rows.push({
      id: a.id, qid: a.qid, cellId: a.cellId, work: a.work, type: a.type, arm: a.arm, rep: a.rep,
      items, itemCount: items.length, score: items.length ? items.filter(Boolean).length / items.length : null,
      abstained: !!j.abstained, hedged: !!j.hedged, contradiction: !!j.contradiction, unverified: !!j.unverified,
      textLength: a.textLength, stopReason: a.stopReason,
    });
  }
  return rows;
}

// 質問×arm の点数（rep の平均）。N 型は除く。
export function questionArmScores(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.type === "N" || r.missing) continue;
    const k = `${r.qid}|${r.arm}`;
    if (!m.has(k)) m.set(k, { qid: r.qid, cellId: r.cellId, work: r.work, type: r.type, arm: r.arm, scores: [], items: [] });
    const e = m.get(k); e.scores.push(r.score); e.items.push(r.items);
  }
  const out = new Map();
  for (const [k, e] of m) out.set(k, { ...e, score: e.scores.reduce((a, b) => a + b, 0) / e.scores.length });
  return out;
}
