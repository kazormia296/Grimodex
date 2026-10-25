// CP-4 admission facts collected from the local git object store and /proc.
//
// These readers run `git` synchronously and never touch the network (no
// fetch, no ls-remote): "on the remote" means contained in
// refs/remotes/origin/master, the same convention as standard-build.mjs.
// The guards that use the facts are pure and live in
// ../nir1-retrieval/contract.mjs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import process from "node:process";
import {
  assertEvalBuildReceipt,
  assertProductBuildReceipt,
  PRODUCT_NATIVE_ARTIFACT,
} from "../nir1-retrieval/contract.mjs";
import {
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_REMOTE_REF,
  rejectOverrides,
} from "./constants.mjs";

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
  return {
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
  };
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
