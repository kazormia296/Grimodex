// CP-4 admission facts collected from the local git object store and /proc,
// and the single entries a formal G-case runner goes through (P2-7).
//
// These readers run `git` synchronously and never touch the network (no
// fetch, no ls-remote): "on the remote" means contained in
// refs/remotes/origin/master, the same convention as standard-build.mjs.
// The guards that use the facts are pure and live in
// ../nir1-retrieval/contract.mjs; the facts they accept are only those this
// module collected (admission-facts.mjs seals them).
//
// The formal runner's skeleton is k64-runner.mjs (S1f; K6/4 R1〜R8 with the
// product hook consumer); runner.mjs is the S1c-2 dev preview runner (TASK
// §15.9). `admitGraphCaseRun` is the one function the formal runner calls
// before it launches Electron with the evaluation `.node` or reads a frozen
// fixture; `admitFrozenDryRun` is the entry for the §15.8 dry runs, and
// `assertReceiptHeadBound` binds a receipt's head to git before it is
// aggregated.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  GRAPH_ARM_SCOPES,
  GRAPH_ARM_WIRED,
  assertEvalBuildReceipt,
  assertFixtureReadAllowed,
  assertGraphArmRequestable,
  assertObservationPrepAdmits,
  assertProductBuildReceipt,
  classifyGraphFixturePath,
  PRODUCT_NATIVE_ARTIFACT,
} from "../nir1-retrieval/contract.mjs";
import { claimFactsSealer, isCollectedFacts } from "./admission-facts.mjs";
import { isLoadedDevFixture } from "./dev-fixture.mjs";
import { runKeepTest } from "./keep-test.mjs";
import { loadProcedureFile, procedureSettings } from "./procedure-file.mjs";
import {
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  K64_CANDIDATE_REQUIREMENTS,
  K64_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_REMOTE_REF,
  rejectOverrides,
} from "./constants.mjs";

/** Seals the facts this module collected (P2-7); claimed once, at load. */
const sealFacts = claimFactsSealer();
/** Admissions returned by admitGraphCaseRun (fixture reads need one). */
const ADMITTED = new WeakSet();

const HEX40 = /^[0-9a-f]{40}$/u;

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveCommit(root, ref) {
  const commit = git(root, ["rev-parse", "--verify", `${ref}^{commit}`])
    .toString("utf8")
    .trim();
  if (!HEX40.test(commit)) throw new Error(`[precheck] cannot resolve ${ref}`);
  return commit;
}

