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
// The formal runner (S6) is not written yet; runner.mjs is the dev preview
// runner (TASK §15.9). `admitGraphCaseRun` is the one function S6 must call
// before it launches Electron with the evaluation `.node` or reads a frozen
// fixture; `admitFrozenDryRun` is the entry for the §15.8 dry runs, and
// `assertReceiptHeadBound` binds a receipt's head to git before it is
// aggregated.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
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
import { claimFactsSealer } from "./admission-facts.mjs";
import {
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
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

/** The network namespace links of this process and its parent (Linux). */
export function readNetNamespaces() {
  if (process.platform !== "linux")
    return { unavailable: true, reason: `no /proc on ${process.platform}` };
  return {
    self: readlinkSync("/proc/self/ns/net"),
    parent: readlinkSync(`/proc/${process.ppid}/ns/net`),
  };
}

/**
 * P2-7: the single entry of a formal G-case run (S6). It resolves the
 * candidate head, collects the observation-prep facts from git itself (a
 * caller never hands them in), applies the N-1 guard
 * (`assertGraphArmRequestable`), refuses an evaluation build at the default
 * addon path, and reads the K6/2 and K6/4 freeze heads. The returned
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
  const k62 = readK62FreezeHead({ root, commit: input.k62Commit });
  const k64 = readK64FreezeHead({ root, commit: input.k64Commit });
  const sealed = Object.freeze({
    ...admission,
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
  return Object.freeze({
    dryRun: true,
    graphArm: "not-activated",
    fixtures: Object.freeze(fixtures.map((row) => Object.freeze({ ...row }))),
  });
}

/**
 * P2-7: a receipt's head bound to git before aggregation. The observation-prep
 * facts are re-collected for the receipt's candidate commit and must admit
 * (N-1); the head's freeze-record digest must be the record at the prep
 * commit; the K6/2 and K6/4 freeze heads must be read back from their
 * commits.
 */
export function assertReceiptHeadBound(input) {
  rejectOverrides(input, ["root", "receipt"]);
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
  const k62 = readK62FreezeHead({ root, commit: head?.k62?.freezeCommit });
  if (k62.sha256 !== head.k62.sha256)
    throw new Error("[precheck] head.k62 differs from the K6/2 freeze");
  const k64 = readK64FreezeHead({ root, commit: head?.k64?.freezeCommit });
  if (k64.sha256 !== head.k64.sha256)
    throw new Error("[precheck] head.k64 differs from the K6/4 freeze");
  return { observationPrep: facts.commit, k62, k64 };
}
