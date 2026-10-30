// CP-4 S5-A: 凍結した G-case の正式の run の admission（DR-CP4-N-1 (1)）。
//
// 安い検査から順に行い、どれかが違えば `[precheck]` で止める（receipt を書く前）:
//   1. 候補が clean で、HEAD が固定の候補の commit。
//   2. K6/4 の凍結の head（`readK64FreezeHead`。descriptor は既定の
//      `K64_FREEZE`、試験だけが T14 の型の descriptor を注入する）。
//   3. S4 の commit から S2 の file（observation-prep と宣言の addendum 2 本）を
//      git で読む（作業 tree は読まない）。候補の head の bytes も同じこと。
//      どの file も S4 の freeze record が束縛した sha256 であること
//      （`readAdmittedObservationPrep`／`readFreezeBoundFile`、DR-CP4-S4-1）。
//   4. `setupReadings.source.pins` の照合（bytes の pin は候補の commit と作業
//      tree の同じ path の sha256、ancestor の pin は候補の祖先）。
//   5. 手順のファイル（`k64-procedure.v1.json`）を S4 の commit から formal で読む。
//   6. `admitGraphCaseRun`（N-1、受領書、既定の addon、批准 5、K6/2・K6/4 の
//      凍結、観測前の commit の facts。凍結の fixture 8 本）。
// 標準と評価の build の受領書の head 照合（`checkRunnerBuildReceipts`、required）は
// candidate block を作った後に runner が行う。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  OBSERVATION_PREP_S2_PATH,
  admitGraphCaseRun,
  readAdmittedObservationPrep,
  readFreezeBoundFile,
  readK64FreezeHead,
} from "./admission.mjs";
import {
  FROZEN_FIXTURE_SHA256,
  K64_FREEZE,
  rejectOverrides,
} from "./constants.mjs";
import { loadProcedureFile } from "./procedure-file.mjs";

/** The S2 files the formal runner reads at the S4 commit. */
export const S2_FILES = Object.freeze({
  observationPrep: OBSERVATION_PREP_S2_PATH,
  declarationAddendum: "evals/nir1-graph/declaration-addendum.v1.json",
  g01Addendum: "evals/nir1-g01/setup-addendum.v1.json",
});
export const FORMAL_PROCEDURE_VERSION = "v1";
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolve(root, ref, label) {
  try {
    const commit = git(root, ["rev-parse", "--verify", `${ref}^{commit}`])
      .toString("utf8")
      .trim();
    if (HEX40.test(commit)) return commit;
  } catch {
    // fall through
  }
  throw new Error(`[precheck] S5 admission: cannot resolve ${label} ${ref}`);
}

function show(root, commit, file) {
  try {
    return git(root, ["show", `${commit}:${file}`]);
  } catch {
    return null;
  }
}

/** 1. The candidate is clean and HEAD is the fixed candidate commit. */
export function assertCandidateFixed({ root, candidate }) {
  if (!HEX40.test(candidate ?? ""))
    throw new Error(
      "[precheck] S5 admission: the candidate is given as a full commit sha (fixed before the run)",
    );
  const head = resolve(root, "HEAD", "HEAD");
  if (head !== candidate)
    throw new Error(
      `[precheck] S5 admission: HEAD ${head} is not the fixed candidate ${candidate}`,
    );
  const status = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).toString("utf8");
  if (status.trim() !== "")
    throw new Error(
      "[precheck] S5 admission: the candidate worktree is not clean",
    );
  return {
    commit: head,
    tree: git(root, ["rev-parse", "HEAD^{tree}"]).toString("utf8").trim(),
  };
}

/** 3. The S2 files at the S4 commit (and the same bytes at the candidate). */
export function readS2AtCommit({ root, commit, candidate }) {
  const prep = resolve(root, commit, "the S4 commit");
  const files = {};
  for (const [name, file] of Object.entries(S2_FILES)) {
    const bytes = show(root, prep, file);
    if (bytes === null)
      throw new Error(
        `[precheck] S5 admission: ${file} cannot be read from the S4 commit ${prep}`,
      );
    const atCandidate = candidate ? show(root, candidate, file) : bytes;
    if (atCandidate === null || sha256(atCandidate) !== sha256(bytes))
      throw new Error(
        `[precheck] S5 admission: ${file} differs between the S4 commit and the candidate`,
      );
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`[precheck] S5 admission: ${file} is not JSON`);
    }
    files[name] = { path: file, sha256: sha256(bytes), value };
  }
  // DR-CP4-S4-1: the bytes are the ones the S4 freeze record binds (read
  // as the candidate head's blob, the same reader as the S5-B entries).
  const admitted = readAdmittedObservationPrep({
    root,
    prepCommit: prep,
    candidateHead: candidate || prep,
  });
  for (const row of Object.values(files)) {
    const bound =
      row.path === OBSERVATION_PREP_S2_PATH
        ? admitted
        : readFreezeBoundFile({ root, facts: admitted.facts, file: row.path });
    if (bound.sha256 !== row.sha256)
      throw new Error(
        `[precheck] S5 admission: ${row.path} at the S4 commit is not the bytes the freeze record binds`,
      );
  }
  return { commit: prep, files };
}

