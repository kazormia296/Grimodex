// 独立レビュー（gate）: admission の再現。モジュールは PR の worktree から import し、
// git の root は一時 clone（合成の merge M を HEAD と refs/remotes/origin/master に持つ）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const WT = "/home/grimodex/worktrees/Grimodex/claude-g04-v2c";
const ROOT = process.argv[2];
if (!ROOT) throw new Error("clone root required");

const adm = await import(`${WT}/scripts/quality/nir1-graph-eval/admission.mjs`);
const contract = await import(`${WT}/scripts/quality/nir1-retrieval/contract.mjs`);
const op = await import(`${WT}/scripts/quality/nir1-graph/observation-prep.mjs`);

const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: ROOT, encoding: opts.buffer ? "buffer" : "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const rev = (r) => git(["rev-parse", "--verify", `${r}^{commit}`]).trim();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const blob = (c, p) => { try { return git(["show", `${c}:${p}`], { buffer: true }); } catch { return null; } };
const isAnc = (a, d) => { try { git(["merge-base", "--is-ancestor", a, d]); return true; } catch (e) { if (e.status === 1) return false; throw e; } };

const M = rev("HEAD");
const S4B3 = "60bf9dc44a5f751551a9ce0195abb87f5c97543d";
const PR_HEAD = "0b28c7ba37190ddf416f9a845bc58a829abfd081";
console.log("M =", M, " origin/master =", rev("refs/remotes/origin/master"));
console.log("parents(M) =", git(["rev-list", "--parents", "-n1", M]).trim());

function section(t) { console.log(`\n=== ${t} ===`); }
function tryRun(label, fn) {
  try { const r = fn(); console.log(`OK   ${label}${r ? ": " + r : ""}`); return { ok: true, r }; }
  catch (e) { console.log(`STOP ${label}: ${e.message.split("\n")[0]}`); return { ok: false, e }; }
}

section("(i) S4b''' を commit、M を head");
for (const head of [M, PR_HEAD]) {
  const facts = adm.collectObservationPrepFacts({ root: ROOT, commit: S4B3, candidateHead: head });
  console.log(`head=${head.slice(0, 8)} recordIntroducedByCommit=${facts.recordIntroducedByCommit} onRemoteRef=${facts.onRemoteRef} ancestorOfCandidateHead=${facts.ancestorOfCandidateHead}`);
  console.log(`  recordSha256AtCommit=${facts.recordSha256AtCommit}`);
  console.log(`  recordSha256AtHead  =${facts.recordSha256AtHead}`);
  tryRun(`assertObservationPrepAdmits(head=${head.slice(0, 8)})`, () => { contract.assertObservationPrepAdmits(facts, head); });
  tryRun(`readAdmittedObservationPrep(head=${head.slice(0, 8)})`, () => {
    const r = adm.readAdmittedObservationPrep({ root: ROOT, prepCommit: S4B3, candidateHead: head });
    return `S2 status=${r.value.status} sha256=${r.sha256} placeholders=${JSON.stringify(r.value.placeholders)} boundFiles=${r.value.boundFiles.length} traces=${r.value.traces.length}`;
  });
}

section("(ii) 旧 S4b / S4b' / S4b'' と使わない前の版");
for (const [name, c] of [["旧 S4b", "b7d74950"], ["旧 S4b'", "9f52e7da"], ["旧 S4b''", "557e683c"], ["前の版 c6839a6f", "c6839a6f"], ["前の版 2c3a8473", "2c3a8473"]]) {
  tryRun(`${name} (${c})`, () => {
    const facts = adm.collectObservationPrepFacts({ root: ROOT, commit: c, candidateHead: M });
    contract.assertObservationPrepAdmits(facts, M);
    return "ADMITTED (想定外)";
  });
}

