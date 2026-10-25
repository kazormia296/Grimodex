// CP-4 admission facts collected from the local git object store.
//
// These readers run `git` synchronously and never touch the network (no
// fetch, no ls-remote): "on a remote" means contained in a remote-tracking
// ref, the same convention as standard-build.mjs. The guards that use the
// facts are pure and live in ../nir1-retrieval/contract.mjs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { K62_FREEZE } from "./constants.mjs";

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

function isAncestor(root, ancestor, descendant) {
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function blobSha256(root, commit, file) {
  try {
    return sha256(git(root, ["show", `${commit}:${file}`]));
  } catch {
    return null;
  }
}

/**
 * Facts for assertObservationPrepAdmits: whether the observation-prep commit
 * is an ancestor of the candidate head, which remote-tracking refs contain
 * it, and the freeze record digest at that commit and at the head.
 */
export function collectObservationPrepFacts({
  root,
  commit,
  candidateHead,
  freezeRecordPath,
}) {
  const prep = resolveCommit(root, commit);
  const head = resolveCommit(root, candidateHead);
  const remoteRefs = git(root, [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    prep,
    "refs/remotes",
  ])
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  return {
    commit: prep,
    candidateHead: head,
    ancestorOfCandidateHead: isAncestor(root, prep, head),
    remoteRefs,
    freezeRecordPath,
    freezeRecordSha256AtCommit: blobSha256(root, prep, freezeRecordPath),
    freezeRecordSha256AtHead: blobSha256(root, head, freezeRecordPath),
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
  const digest = blobSha256(root, resolved, K62_FREEZE.path);
  if (digest === null)
    throw new Error(
      "[precheck] K6/2 cannot be read from the freeze commit; no receipt is written",
    );
  if (resolved !== K62_FREEZE.commit || digest !== K62_FREEZE.sha256)
    throw new Error(
      "[precheck] K6/2 freeze commit or bytes differ; no receipt is written",
    );
  return { freezeCommit: resolved, sha256: digest };
}

/**
 * §15.2: the harness refuses to launch when the default addon path holds the
 * evaluation build.
 */
export function assertDefaultAddonIsNotEvaluation({
  defaultAddonSha256,
  evalReceipt,
}) {
  const evalDigests = Object.entries(evalReceipt?.artifacts ?? {})
    .filter(([file]) => file.endsWith(".node"))
    .map(([, digest]) => digest);
  if (evalDigests.includes(defaultAddonSha256))
    throw new Error(
      "[precheck] the default addon path holds the evaluation build; refusing to launch",
    );
}
