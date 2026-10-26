// CP-4 S1f: K6/4 の手順のファイル（版つき）の schema・loader・validator。
//
// K6/4（draftRef `nir1-final-request-eval-proposal/4`、contractId
// `graph-eval-procedure`）の Mandatory defenses（:209）は、T_late、W_f、T_show、
// F1〜F7、X1〜X13、R1 と R4 の待ちの上限を「観測の前に、この draft の凍結と手順
// のファイルの版で固定し、独立 reviewer のレビューを受ける」とする。この module は
// その file を読み、契約の値（constants.mjs）と一致することを確かめるだけで、値を
// 決めない。値の最終決定と trace／sample の計画は S2 の作者と独立 reviewer が行う
// （DR-CP4-F-1）。
//
// 置き場: `scripts/quality/nir1-graph-eval/procedure/k64-procedure.<版>.json`。
// 版は `v<N>`（正式。draft でなく、レビューの記録を持つ）か `draft-<N>`（dev の仮の
// 版。正式の run には使えない）。file 名の版と中身の `version` は一致する。
//
// 拒むもの: 契約の値と違う値（広げる・狭めるを問わない。K6/4 変える点 16 の「観測の
// 後に狭める」新しい版は、レビューと変える前の receipt の扱いが決まるまで受け付け
// ない）、欠けた値、知らない key（別の閾値の持込み）、待ちの上限が 10 s を超える値
// （技術点 2）、F1〜F7・X1〜X13 の一覧の違い、版の食い違い、契約の bytes の違い。
//
// 読んだ結果は深く凍結し、module の WeakSet に入れる（admission・outcome と同じ
// 束縛）。receipt の validator は、正式の run の `settings.k64` をこの loader が
// 読んだものと照合する。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GRAPH_EVAL_D_MS,
  K64_FREEZE,
  K64_R1_R4_WAIT_CEILING_MS,
  K64_T_LATE_MS,
  K64_T_SHOW_MS,
  K64_W_F_MS,
  rejectOverrides,
} from "./constants.mjs";

export const PROCEDURE_SCHEMA = "nir1-cp4-k64-procedure/1";
export const PROCEDURE_DIR = "scripts/quality/nir1-graph-eval/procedure";
export const PROCEDURE_VERSION =
  /^(?:v[1-9][0-9]{0,3}|draft-[1-9][0-9]{0,3})$/u;
/** The dev preview's provisional version (draft; never a formal run's). */
export const DEV_DRAFT_PROCEDURE_VERSION = "draft-1";
export const PROCEDURE_PURPOSES = Object.freeze(["formal", "dev-preview"]);
/** K6/4:137-145 and :147-161, in the contract's order. */
export const K64_FOLLOW_CONDITIONS = Object.freeze(
  Array.from({ length: 7 }, (_, at) => `F${at + 1}`),
);
export const K64_EXCLUSIONS = Object.freeze(
  Array.from({ length: 13 }, (_, at) => `X${at + 1}`),
);