section("(iii) S4b''' 以外の commit を commit に指定");
for (const [name, c] of [["失効 d50b0a48", "d50b0a48"], ["S4a''' 02ede6bb", "02ede6bb"], ["S2 追補 daadd9f3", "daadd9f3"], ["S2 訂正 5e0c5f05", "5e0c5f05"], ["addendum 凍結 c65e352d", "c65e352d"], ["候補 179139b4", "179139b4"], ["manifest b02a8f14", "b02a8f14"], ["DR 0b28c7ba", PR_HEAD], ["M", M]]) {
  tryRun(`${name}`, () => {
    const facts = adm.collectObservationPrepFacts({ root: ROOT, commit: c, candidateHead: M });
    contract.assertObservationPrepAdmits(facts, M);
    return "ADMITTED (想定外)";
  });
}
tryRun("S4b''' を commit、旧 master 8187fbfc を head", () => {
  const facts = adm.collectObservationPrepFacts({ root: ROOT, commit: S4B3, candidateHead: "8187fbfc" });
  contract.assertObservationPrepAdmits(facts, "8187fbfc9685356225956dfce83431aec9845473");
  return "ADMITTED (想定外)";
});
section("順序: 失効・S4a'''・候補は S4b''' の祖先か、S4b''' の後に record を変える commit は無いか");
for (const c of ["d50b0a48", "c65e352d", "daadd9f3", "5e0c5f05", "13f04b26", "8020b22b", "02ede6bb", "fdb1fc9b", "179139b4", "557e683c"])
  console.log(`  ${c} ancestor of S4b''': ${isAnc(c, S4B3)}`);
console.log("  record を変えた commit (S4b'''..M):", git(["log", "--format=%h", `${S4B3}..${M}`, "--", "evals/nir1-graph/observation-prep-freeze.v1.json"]).trim() || "(none)");
console.log("  S4b''' の親:", git(["rev-list", "--parents", "-n1", S4B3]).trim().split(" ").slice(1).join(","));

section("(iv) pin の全件照合（S2 at M）");
const s2 = JSON.parse(blob(M, "evals/nir1-graph/observation-prep.v1.json").toString("utf8"));
const pins = s2.setupReadings.source.pins;
let files = 0, mism = 0;
const srcPins = new Map(op.SOURCE_PINS.map((row) => [row.role, row]));
for (const pin of pins) {
  const src = srcPins.get(pin.role);
  if (!src) { console.log(`  !! role ${pin.role} not in SOURCE_PINS`); mism++; }
  else {
    if (src.commit !== pin.commit) { console.log(`  !! ${pin.role} commit differs from SOURCE_PINS`); mism++; }
    if (src.check !== pin.check) { console.log(`  !! ${pin.role} check ${pin.check} vs SOURCE_PINS ${src.check}`); mism++; }
    const srcFiles = [...src.paths].sort(), s2Files = pin.files.map((f) => f.path).sort();
    if (JSON.stringify(srcFiles) !== JSON.stringify(s2Files)) { console.log(`  !! ${pin.role} file set differs from SOURCE_PINS`); mism++; }
  }
  if (!isAnc(pin.commit, M)) { console.log(`  !! ${pin.role} ${pin.commit} not ancestor of M`); mism++; }
  for (const f of pin.files) {
    files++;
    const atPin = blob(pin.commit, f.path), atM = blob(M, f.path);
    const a = atPin && sha(atPin), b = atM && sha(atM);
    const last = git(["log", "-1", "--format=%H", M, "--", f.path]).trim();
    if (a !== f.sha256 || b !== f.sha256) { console.log(`  !! ${pin.role} ${f.path}: pin=${a?.slice(0, 8)} M=${b?.slice(0, 8)} S2=${f.sha256.slice(0, 8)}`); mism++; }
    if (last !== pin.commit) { console.log(`  !! ${pin.role} ${f.path}: last changed in M by ${last.slice(0, 8)}, pin ${pin.commit.slice(0, 8)}`); mism++; }
  }
}
console.log(`  pins=${pins.length} files=${files} SOURCE_PINS=${op.SOURCE_PINS.length} mismatches=${mism}`);

section("(v) assertObservationPrepFormal / validateNir1ObservationPrep（作業ツリー = M）");
const v = await op.validateNir1ObservationPrep({ repoRoot: ROOT });
console.log(`  validate: errors=${v.errors.length} formalReady=${v.formalReady} placeholders=${v.placeholders?.length} status=${v.status ?? v.summary?.status ?? "?"}`);
if (v.errors.length) console.log(v.errors.slice(0, 5));
for (const head of [M, S4B3, "b02a8f14", PR_HEAD]) {
  try { const r = await op.assertObservationPrepFormal({ repoRoot: ROOT, head }); console.log(`OK   formal(head=${head.slice(0, 8)}): ${JSON.stringify(r)}`); }
  catch (e) { console.log(`STOP formal(head=${head.slice(0, 8)}): ${e.message.split("\n")[0].slice(0, 200)}`); }
}
try { await op.assertObservationPrepFormal({ repoRoot: ROOT, head: "02ede6bb" }); console.log("formal(head=S4a''') proceed (想定外?)"); }
catch (e) { console.log(`STOP formal(head=S4a''' 02ede6bb): ${e.message.split("\n")[0].slice(0, 160)}`); }