function isAncestor(root, ancestor, descendant) {
  // A commit missing from the store is not an ancestor (fail closed).
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 4. S2 `setupReadings.source.pins` (runnerHandoff 追補 #2／#3): a `bytes`
 * pin's files have the pinned sha256 at the candidate commit and in the
 * worktree; an `ancestor` pin's commit is an ancestor of the candidate.
 */
export function assertSourcePins({ root, candidate, pins }) {
  if (!Array.isArray(pins) || pins.length === 0)
    throw new Error(
      "[precheck] S5 admission: setupReadings.source.pins is empty",
    );
  return pins.map((pin) => {
    if (!HEX40.test(pin?.commit ?? ""))
      throw new Error(
        `[precheck] S5 admission: the pin ${String(pin?.role)} names no commit`,
      );
    if (pin.check === "ancestor") {
      if (!isAncestor(root, pin.commit, candidate))
        throw new Error(
          `[precheck] S5 admission: the candidate does not have the ${pin.role} pin ${pin.commit} as an ancestor; S2 re-checks its readings on a new pin`,
        );
      return { role: pin.role, check: "ancestor", commit: pin.commit };
    }
    if (
      pin.check !== "bytes" ||
      !Array.isArray(pin.files) ||
      pin.files.length === 0
    )
      throw new Error(
        `[precheck] S5 admission: the pin ${pin.role} is neither a bytes pin with files nor an ancestor pin`,
      );
    const files = pin.files.map((row) => {
      if (!HEX64.test(row?.sha256 ?? "") || typeof row?.path !== "string")
        throw new Error(
          `[precheck] S5 admission: the pin ${pin.role} has a malformed file row`,
        );
      const atCandidate = show(root, candidate, row.path);
      let inTree;
      try {
        inTree = readFileSync(path.join(root, row.path));
      } catch {
        inTree = null;
      }
      if (
        atCandidate === null ||
        inTree === null ||
        sha256(atCandidate) !== row.sha256 ||
        sha256(inTree) !== row.sha256
      )
        throw new Error(
          `[precheck] S5 admission: ${row.path} is not the bytes the ${pin.role} pin (${pin.commit}) holds; S2 re-checks its readings on a new pin`,
        );
      return { path: row.path, sha256: row.sha256 };
    });
    return { role: pin.role, check: "bytes", commit: pin.commit, files };
  });
}

/**
 * The formal admission. `deps.freeze` (a T14 descriptor) and
 * `deps.admitGraphCase` are for the tests only; the runner uses the
 * defaults.
 */
export function admitFormalK64Run(input, deps = {}) {
  rejectOverrides(input, [
    "root",
    "candidate",
    "prepCommit",
    "k62Commit",
    "k64Commit",
    "buildReceipt",
    "productReceipt",
    "defaultAddonSha256",
    "ratification5",
  ]);
  const { freeze = K64_FREEZE, admitGraphCase = admitGraphCaseRun } = deps;
  const { root } = input;
  const candidate = assertCandidateFixed({ root, candidate: input.candidate });
  const k64 = readK64FreezeHead({ root, commit: input.k64Commit }, freeze);
  if (!input.prepCommit)
    throw new Error("[precheck] S5 admission: the S4 commit is not given");
  const s2 = readS2AtCommit({
    root,
    commit: input.prepCommit,
    candidate: candidate.commit,
  });
  const pins = assertSourcePins({
    root,
    candidate: candidate.commit,
    pins: s2.files.observationPrep.value?.setupReadings?.source?.pins,
  });
  const procedure = loadProcedureFile({
    root,
    version: FORMAL_PROCEDURE_VERSION,
    commit: s2.commit,
    purpose: "formal",
  });
  const admission = admitGraphCase({
    root,
    candidateHead: candidate.commit,
    prepCommit: s2.commit,
    buildReceipt: input.buildReceipt,
    productReceipt: input.productReceipt,
    fixtures: Object.entries(FROZEN_FIXTURE_SHA256).map(([file, digest]) => ({
      path: file,
      sha256: digest,
    })),
    defaultAddonSha256: input.defaultAddonSha256,
    k62Commit: input.k62Commit,
    k64Commit: input.k64Commit,
    ...(input.ratification5 !== undefined
      ? { ratification5: input.ratification5 }
      : {}),
  });
  return Object.freeze({
    candidate,
    k64,
    s2,
    pins,
    procedure,
    admission,
  });
}

/** P2-6: the attempt ledger (one file per run name, never overwritten). */
export const ATTEMPTS_DIR = ".artifacts/cp4/attempts";
export const ATTEMPT_SCHEMA = "nir1-cp4-attempt/1";
// S5-B (DR-CP4-O-16): the diagnostics' attempts in the same ledger.
export const RUN_KINDS = Object.freeze([
  "gold",
  "parity",
  "negative",
  "sp-p4",
  "trace",
]);

function attemptsDir(root) {
  return path.join(root, ATTEMPTS_DIR);
}

/**
 * Every recorded attempt of the same (candidate commit, S4 commit, run
 * kind), oldest first. No upper bound: the count cannot be hidden.
 */
export function listAttempts({ root, candidate, s4Commit, runKind = null }) {
  let names;
  try {
    names = readdirSync(attemptsDir(root));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      // The file's digest goes with each row (re-review: the ledger's bytes
      // are named in the receipt and in its copy on the remote, N-14).
      let bytes;
      try {
        bytes = readFileSync(path.join(attemptsDir(root), name));
        return {
          ...JSON.parse(bytes.toString("utf8")),
          fileSha256: sha256(bytes),
        };
      } catch {
        return {
          schema: null,
          unreadable: name,
          fileSha256: bytes ? sha256(bytes) : null,
        };
      }
    })
    .filter(
      (row) =>
        row.unreadable ||
        (row.schema === ATTEMPT_SCHEMA &&
          row.candidate?.commit === candidate &&
          row.s4Commit === s4Commit &&
          (runKind === null || row.runKind === runKind)),
    )
    .sort((left, right) =>
      // An unreadable file sorts first (it is listed, never dropped).
      String(left.startedAtUtc ?? "").localeCompare(
        String(right.startedAtUtc ?? ""),
      ),
    );
}

/**
 * Records an attempt before anything is measured. A run name is used once
 * (the file is never overwritten); `[precheck]` otherwise.
 */
export function startAttempt({ root, runName, entry }) {
  if (!RUN_KINDS.includes(entry?.runKind))
    throw new Error(
      `[precheck] S5 attempts: the run kind is ${RUN_KINDS.join(" or ")}`,
    );
  mkdirSync(attemptsDir(root), { recursive: true });
  const file = path.join(attemptsDir(root), `${runName}.json`);
  const record = {
    schema: ATTEMPT_SCHEMA,
    runName,
    status: "started",
    ...entry,
  };
  try {
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch {
    throw new Error(
      `[precheck] S5 attempts: ${runName} was already attempted; a new attempt takes a new run name`,
    );
  }
  return { file, record, fileSha256: sha256(readFileSync(file)) };
}

/** Closes an attempt with its outcome and finish time (UTC). */
export function finishAttempt({ file, status, variants = null }) {
  const record = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    `${JSON.stringify(
      { ...record, status, finishedAtUtc: new Date().toISOString(), variants },
      null,
      2,
    )}\n`,
  );
}

/** A ledger row as the receipts disclose it (every status, its digest). */
export function attemptSummary(row) {
  return {
    runName: row.runName ?? row.unreadable ?? null,
    runKind: row.runKind ?? null,
    status: row.status ?? "unreadable",
    startedAtUtc: row.startedAtUtc ?? null,
    finishedAtUtc: row.finishedAtUtc ?? null,
    fileSha256: row.fileSha256 ?? null,
  };
}

/**
 * The attempt's closing status (re-review P2-1): `completed` only when every
 * variant has a valid record and none is blocked; a run with a blocked
 * variant is `incomplete-blocked` (its records stay); anything else
 * `stopped`.
 */
export function attemptStatusOf({ problems, variants }) {
  const rows = Object.values(variants ?? {});
  if (
    (problems ?? []).length > 0 ||
    rows.length === 0 ||
    rows.some((row) => row.valid !== true)
  )
    return "stopped";
  if (rows.some((row) => String(row.status).startsWith("blocked")))
    return "incomplete-blocked";
  return "completed";
}

/**
 * d10.parity (P1-2, re-review P2-2): the unrestricted parity run comes before
 * the restricted Gold run of the same candidate and S4 commit. The parity a
 * Gold run uses is fixed: the one completed parity attempt of this
 * candidate and S4 commit, finished before the Gold run starts. None, or two
 * or more completed (a choice made after seeing results would be possible),
 * is `[precheck]`. Every parity attempt (any status) is disclosed.
 */
export function selectParity({ attempts, startedAtUtc }) {
  const parity = attempts.filter(
    (row) => row.runKind === "parity" || row.unreadable,
  );
  const completed = parity.filter((row) => row.status === "completed");
  if (completed.length > 1)
    throw new Error(
      `[precheck] d10.parity: ${completed.length} completed parity runs of this candidate and S4 commit (${completed.map((row) => row.runName).join(", ")}); which one a Gold run compares with is not chosen after the results (the integrator decides)`,
    );
  const used = completed.find(
    (row) =>
      typeof row.finishedAtUtc === "string" && row.finishedAtUtc < startedAtUtc,
  );
  if (!used)
    throw new Error(
      "[precheck] d10.parity: no completed unrestricted parity run of this candidate and S4 commit precedes the restricted run",
    );
  return { used: used.runName, attempts: parity.map(attemptSummary) };
}
