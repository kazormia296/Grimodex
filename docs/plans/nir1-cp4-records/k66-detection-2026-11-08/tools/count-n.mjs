// 全体の TAP（run.mjs の baseline-all）から、K6/6-P1〜P5、K6/6-N1〜N13 の合成の記録の試験を、
// 下位条件の記号（N1a、N2c、N7e …）ごとに数える。
// 使い方: node count-n.mjs <baseline-all.tap> <worktree> [--out <counts.json>]
// 数え方: 試験の題の「K6/6-」で始まる記号の部分（「:」「）」の手前まで）から、N<番号><英字> の記号を取り出す。
// 「N2c〜N2g」「N5a〜N5d」「N7a〜N7e」は範囲を展開し、「N10a・N10b」は列挙どおり。英字の無い「N4」「N8」「N9」は番号だけの行にする。
// 番号の行（N1 など）は、その番号の下位条件の記号のどれかを持つ試験の数。file は題の test( の行を持つ file。
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
  tests.push({
    depth: m[1].length / 4,
    status: m[2],
    title: m[4].replace(/\\#/gu, "#"),
    directive: m[5] ?? null,
  });
}
const fileOf = (title) =>
  [...sources]
    .filter(
      ([, text]) =>
        text.includes(`test("${title}"`) ||
        text.includes(`test(\n  "${title}"`),
    )
    .map(([f]) => f);
const head = (title) =>
  [...title.matchAll(/K6\/6-[^:）]*/gu)].map((m) => m[0]).join(" | ");
/** 題の記号の部分から、K6/6-N の記号（N2c 形）と P の記号（P1 形）を取り出す。範囲は展開する。 */
function tokensOf(title) {
  const text = head(title);
  const tokens = new Set();
  for (const m of text.matchAll(/N(\d+)([a-z])〜N\1([a-z])/gu))
    for (
      let c = m[2].charCodeAt(0);
      c <= m[3].charCodeAt(0);
      c += 1
    )
      tokens.add(`K6/6-N${m[1]}${String.fromCharCode(c)}`);
  for (const m of text.matchAll(/N(\d+)([a-z])?(?!\d)/gu))
    tokens.add(`K6/6-N${m[1]}${m[2] ?? ""}`);
  for (const m of text.matchAll(/P(\d+)/gu)) tokens.add(`K6/6-P${m[1]}`);
  return tokens;
}
const rows = new Map();
for (const t of tests) {
  if (t.depth !== 0) continue;
  for (const token of tokensOf(t.title)) {
    const row = rows.get(token) ?? { id: token, tests: [] };
    row.tests.push(t);
    rows.set(token, row);
  }
}
const letterless = (id) => id.replace(/[a-z]$/u, "");
const ids = [...rows.keys()];
// 番号の行を足す（N1a と N1b を持つ試験の和集合）。
for (const id of ids.filter((x) => /N\d+[a-z]$/u.test(x))) {
  const base = letterless(id);
  const row = rows.get(base) ?? { id: base, tests: [] };
  for (const t of rows.get(id).tests) if (!row.tests.includes(t)) row.tests.push(t);
  rows.set(base, row);
}
const order = (id) => {
  const m = /^K6\/6-([NP])(\d+)([a-z]?)$/u.exec(id);
  return [m[1] === "P" ? 0 : 1, Number(m[2]), m[3]];
};
const sorted = [...rows.values()].sort((a, b) => {
  const x = order(a.id);
  const y = order(b.id);
  return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
});
const result = {
  tapSha256: createHash("sha256").update(tap).digest("hex"),
  summary: Object.fromEntries(
    ["tests", "pass", "fail", "cancelled", "skipped", "todo"].map((k) => [
      k,
      Number(new RegExp(`^# ${k} (\\d+)$`, "mu").exec(tap)?.[1] ?? NaN),
    ]),
  ),
  rows: sorted.map((row) => ({
    id: row.id,
    count: row.tests.length,
    files: [...new Set(row.tests.flatMap((t) => fileOf(t.title)))].sort(),
    allPass: row.tests.every((t) => t.status === "ok" && t.directive === null),
    titles: row.tests.map((t) => t.title),
  })),
};
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
for (const row of result.rows)
  console.log(
    `${row.id}\t${row.count}\t${row.files.join(", ")}\t${row.allPass ? "pass" : "NOT-PASS"}`,
  );
console.log(JSON.stringify(result.summary));