const TOP_KEYS = Object.freeze([
  "schema",
  "version",
  "draft",
  "contract",
  "values",
  "conditions",
  "review",
]);
/** Each value and the contract's value it must equal (null: the wait bound). */
const CONTRACT_VALUES = Object.freeze({
  dMs: GRAPH_EVAL_D_MS,
  wFMs: K64_W_F_MS,
  tLateMs: K64_T_LATE_MS,
  tShowMs: K64_T_SHOW_MS,
  r1r4WaitMs: null,
});
const CONTRACT_KEYS = Object.freeze(["draftRef", "contractId", "sha256"]);
const REVIEW_KEYS = Object.freeze(["reviewer", "reviewedAt", "record"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function keyErrors(errors, value, keys, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object with ${keys.join(", ")}`);
    return false;
  }
  for (const key of keys)
    if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} is missing`);
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      errors.push(`${label}.${key} is not a procedure-file key`);
  return true;
}

const sameList = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((value, at) => value === right[at]);

/** The path of a version's procedure file (the version is checked). */
export function procedureFilePath(version) {
  if (typeof version !== "string" || !PROCEDURE_VERSION.test(version))
    throw new Error(
      `[precheck] a procedure version is v<N> or draft-<N>: ${String(version)}`,
    );
  return `${PROCEDURE_DIR}/k64-procedure.${version}.json`;
}

/**
 * The errors of a parsed procedure file read for `version` (pure). An empty
 * list means the file fixes the contract's values and nothing else.
 */
export function procedureFileErrors(value, { version }) {
  const errors = [];
  if (!keyErrors(errors, value, TOP_KEYS, "procedure")) return errors;
  if (value.schema !== PROCEDURE_SCHEMA)
    errors.push(`schema must be ${PROCEDURE_SCHEMA}`);
  if (
    typeof value.version !== "string" ||
    !PROCEDURE_VERSION.test(value.version) ||
    value.version !== version
  )
    errors.push(
      `version must be the requested version ${version} (the file name's)`,
    );
  const draftVersion = String(value.version).startsWith("draft-");
  if (typeof value.draft !== "boolean" || value.draft !== draftVersion)
    errors.push(
      "draft must be true for a draft-<N> version and false for v<N>",
    );
  if (keyErrors(errors, value.contract, CONTRACT_KEYS, "contract"))
    for (const key of CONTRACT_KEYS)
      if (value.contract[key] !== K64_FREEZE[key])
        errors.push(`contract.${key} must be K6/4's ${K64_FREEZE[key]}`);
  if (keyErrors(errors, value.values, Object.keys(CONTRACT_VALUES), "values")) {
    for (const [key, expected] of Object.entries(CONTRACT_VALUES)) {
      if (!Object.hasOwn(value.values, key)) continue;
      const actual = value.values[key];
      if (expected === null) {
        if (
          !Number.isInteger(actual) ||
          actual <= 0 ||
          actual > K64_R1_R4_WAIT_CEILING_MS
        )
          errors.push(
            `values.${key} must be a positive integer of at most ${K64_R1_R4_WAIT_CEILING_MS} ms (技術点 2)`,
          );
      } else if (actual !== expected)
        errors.push(
          `values.${key} must be the contract's ${expected} (widening needs a new draftRef; narrowing after observation is not supported here)`,
        );
    }
  }
  if (
    keyErrors(errors, value.conditions, ["follow", "exclusions"], "conditions")
  ) {
    if (!sameList(value.conditions.follow, K64_FOLLOW_CONDITIONS))
      errors.push(
        `conditions.follow must be ${K64_FOLLOW_CONDITIONS.join(",")}`,
      );
    if (!sameList(value.conditions.exclusions, K64_EXCLUSIONS))
      errors.push(`conditions.exclusions must be ${K64_EXCLUSIONS.join(",")}`);
  }
  if (value.draft === true) {
    if (value.review !== null)
      errors.push("review must be null for a draft (it is never reviewed)");
  } else if (keyErrors(errors, value.review, REVIEW_KEYS, "review")) {
    if (
      typeof value.review.reviewer !== "string" ||
      value.review.reviewer.trim().length === 0
    )
      errors.push("review.reviewer must name the independent reviewer");
    if (
      typeof value.review.reviewedAt !== "string" ||
      !ISO_DATE.test(value.review.reviewedAt)
    )
      errors.push("review.reviewedAt must be an ISO date");
    if (
      typeof value.review.record !== "string" ||
      value.review.record.trim().length === 0
    )
      errors.push("review.record must name the review record");
  }
  return errors;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const LOADED = new WeakSet();

export function isLoadedProcedure(value) {
  return value !== null && typeof value === "object" && LOADED.has(value);
}

function gitShow(root, commit, file) {
  try {
    const resolved = execFileSync(
      "git",
      ["rev-parse", "--verify", `${commit}^{commit}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!COMMIT.test(resolved)) return null;
    const bytes = execFileSync("git", ["show", `${resolved}:${file}`], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { commit: resolved, bytes };
  } catch {
    return null;
  }
}

/**
 * Reads and validates one version. `purpose` "formal" (a K6/4 Graph run)
 * needs a commit (the file is read from git, never the working tree) and a
 * non-draft version; "dev-preview" accepts a draft and the working tree.
 * Throws `[precheck]`; returns the sealed, deep-frozen procedure.
 */
export function loadProcedureFile(input) {
  rejectOverrides(input, ["root", "version", "commit", "purpose"]);
  const { root, version } = input;
  const purpose = input.purpose;
  if (!PROCEDURE_PURPOSES.includes(purpose))
    throw new Error(
      `[precheck] a procedure file is read for purpose ${PROCEDURE_PURPOSES.join(" or ")}`,
    );
  const file = procedureFilePath(version);
  const commit = input.commit ?? null;
  if (purpose === "formal" && commit === null)
    throw new Error(
      "[precheck] a formal run reads the procedure file from its commit, never the working tree",
    );
  let bytes;
  let resolved = null;
  if (commit !== null) {
    const read = gitShow(root, commit, file);
    if (read === null)
      throw new Error(
        `[precheck] the procedure file ${file} cannot be read from ${commit}`,
      );
    ({ bytes } = read);
    resolved = read.commit;
  } else {
    try {
      bytes = readFileSync(path.join(root, file));
    } catch {
      throw new Error(`[precheck] the procedure file ${file} cannot be read`);
    }
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`[precheck] the procedure file ${file} is not JSON`);
  }
  const errors = procedureFileErrors(value, { version });
  if (errors.length > 0)
    throw new Error(
      `[precheck] the procedure file ${file} is refused: ${errors.join("; ")}`,
    );
  if (purpose === "formal" && value.draft)
    throw new Error(
      `[precheck] ${file} is a draft; a formal run needs a reviewed v<N> version`,
    );
  const loaded = deepFreeze({
    path: file,
    version,
    commit: resolved,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    draft: value.draft,
    purpose,
    values: { ...value.values },
    conditions: {
      follow: [...value.conditions.follow],
      exclusions: [...value.conditions.exclusions],
    },
    review: value.review === null ? null : { ...value.review },
  });
  LOADED.add(loaded);
  return loaded;
}

/** The receipt's `settings.k64` from a loaded procedure (N17). */
export function procedureSettings(loaded) {
  if (!isLoadedProcedure(loaded))
    throw new Error(
      "[precheck] settings.k64 comes from a procedure loadProcedureFile read",
    );
  return {
    wFMs: loaded.values.wFMs,
    tLateMs: loaded.values.tLateMs,
    tShowMs: loaded.values.tShowMs,
    r1r4WaitMs: loaded.values.r1r4WaitMs,
    procedureFile: {
      path: loaded.path,
      commit: loaded.commit,
      sha256: loaded.sha256,
      version: loaded.version,
      draft: loaded.draft,
    },
  };
}
