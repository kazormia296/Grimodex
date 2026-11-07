// SP-N の合成の検出の変異を、候補の worktree で baseline → 23 変異の順に走らせる。
// 使い方: node run.mjs <候補の worktree> [--out <results.json>] [--tap-dir <dir>] [--no-full]
// 候補の file は書き換えない。変異は hook.mjs（--import register.mjs）が読込み時に 1 か所だけ置換する。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const worktree = path.resolve(args[0] ?? "");
if (!args[0] || !existsSync(path.join(worktree, ".git"))) { console.error("usage: node run.mjs <worktree> [--out f] [--tap-dir d] [--no-full]"); process.exit(2); }
const out = path.resolve(opt("--out", path.join(HERE, "results.json")));
const tapDir = path.resolve(opt("--tap-dir", path.join(HERE, "tap")));
const full = !args.includes("--no-full");
mkdirSync(tapDir, { recursive: true });
const REL = "scripts/quality/nir1-graph-eval";
const TARGET_TESTS = ["seed-pin-setup.test.mjs", "seed-pin.test.mjs", "receipt.test.mjs"];
const mutations = JSON.parse(readFileSync(path.join(HERE, "mutations.json"), "utf8"));
const now = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const git = (...a) => { const r = spawnSync("git", a, { cwd: worktree, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

function parseTap(tap) {
  const lines = tap.split("\n");
  const tests = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(not ok|ok) (\d+) - (.*?)(?: # (.*))?$/.exec(lines[i]);
    if (!m) continue;
    const t = { depth: m[1].length / 4, status: m[2], title: m[4].replace(/\\#/g, "#"), directive: m[5] ?? null, line: lines[i].replace(/ # .*$/, "").trim(), rawLine: lines[i].replace(/ # .*$/, "") };
    if (lines[i + 1]?.trim() === "---") {
      for (let j = i + 2; j < lines.length && lines[j].trim() !== "..."; j++) {
        const loc = /^\s*location: '(.*):(\d+):(\d+)'$/.exec(lines[j]);
        if (loc) { t.file = path.relative(worktree, loc[1]); t.fileLine = Number(loc[2]); }
        const ty = /^\s*type: '(.*)'$/.exec(lines[j]); if (ty) t.type = ty[1];
        if (/^\s*error: /.test(lines[j])) {
          const v = lines[j].replace(/^\s*error: /, "");
          t.error = (v === "|-" || v === "|" || v === ">-") ? (lines[j + 1] ?? "").trim() : v.replace(/^'|'$/g, "");
        }
      }
    }
    tests.push(t);
  }
  const sum = {};
  for (const k of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const m = new RegExp(`^# ${k} (\\d+)$`, "m").exec(tap); sum[k] = m ? Number(m[1]) : null;
  }
  const okLines = tests.map((t) => t.line);
  return { tests, summary: sum, okLinesSha256: sha(okLines.join("\n") + "\n"), okLinesRawSha256: sha(tests.map((t) => t.rawLine).join("\n") + "\n"), okLineCount: okLines.length };
}

function runTests(files, env, label, withHook) {
  const argv = [...(withHook ? ["--import", path.join(HERE, "register.mjs")] : []), "--test", "--test-reporter=tap", ...files];
  const started = now();
  const r = spawnSync(process.execPath, argv, { cwd: worktree, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const tap = r.stdout ?? "";
  const tapFile = path.join(tapDir, `${label}.tap`);
  writeFileSync(tapFile, tap);
  const parsed = parseTap(tap);
  return { label, command: `node ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`, started, finished: now(), exitCode: r.status, signal: r.signal, stderrTail: (r.stderr ?? "").slice(-2000), tapFile, tapSha256: sha(tap), ...parsed };
}
const readHits = (f) => existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const failedOf = (run) => run.tests.filter((t) => t.status === "not ok").map((t) => ({ title: t.title, file: t.file ?? null, line: t.fileLine ?? null, depth: t.depth, type: t.type ?? null, error: t.error ?? null }));

const result = { tool: "spn-synthetic-detection-mutation", startedAt: now(), node: process.version, worktree };
result.candidate = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
result.statusBefore = git("status", "--porcelain", "--untracked-files=all");
result.ignoredBefore = git("status", "--porcelain", "--ignored");
const tf = (f) => `${REL}/${f}`;

// baseline: 対象の 3 file（変異なし、hook なし）
result.baselineTarget = runTests(TARGET_TESTS.map(tf), {}, "baseline-target", false);
result.baselineTarget.failed = failedOf(result.baselineTarget);
// 陽性の対照（違反の無い記録が通る assert）を含む試験が baseline で ok であること
// TAP の ok の試験には location が無いので、題の先頭で引く（file:行は試験 file の test( の行）
const POSITIVE = [["seed-pin-setup.test.mjs", 229, "SP/1 の段: upsertScenePin を 1 回だけ"], ["seed-pin-setup.test.mjs", 260, "SP-N1〜N5、N8、N9 と SP-P2:"], ["seed-pin-setup.test.mjs", 493, "SP-N10: case の arm の間で"], ["seed-pin-setup.test.mjs", 623, "setup-driver の段: renderer の API の upsertScenePin"], ["seed-pin.test.mjs", 34, "R5: seed は製品の規則"], ["seed-pin.test.mjs", 151, "R5／SP-P3: 凍結の plan は 13 の variant"], ["seed-pin.test.mjs", 161, "R5／SP-N1〜N3、N9、N11、N13、N14:"], ["receipt.test.mjs", 997, "S1f（R5、K6/4-N16）:"]];
result.positiveControls = POSITIVE.map(([f, l, p]) => { const src = readFileSync(path.join(worktree, REL, f), "utf8").split("\n")[l - 1] ?? ""; const hit = result.baselineTarget.tests.filter((x) => x.title.startsWith(p)); return { file: f, line: l, lineHasTitle: src.includes(`test("${p}`), title: hit[0]?.title ?? null, matches: hit.length, status: hit.length === 1 ? hit[0].status : "missing-or-ambiguous" }; });
// baseline: 変異の表が参照する試験 file すべて（= 対象の 3 file）を、変異の試験と同じく 1 file ずつ
const testFiles = [...new Set(mutations.map((m) => m.testFile))];
result.baselinePerFile = testFiles.map((f) => { const r = runTests([tf(f)], {}, `baseline-${f}`, false); return { file: f, summary: r.summary, exitCode: r.exitCode, failed: failedOf(r), okLinesSha256: r.okLinesSha256 }; });
// probe: hook が test の子 process で効くこと（置換なし、load の記録だけ）
result.probe = [...new Set(mutations.map((m) => `${m.file}|${m.testFile}`))].map((k) => {
  const [file, testFile] = k.split("|");
  const hits = path.join(tapDir, `probe-${file}-${testFile}.jsonl`); rmSync(hits, { force: true });
  const r = runTests([tf(testFile)], { SPN_PROBE: file, SPN_HITS: hits }, `probe-${file}-${testFile}`, true);
  const h = readHits(hits);
  return { file, testFile, loads: h.length, pids: [...new Set(h.map((x) => x.pid))].length, summary: r.summary, ok: h.length >= 1 && r.summary.fail === 0 };
});
// baseline: 全体
if (full) {
  const all = readdirSync(path.join(worktree, REL)).filter((f) => f.endsWith(".test.mjs")).sort().map(tf);
  const r = runTests(all, {}, "baseline-all", false);
  result.baselineAll = { command: r.command, started: r.started, finished: r.finished, exitCode: r.exitCode, summary: r.summary, tapSha256: r.tapSha256, okLinesSha256: r.okLinesSha256, okLineCount: r.okLineCount, failed: failedOf(r), tapFile: r.tapFile, files: all.length };
}
// 変異
result.mutationsStartedAt = now();
result.mutations = mutations.map((m) => {
  const hits = path.join(tapDir, `mut-${m.id}.jsonl`); rmSync(hits, { force: true });
  const r = runTests([tf(m.testFile)], { SPN_MUTATION: JSON.stringify({ id: m.id, file: m.file, find: m.find, replace: m.replace }), SPN_HITS: hits }, `mut-${m.id}`, true);
  const h = readHits(hits).filter((x) => x.mode === "mutation");
  const counts = h.map((x) => x.count);
  const failed = failedOf(r);
  const leaf = failed.filter((f) => f.type === "test" && f.file === tf(m.testFile));
  const missing = m.expected.filter((e) => !leaf.some((f) => f.line === e.line && f.title.startsWith(e.titlePrefix)));
  const extra = leaf.filter((f) => !m.expected.some((e) => f.line === e.line && f.title.startsWith(e.titlePrefix)));
  const hitOk = counts.length >= 1 && counts.every((c) => c === 1);
  return { id: m.id, spn: m.spn, file: m.file, find: m.find, replace: m.replace, testFile: m.testFile, command: r.command, started: r.started, exitCode: r.exitCode,
    loads: counts.length, counts, hitOk, summary: r.summary, failed, expected: m.expected.map((e) => `${e.file}:${e.line}`),
    missingExpected: missing.map((e) => `${e.file}:${e.line}`), extraFailed: extra.map((f) => `${f.file}:${f.line} ${f.title}`),
    asExpected: hitOk && missing.length === 0, exact: hitOk && missing.length === 0 && extra.length === 0, tapFile: r.tapFile };
});
result.mutationsFinishedAt = now();
result.statusAfter = git("status", "--porcelain", "--untracked-files=all");
result.ignoredAfter = git("status", "--porcelain", "--ignored");
result.headAfter = git("rev-parse", "HEAD");
result.verdict = {
  clean: result.statusBefore === "" && result.statusAfter === "" && result.headAfter === result.candidate.commit,
  ignoredUnchanged: result.ignoredBefore === result.ignoredAfter,
  baselineTargetPass: result.baselineTarget.summary.fail === 0 && result.baselineTarget.exitCode === 0,
  baselinePerFilePass: result.baselinePerFile.every((b) => b.summary.fail === 0 && b.exitCode === 0),
  baselineAllPass: full ? result.baselineAll.summary.fail === 0 && result.baselineAll.exitCode === 0 : null,
  positiveControlsOk: result.positiveControls.every((p) => p.status === "ok" && p.lineHasTitle),
  probeOk: result.probe.every((p) => p.ok),
  mutationCount: result.mutations.length,
  allHitOnce: result.mutations.every((m) => m.hitOk),
  allAsExpected: result.mutations.every((m) => m.asExpected),
  exactCount: result.mutations.filter((m) => m.exact).length,
};
result.finishedAt = now();
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
const b = result.baselineTarget.summary;
console.log(`candidate ${result.candidate.commit} tree ${result.candidate.tree} node ${result.node}`);
console.log(`baseline target: tests ${b.tests} pass ${b.pass} fail ${b.fail} skipped ${b.skipped} tap ${result.baselineTarget.tapSha256} ok-lines ${result.baselineTarget.okLinesSha256} (${result.baselineTarget.okLineCount})`);
if (full) { const a = result.baselineAll.summary; console.log(`baseline all: tests ${a.tests} pass ${a.pass} fail ${a.fail} cancelled ${a.cancelled} skipped ${a.skipped} todo ${a.todo} ok-lines ${result.baselineAll.okLinesSha256} (${result.baselineAll.okLineCount})`); }
for (const m of result.mutations) console.log(`${m.asExpected ? "OK " : "NG "}${m.exact ? "=" : "+"} ${m.id} counts=${JSON.stringify(m.counts)} failed=${m.failed.filter((f) => f.type === "test").map((f) => `${path.basename(f.file ?? "?")}:${f.line}`).join(",")}${m.missingExpected.length ? ` missing=${m.missingExpected}` : ""}${m.extraFailed.length ? ` extra=${m.extraFailed.length}` : ""}`);
console.log(JSON.stringify(result.verdict));
process.exitCode = result.verdict.clean && result.verdict.baselineTargetPass && result.verdict.probeOk && result.verdict.positiveControlsOk && result.verdict.allHitOnce && result.verdict.allAsExpected ? 0 : 1;
