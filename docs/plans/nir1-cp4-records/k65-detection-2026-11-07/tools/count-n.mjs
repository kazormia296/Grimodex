// 全体の TAP（run.mjs の baseline-all）から、K6/4-N1〜N40、K6/5-N1〜N4、K6/5-P1、C7 の合成の記録の試験を数える。
// 使い方: node count-n.mjs <baseline-all.tap> <worktree> [--out <counts.json>]
// 数え方: 試験の題の先頭（最初の「:」または「（」まで）に N<番号> を持つものを、その N の試験とする
// （contracts の k64-synthetic-detection-record.md の「題に現れる」と同じ）。file は題の test( の行を持つ file。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const [tapFile, worktree, ...rest] = process.argv.slice(2);
const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : null;
const tap = readFileSync(tapFile, "utf8");
const REL = "scripts/quality/nir1-graph-eval";
const sources = new Map(
  readdirSync(path.join(worktree, REL))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => [f, readFileSync(path.join(worktree, REL, f), "utf8")]),
);
const tests = [];
for (const line of tap.split("\n")) {
  const m = /^(\s*)(not ok|ok) (\d+) - (.*?)(?: # (.*))?$/u.exec(line);
  if (!m) continue;
  tests.push({ depth: m[1].length / 4, status: m[2], title: m[4].replace(/\\#/gu, "#"), directive: m[5] ?? null });
}
const fileOf = (title) => {
  const hit = [...sources].filter(([, text]) => text.includes(`test("${title}"`) || text.includes(`test(\n  "${title}"`));
  return hit.map(([f]) => f);
};
const head = (title) => /^[^:（]*/u.exec(title)?.[0] ?? "";
const rows = [];
const add = (id, pattern) => {
  const hits = tests.filter((t) => t.depth === 0 && pattern.test(head(t.title)));
  rows.push({
    id,
    count: hits.length,
    files: [...new Set(hits.flatMap((t) => fileOf(t.title)))].sort(),
    allPass: hits.length > 0 && hits.every((t) => t.status === "ok" && t.directive === null),
    titles: hits.map((t) => t.title),
  });
};
for (let k = 1; k <= 40; k += 1) add(`K6/4-N${k}`, new RegExp(`K6/4-.*\\bN${k}(?!\\d)`, "u"));
for (const k of [1, 2, 3, 4]) add(`K6/5-N${k}`, new RegExp(`K6/5-.*\\bN${k}(?!\\d)`, "u"));
add("K6/5-P1", /K6\/5-P1/u);
add("DR-CP4-C7", /DR-CP4-C7/u);
const summary = Object.fromEntries(
  ["tests", "pass", "fail", "cancelled", "skipped", "todo"].map((k) => [k, Number(new RegExp(`^# ${k} (\\d+)$`, "mu").exec(tap)?.[1] ?? NaN)]),
);
const result = { tapSha256: createHash("sha256").update(tap).digest("hex"), summary, rows };
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
for (const row of rows) console.log(`${row.id}\t${row.count}\t${row.files.join(", ")}\t${row.allPass ? "pass" : "NOT-PASS"}`);
console.log(JSON.stringify(summary));