function refExists(root, ref) {
  try {
    git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(root, ancestor, descendant) {
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function blob(root, commit, file) {
  try {
    return git(root, ["show", `${commit}:${file}`]);
  } catch {
    return null;
  }
}

function parents(root, commit) {
  return git(root, ["rev-list", "--parents", "-n", "1", commit])
    .toString("utf8")
    .trim()
    .split(" ")
    .slice(1);
}

/**
 * Facts for assertObservationPrepAdmits. The record path is the fixed
 * OBSERVATION_PREP_RECORD_PATH, never an argument. The facts say whether the
 * commit introduced the record (no parent has it), is an ancestor of the
 * candidate head and of origin/master, the record digests at the commit and
 * the head, the record parsed at the head, and the head digests of every
 * file the record binds.
 */
export function collectObservationPrepFacts(input) {
  rejectOverrides(input, ["root", "commit", "candidateHead"]);
  const { root, commit, candidateHead } = input;
  const prep = resolveCommit(root, commit);
  const head = resolveCommit(root, candidateHead);
  const atCommit = blob(root, prep, OBSERVATION_PREP_RECORD_PATH);
  const atHead = blob(root, head, OBSERVATION_PREP_RECORD_PATH);
  const parentHas = parents(root, prep).some(
    (parent) => blob(root, parent, OBSERVATION_PREP_RECORD_PATH) !== null,
  );
  let record;
  try {
    record = atHead === null ? null : JSON.parse(atHead.toString("utf8"));
  } catch {
    record = null;
  }
  const bound = new Set([GRAPH_CASE_FREEZE.path, G01_FIXTURE.path]);
  if (record?.boundFiles && typeof record.boundFiles === "object")
    for (const file of Object.keys(record.boundFiles)) bound.add(file);
  const headFileSha256 = {};
  for (const file of bound) {
    const bytes =
      typeof file === "string" && !file.startsWith("-")
        ? blob(root, head, file)
        : null;
    headFileSha256[file] = bytes === null ? null : sha256(bytes);
  }
  const remoteKnown = refExists(root, OBSERVATION_PREP_REMOTE_REF);
  return sealFacts({
    recordPath: OBSERVATION_PREP_RECORD_PATH,
    commit: prep,
    candidateHead: head,
    ancestorOfCandidateHead: isAncestor(root, prep, head),
    remoteRef: OBSERVATION_PREP_REMOTE_REF,
    onRemoteRef:
      remoteKnown && isAncestor(root, prep, OBSERVATION_PREP_REMOTE_REF),
    recordIntroducedByCommit: atCommit !== null && !parentHas,
    recordSha256AtCommit: atCommit === null ? null : sha256(atCommit),
    recordSha256AtHead: atHead === null ? null : sha256(atHead),
    record,
    headFileSha256,
  });
}

/** `ancestor` is an ancestor of `descendant`; a commit not in the store is not. */
function ancestorOrMissing(root, ancestor, descendant) {
  if (!refExists(root, ancestor)) return false;
  return isAncestor(root, ancestor, descendant);
}

/**
 * 批准 5 (K6/4:32) collected from git, never from a receipt (D-1): (a) D′ and
 * (c) W_f are `git merge-base --is-ancestor` of the candidate head. (b) is
 * the RS-JOIN keep test passed on the candidate, which
 * `collectRatification5EvidenceWithKeepTest` runs itself on
 * `keepTestWorktree` (a clean worktree whose HEAD is the candidate and whose
 * install is the candidate's lock; keep-test.mjs, S1f／P2-4), or else the
 * hook commit as an ancestor. A keep test that is refused for any reason
 * (not clean, another head, another install, failed, zero tests, a leftover
 * process, …) leaves (b) to the ancestor check, which for this repository's
 * candidates is K6/2 (fail closed; the reason is kept). A receipt a caller
 * hands in is never read. The evidence is sealed like the N-1 facts;
 * `assessCandidateRegime` applies K6/4 only to sealed evidence, so a
 * self-reported `ancestor: true` or `passed: true` stays K6/2 (N31).
 */
function sealRatification5(root, head, keepTest) {
  const need = K64_CANDIDATE_REQUIREMENTS;
  const rsJoinHook =
    keepTest?.status === "passed"
      ? {
          evidence: "candidate-test",
          testFile: need.rsJoinKeepTest,
          head: keepTest.worktreeHead,
          testFileSha256: keepTest.testFileSha256,
          passed: true,
          tests: keepTest.tests.total,
          runDigest: keepTest.runDigest,
          // P2-4 (a): the install the keep test ran on.
          dependencies: keepTest.dependencies,
        }
      : {
          evidence: "ancestor",
          commit: need.rsJoinHookCommit,
          ancestor: ancestorOrMissing(root, need.rsJoinHookCommit, head),
          ...(keepTest
            ? { keepTest: { status: "refused", reason: keepTest.reason } }
            : {}),
        };
  return sealFacts({
    kind: "ratification5",
    candidateHead: head,
    dPrime: {
      commit: need.dPrimeCommit,
      ancestor: ancestorOrMissing(root, need.dPrimeCommit, head),
    },
    rsJoinHook,
    wfWindow: {
      commit: need.wfWindowCommit,
      ancestor: ancestorOrMissing(root, need.wfWindowCommit, head),
    },
  });
}

/**
 * 批准 5 from git without the keep test ((b) is the hook commit as an
 * ancestor). The keep test runs asynchronously in its own process group
 * (P2-4), so it has its own entry, `collectRatification5EvidenceWithKeepTest`.
 */
export function collectRatification5Evidence(input) {
  if (
    input !== null &&
    typeof input === "object" &&
    "keepTestWorktree" in input
  )
    throw new Error(
      "[precheck] the keep test runs in collectRatification5EvidenceWithKeepTest (async, P2-4)",
    );
  rejectOverrides(input, ["root", "candidateHead"]);
  const { root } = input;
  return sealRatification5(
    root,
    resolveCommit(root, input.candidateHead),
    null,
  );
}

/**
 * 批准 5 from git with (b) the keep test run on `keepTestWorktree`
 * (keep-test.mjs). `keepTestLogDir` (optional) receives the runner's logs.
 */
export async function collectRatification5EvidenceWithKeepTest(input) {
  rejectOverrides(input, [
    "root",
    "candidateHead",
    "keepTestWorktree",
    "keepTestLogDir",
  ]);
  const { root } = input;
  if (typeof input.keepTestWorktree !== "string")
    throw new Error(
      "[precheck] the keep test needs the candidate's clean worktree (keepTestWorktree)",
    );
  const head = resolveCommit(root, input.candidateHead);
  const keepTest = await runKeepTest({
    root,
    worktree: input.keepTestWorktree,
    candidateHead: head,
    testFile: K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest,
    ...(typeof input.keepTestLogDir === "string"
      ? { logDir: input.keepTestLogDir }
      : {}),
  });
  return sealRatification5(root, head, keepTest);
}

/**
 * P2-4: 批准 5 a formal entry is handed must be this module's sealed record
 * for the same candidate head (from either collector above).
 */
function assertSealedRatification5(evidence, head) {
  if (
    !isCollectedFacts(evidence) ||
    evidence.kind !== "ratification5" ||
    evidence.testOnly === true
  )
    throw new Error(
      "[precheck] ratification5 must be the sealed evidence of collectRatification5Evidence or collectRatification5EvidenceWithKeepTest",
    );
  if (evidence.candidateHead !== head)
    throw new Error(
      "[precheck] ratification5 was collected for another candidate head",
    );
  return evidence;
}

/**
 * K6/2 "事前登録の凍結" 2 / N-4: the freeze commit must be given and the
 * K6/2 bytes read from that commit must have the frozen sha256; otherwise the
 * run ends before writing any receipt.
 */
export function readK62FreezeHead({ root, commit }) {
  if (!commit)
    throw new Error(
      "[precheck] the K6/2 freeze commit is not given; no receipt is written",
    );
  const resolved = resolveCommit(root, commit);
  const bytes = blob(root, resolved, K62_FREEZE.path);
  if (bytes === null)
    throw new Error(
      "[precheck] K6/2 cannot be read from the freeze commit; no receipt is written",
    );
  const digest = sha256(bytes);
  if (resolved !== K62_FREEZE.commit || digest !== K62_FREEZE.sha256)
    throw new Error(
      "[precheck] K6/2 freeze commit or bytes differ; no receipt is written",
    );
  return { freezeCommit: resolved, sha256: digest };
}

/**
 * K6/4 批准 7: the K6/4 freeze head, read from the freeze commit the
 * integrator pinned in K64_FREEZE. Until it is pinned (the freeze on
 * `claude/nir1-contracts` is not made yet), no formal run starts.
 */
export function readK64FreezeHead({ root, commit }) {
  if (K64_FREEZE.freezeCommit === null)
    throw new Error(
      "[precheck] the K6/4 freeze commit is not pinned (批准 7); no formal receipt is written",
    );
  if (!commit)
    throw new Error(
      "[precheck] the K6/4 freeze commit is not given; no receipt is written",
    );
  const resolved = resolveCommit(root, commit);
  const bytes = blob(root, resolved, K64_FREEZE.path);
  if (bytes === null)
    throw new Error(
      "[precheck] K6/4 cannot be read from the freeze commit; no receipt is written",
    );
  const digest = sha256(bytes);
  if (resolved !== K64_FREEZE.freezeCommit || digest !== K64_FREEZE.sha256)
    throw new Error(
      "[precheck] K6/4 freeze commit or bytes differ; no receipt is written",
    );
  return { freezeCommit: resolved, sha256: digest };
}

/**
 * §15.2 (positive form): the default addon path holds exactly the product
 * standard-build `.node` of the candidate, and never the evaluation addon.
 */
export function assertDefaultAddonIsProduct({
  defaultAddonSha256,
  productReceipt,
  evalReceipt,
}) {
  assertProductBuildReceipt(productReceipt);
  assertEvalBuildReceipt(evalReceipt);
  if (defaultAddonSha256 !== productReceipt.artifacts[PRODUCT_NATIVE_ARTIFACT])
    throw new Error(
      "[precheck] the default addon path does not hold the product standard-build .node; refusing to launch",
    );
  const evalDigests = Object.entries(evalReceipt.artifacts)
    .filter(([file]) => file.endsWith(".node"))
    .map(([, digest]) => digest);
  if (evalDigests.includes(defaultAddonSha256))
    throw new Error(
      "[precheck] the default addon path holds the evaluation build; refusing to launch",
    );
}

function readOrNull(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The netns of the user's `systemd --user` (same uid), or null. */
function userManagerNetns(procRoot, uid) {
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const status = readOrNull(() =>
      readFileSync(path.join(procRoot, entry, "status"), "utf8"),
    );
    if (!status || !/^Name:\s+systemd$/mu.test(status)) continue;
    const owner = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
    if (Number(owner) !== uid) continue;
    const cmdline = readOrNull(() =>
      readFileSync(path.join(procRoot, entry, "cmdline"), "utf8"),
    );
    if (!cmdline?.split("\0").includes("--user")) continue;
    const link = readOrNull(() =>
      readlinkSync(path.join(procRoot, entry, "ns", "net")),
    );
    if (link) return link;
  }
  return null;
}

/**
 * The network namespace links of this process and its parent (Linux), and
 * the host baseline (B-4): the interfaces of this namespace (a private
 * `unshare -n` one has only `lo`) and the namespace of the user's
 * `systemd --user`. A wrapper started inside `unshare -rn` puts the harness
 * and its parent in the same private namespace, which self === parent alone
 * does not see.
 */
export function readNetNamespaces({
  procRoot = "/proc",
  selfPid = process.pid,
  parentPid = process.ppid,
  uid = process.getuid?.(),
} = {}) {
  if (process.platform !== "linux")
    return { unavailable: true, reason: `no /proc on ${process.platform}` };
  const dev = readOrNull(() =>
    readFileSync(path.join(procRoot, String(selfPid), "net", "dev"), "utf8"),
  );
  return {
    self: readlinkSync(path.join(procRoot, String(selfPid), "ns", "net")),
    parent: readlinkSync(path.join(procRoot, String(parentPid), "ns", "net")),
    hostInterfaces:
      dev === null
        ? []
        : dev
            .split("\n")
            .slice(2)
            .map((line) => /^\s*([^:\s]+):/u.exec(line)?.[1])
            .filter(Boolean),
    userManager: userManagerNetns(procRoot, uid),
  };
}

/**
 * P2-7: the single entry of a formal G-case run (S6). It resolves the
 * candidate head, collects the observation-prep facts from git itself (a
 * caller never hands them in), applies the N-1 guard
 * (`assertGraphArmRequestable`), refuses an evaluation build at the default
 * addon path, collects 批准 5 from git (D-1), and reads the K6/2 and K6/4
 * freeze heads. The returned
 * admission is the only one `readAdmittedFixture` accepts.
 */
export function admitGraphCaseRun(input) {
  rejectOverrides(input, [
    "root",
    "candidateHead",
    "prepCommit",
    "buildReceipt",
    "productReceipt",
    "fixtures",
    "defaultAddonSha256",
    "k62Commit",
    "k64Commit",
    "ratification5",
  ]);
  const { root } = input;
  const fixtures = Array.isArray(input.fixtures) ? input.fixtures : [];
  if (
    fixtures.length === 0 ||
    !fixtures.every((row) => classifyGraphFixturePath(row?.path) === "frozen")
  )
    throw new Error(
      "[precheck] a formal G-case run measures frozen fixtures only; a dev preview is not admitted here",
    );
  if (!input.prepCommit)
    throw new Error(
      "[precheck] the pre-observation commit is not given for a frozen fixture",
    );
  const head = resolveCommit(root, input.candidateHead);
  const observationPrep = collectObservationPrepFacts({
    root,
    commit: input.prepCommit,
    candidateHead: head,
  });
  const admission = assertGraphArmRequestable(GRAPH_ARM_WIRED, {
    scope: GRAPH_ARM_SCOPES.graphCase,
    buildReceipt: input.buildReceipt,
    productReceipt: input.productReceipt,
    fixtures,
    observationPrep,
  });
  if (admission.candidateHead !== head)
    throw new Error(
      "[precheck] the build receipts are for another candidate head",
    );
  assertDefaultAddonIsProduct({
    defaultAddonSha256: input.defaultAddonSha256,
    productReceipt: input.productReceipt,
    evalReceipt: input.buildReceipt,
  });
  // D-1: 批准 5 from git, sealed; the formal runner records it in the
  // receipt and passes it to the summaries. With the keep test it is
  // collected before (async, P2-4) and handed in sealed.
  const ratification5 =
    input.ratification5 === undefined
      ? collectRatification5Evidence({ root, candidateHead: head })
      : assertSealedRatification5(input.ratification5, head);
  const k62 = readK62FreezeHead({ root, commit: input.k62Commit });
  const k64 = readK64FreezeHead({ root, commit: input.k64Commit });
  const sealed = Object.freeze({
    ...admission,
    ratification5,
    head: Object.freeze({
      k62,
      k64,
      observationPrep: Object.freeze({
        commit: observationPrep.commit,
        freezeRecordSha256: observationPrep.recordSha256AtCommit,
      }),
    }),
  });
  ADMITTED.add(sealed);
  return sealed;
}

/** Dev preview admissions (admitDevPreview); never a CP-4 result. */
const DEV_PREVIEWS = new WeakSet();
export const DEV_PREVIEW_PURPOSES = Object.freeze([
  "runner-preview",
  // S1f: the K6/4 runner's dev preview (k64-runner.mjs).
  "k64-runner-preview",
  "dprime-check",
  "hook-check",
  "diag-registration",
  "smoke",
  "setup",
]);

/**
 * D-6: the admission of a dev preview launch of the evaluation `.node`
 * (TASK §15.9; seen by the integrator only, never aggregated). It accepts a
 * dev fixture path or none (smoke, diagnostics), never a frozen fixture: a
 * frozen G-case is launched only with admitGraphCaseRun's admission.
 */
export function admitDevPreview(input) {
  rejectOverrides(input, ["purpose", "fixture"]);
  if (!DEV_PREVIEW_PURPOSES.includes(input.purpose))
    throw new Error(
      `[precheck] a dev preview launch names one of ${DEV_PREVIEW_PURPOSES.join(", ")}`,
    );
  // E-7: bound to the fixture actually read (loadDevFixture's own object,
  // which refuses frozen paths and copies of frozen material), never a path.
  const fixture = input.fixture ?? null;
  if (fixture !== null && !isLoadedDevFixture(fixture))
    throw new Error(
      "[precheck] a dev preview admission binds the fixture loadDevFixture returned",
    );
  if (fixture !== null && classifyGraphFixturePath(fixture.path) !== "dev")
    throw new Error(
      "[precheck] a dev preview never launches the evaluation build on a frozen fixture",
    );
  const admission = Object.freeze({
    kind: "dev-preview",
    purpose: input.purpose,
    fixturePath: fixture?.path ?? null,
    fixtureSha256: fixture?.sha256 ?? null,
  });
  DEV_PREVIEWS.add(admission);
  return admission;
}

/** D-6: an admission that may launch the evaluation `.node`. */
export function isLaunchAdmission(admission) {
  return (
    admission !== null &&
    typeof admission === "object" &&
    (ADMITTED.has(admission) || DEV_PREVIEWS.has(admission))
  );
}

/** A fixture read of a formal run: only with admitGraphCaseRun's admission. */
export function readAdmittedFixture(admission, target) {
  if (!ADMITTED.has(admission))
    throw new Error(
      "[precheck] fixture reads need the admission returned by admitGraphCaseRun",
    );
  return assertFixtureReadAllowed(admission, target);
}

/**
 * TASK §15.8: before the observation-prep commit, setup and R / R+IR dry runs
 * on frozen fixture paths launch the product `.node` (Graph not activated),
 * never the evaluation build. Returns the dry-run admission (no Graph arm).
 */
/** Dry-run admissions admitFrozenDryRun returned (S1j P3). */
const FROZEN_DRY_RUNS = new WeakSet();

export function admitFrozenDryRun(input) {
  rejectOverrides(input, [
    "fixtures",
    "nativeSha256",
    "productReceipt",
    "evalReceipt",
  ]);
  assertProductBuildReceipt(input.productReceipt);
  const fixtures = Array.isArray(input.fixtures) ? input.fixtures : [];
  if (
    fixtures.length === 0 ||
    !fixtures.every((row) => classifyGraphFixturePath(row?.path) === "frozen")
  )
    throw new Error("[precheck] a frozen dry run names frozen fixtures only");
  if (
    input.nativeSha256 !==
    input.productReceipt.artifacts[PRODUCT_NATIVE_ARTIFACT]
  )
    throw new Error(
      "[precheck] a dry run on a frozen fixture path must launch the product .node (§15.8)",
    );
  if (input.evalReceipt) {
    assertEvalBuildReceipt(input.evalReceipt);
    const evalNodes = Object.entries(input.evalReceipt.artifacts)
      .filter(([file]) => file.endsWith(".node"))
      .map(([, digest]) => digest);
    if (evalNodes.includes(input.nativeSha256))
      throw new Error(
        "[precheck] a dry run on a frozen fixture path must launch the product .node, not the evaluation build (§15.8)",
      );
  }
  const admission = Object.freeze({
    dryRun: true,
    graphArm: "not-activated",
    fixtures: Object.freeze(fixtures.map((row) => Object.freeze({ ...row }))),
  });
  FROZEN_DRY_RUNS.add(admission);
  return admission;
}

/**
 * S1j P3: an admission admitFrozenDryRun returned (the object itself, never
 * a copy with the same values), for the R5 check run's entry.
 */
export function isFrozenDryRunAdmission(admission) {
  return (
    admission !== null &&
    typeof admission === "object" &&
    FROZEN_DRY_RUNS.has(admission)
  );
}

/**
 * P2-7: a receipt's head bound to git before aggregation. The observation-prep
 * facts are re-collected for the receipt's candidate commit and must admit
 * (N-1); the head's freeze-record digest must be the record at the prep
 * commit; the K6/2 and K6/4 freeze heads must be read back from their
 * commits.
 */
export function assertReceiptHeadBound(input) {
  rejectOverrides(input, ["root", "receipt", "ratification5"]);
  const { root, receipt } = input;
  const head = receipt?.head;
  const facts = collectObservationPrepFacts({
    root,
    commit: head?.observationPrep?.commit,
    candidateHead: receipt?.candidate?.commit,
  });
  assertObservationPrepAdmits(facts, facts.candidateHead);
  if (head.observationPrep.freezeRecordSha256 !== facts.recordSha256AtCommit)
    throw new Error(
      "[precheck] head.observationPrep.freezeRecordSha256 differs from the freeze record at the pre-observation commit",
    );
  const ratification5 = bindRecordedRatification5(
    root,
    receipt,
    input.ratification5,
  );
  const k62 = readK62FreezeHead({ root, commit: head?.k62?.freezeCommit });
  if (k62.sha256 !== head.k62.sha256)
    throw new Error("[precheck] head.k62 differs from the K6/2 freeze");
  const k64 = readK64FreezeHead({ root, commit: head?.k64?.freezeCommit });
  if (k64.sha256 !== head.k64.sha256)
    throw new Error("[precheck] head.k64 differs from the K6/4 freeze");
  // S1f: the procedure file, read back from its commit (validateCp4Receipt
  // takes it as `bound.procedure`).
  const procedure = assertProcedureBound({ root, receipt });
  return { observationPrep: facts.commit, k62, k64, ratification5, procedure };
}

/** D-1: the re-collected evidence must be the receipt's record. */
function assertSameRatification5(evidence, recorded) {
  if (JSON.stringify(evidence) !== JSON.stringify(recorded))
    throw new Error(
      "[precheck] candidate.ratification5 differs from the 批准 5 evidence re-collected from git (D-1)",
    );
  return evidence;
}

/**
 * assertReceiptHeadBound's 批准 5 (sync): the sealed re-collection handed in
 * (rebindRatification5's result for a keep-test record), or, for an
 * ancestor record, re-collected here. Null when the receipt records none.
 */
function bindRecordedRatification5(root, receipt, evidence) {
  if (!receipt?.candidate || !Object.hasOwn(receipt.candidate, "ratification5"))
    return null;
  const recorded = receipt.candidate.ratification5;
  const head = resolveCommit(root, receipt.candidate.commit);
  if (evidence !== undefined)
    return assertSameRatification5(
      assertSealedRatification5(evidence, head),
      recorded,
    );
  if (recorded?.rsJoinHook?.evidence === "candidate-test")
    throw new Error(
      "[precheck] candidate.ratification5 (b) is the keep test; re-collect it with rebindRatification5 on the candidate's clean worktree (keepTestWorktree) and pass the result as ratification5",
    );
  return assertSameRatification5(
    collectRatification5Evidence({ root, candidateHead: head }),
    recorded,
  );
}

/**
 * D-1 / S1f: a receipt's recorded 批准 5 is self-reported; it is re-collected
 * for the receipt's candidate and must be the same record. A record whose
 * (b) is the keep test is re-collected by running the keep test again on
 * `keepTestWorktree` (the digest holds no time, so a passing run repeats it;
 * async, P2-4). Resolves to the sealed evidence, or null when the receipt
 * records none.
 */
export async function rebindRatification5(input) {
  rejectOverrides(input, [
    "root",
    "receipt",
    "keepTestWorktree",
    "keepTestLogDir",
  ]);
  const { root, receipt } = input;
  if (!receipt?.candidate || !Object.hasOwn(receipt.candidate, "ratification5"))
    return null;
  const recorded = receipt.candidate.ratification5;
  if (recorded?.rsJoinHook?.evidence !== "candidate-test")
    return bindRecordedRatification5(root, receipt, undefined);
  if (typeof input.keepTestWorktree !== "string")
    throw new Error(
      "[precheck] candidate.ratification5 (b) is the keep test; re-collecting it runs the keep test again on the candidate's clean worktree (keepTestWorktree)",
    );
  return assertSameRatification5(
    await collectRatification5EvidenceWithKeepTest({
      root,
      candidateHead: receipt.candidate.commit,
      keepTestWorktree: input.keepTestWorktree,
      ...(typeof input.keepTestLogDir === "string"
        ? { keepTestLogDir: input.keepTestLogDir }
        : {}),
    }),
    recorded,
  );
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * S1f: the procedure file a formal K6/4 receipt names (`settings.k64`), read
 * from its commit with the production loader (a draft is refused); the
 * receipt's record must equal it (版の食い違い otherwise).
 */
export function assertProcedureBound(input) {
  rejectOverrides(input, ["root", "receipt"]);
  const k64 = input.receipt?.settings?.k64;
  const file = k64?.procedureFile;
  if (!file || typeof file !== "object")
    throw new Error(
      "[precheck] settings.k64.procedureFile is missing; a formal K6/4 receipt names its procedure file",
    );
  const procedure = loadProcedureFile({
    root: input.root,
    version: file.version,
    commit: file.commit ?? null,
    purpose: "formal",
  });
  if (stableJson(procedureSettings(procedure)) !== stableJson(k64))
    throw new Error(
      "[precheck] settings.k64 differs from the procedure file read from its commit (版の食い違い)",
    );
  return procedure;
}
