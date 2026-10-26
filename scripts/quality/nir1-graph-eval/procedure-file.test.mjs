// K6/4 の手順のファイル（S1f）の schema・loader・validator。正式の版は一時の git
// repository に置いて読む。dev の仮の版（draft）は repository の file を読む。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  GRAPH_EVAL_D_MS,
  K64_FREEZE,
  K64_R1_R4_WAIT_CEILING_MS,
  K64_T_LATE_MS,
  K64_T_SHOW_MS,
  K64_W_F_MS,
} from "./constants.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  K64_EXCLUSIONS,
  K64_FOLLOW_CONDITIONS,
  PROCEDURE_SCHEMA,
  isLoadedProcedure,
  loadProcedureFile,
  procedureFileErrors,
  procedureFilePath,
  procedureSettings,
} from "./procedure-file.mjs";
import { REPO_ROOT } from "./test-support.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cp4",
      GIT_AUTHOR_EMAIL: "cp4@example.invalid",
      GIT_COMMITTER_NAME: "cp4",
      GIT_COMMITTER_EMAIL: "cp4@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

/** A reviewed (non-draft) procedure file of version `v1`. */
function formal(overrides = {}) {
  return {
    schema: PROCEDURE_SCHEMA,
    version: "v1",
    draft: false,
    contract: {
      draftRef: K64_FREEZE.draftRef,
      contractId: K64_FREEZE.contractId,
      sha256: K64_FREEZE.sha256,
    },
    values: {
      dMs: GRAPH_EVAL_D_MS,
      wFMs: K64_W_F_MS,
      tLateMs: K64_T_LATE_MS,
      tShowMs: K64_T_SHOW_MS,
      r1r4WaitMs: 5_000,
    },
    conditions: {
      follow: [...K64_FOLLOW_CONDITIONS],
      exclusions: [...K64_EXCLUSIONS],
    },
    review: {
      reviewer: "independent-reviewer",
      reviewedAt: "2026-10-27",
      record: "docs/plans/nir1-lane-decisions/cp4-decisions.md#S2",
    },
    ...overrides,
  };
}

const errorsOf = (value, version = value.version) =>
  procedureFileErrors(value, { version }).join(" | ");

async function repositoryWith(files) {
  const repo = await mkdtemp(path.join(tmpdir(), "cp4-procedure-"));
  git(repo, "init", "-q", "-b", "main");
  for (const [file, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(
      path.join(repo, file),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    git(repo, "add", "--", file);
  }
  git(repo, "commit", "-q", "--no-gpg-sign", "-m", "procedure");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

test("手順のファイル: 正式の版は値が constants と一致し、レビューの記録を持てば通る", () => {
  assert.deepEqual(procedureFileErrors(formal(), { version: "v1" }), []);
  assert.equal(
    procedureFilePath("v1"),
    "scripts/quality/nir1-graph-eval/procedure/k64-procedure.v1.json",
  );
  for (const bad of ["", "v0", "1", "draft", "v1/../x", "V1", "draft-0"])
    assert.throws(() => procedureFilePath(bad), /\[precheck\]/, bad);
});

test("手順のファイル: 待ちの上限は 10 s 以下の正の整数（技術点 2）", () => {
  for (const value of [10_001, 0, -1, 2_500.5, "5000", null])
    assert.match(
      errorsOf(formal({ values: { ...formal().values, r1r4WaitMs: value } })),
      /r1r4WaitMs/,
      String(value),
    );
  assert.equal(
    errorsOf(
      formal({
        values: { ...formal().values, r1r4WaitMs: K64_R1_R4_WAIT_CEILING_MS },
      }),
    ),
    "",
  );
});

test("手順のファイル: 契約の値と違う値は、広げる・狭めるを問わず拒む（変える点 16 の狭める版は未実装）", () => {
  for (const [key, value] of [
    ["wFMs", 150],
    ["wFMs", 80],
    ["tLateMs", 120],
    ["tShowMs", 2_500],
    ["dMs", 11],
  ])
    assert.match(
      errorsOf(formal({ values: { ...formal().values, [key]: value } })),
      new RegExp(key, "u"),
      `${key}=${value}`,
    );
});

test("手順のファイル: 欠けた値と知らない値（別の閾値の持込み）を拒む", () => {
  for (const key of Object.keys(formal().values)) {
    const values = { ...formal().values };
    delete values[key];
    assert.match(errorsOf(formal({ values })), new RegExp(key, "u"), key);
  }
  assert.match(
    errorsOf(formal({ values: { ...formal().values, childWindowMs: 200 } })),
    /childWindowMs/,
  );
  assert.match(errorsOf({ ...formal(), extra: true }), /extra/);
  for (const key of ["schema", "contract", "conditions", "review"]) {
    const value = formal();
    delete value[key];
    assert.match(errorsOf(value), new RegExp(key, "u"), key);
  }
});

test("手順のファイル: F1〜F7 と X1〜X13 は契約の一覧そのもの（足す・除く・並べ替えを拒む）", () => {
  const conditions = formal().conditions;
  for (const follow of [
    conditions.follow.slice(0, 6),
    [...conditions.follow, "F8"],
    [...conditions.follow].reverse(),
  ])
    assert.match(
      errorsOf(formal({ conditions: { ...conditions, follow } })),
      /conditions\.follow/,
    );
  for (const exclusions of [
    conditions.exclusions.slice(1),
    [...conditions.exclusions, "X14"],
  ])
    assert.match(
      errorsOf(formal({ conditions: { ...conditions, exclusions } })),
      /conditions\.exclusions/,
    );
});

test("手順のファイル: 版の食い違い、契約の bytes の違い、draft とレビューの組合せを拒む", () => {
  assert.match(errorsOf(formal(), "v2"), /version/);
  assert.match(errorsOf(formal({ version: "v2" }), "v1"), /version/);
  assert.match(errorsOf(formal({ schema: "x/1" })), /schema/);
  assert.match(
    errorsOf(
      formal({ contract: { ...formal().contract, sha256: "0".repeat(64) } }),
    ),
    /contract/,
  );
  // vN は draft でなく、draft-N は draft。
  assert.match(errorsOf(formal({ draft: true, review: null })), /draft/);
  assert.match(
    errorsOf(formal({ version: "draft-1", review: null }), "draft-1"),
    /draft/,
  );
  // 正式の版はレビューの記録を要し、draft はレビューを持たない。
  assert.match(errorsOf(formal({ review: null })), /review/);
  assert.match(
    errorsOf(formal({ review: { ...formal().review, reviewer: "" } })),
    /review/,
  );
  assert.match(
    errorsOf(
      formal({ version: "draft-1", draft: true, review: formal().review }),
      "draft-1",
    ),
    /review/,
  );
});

test("手順のファイル: dev の仮の版（draft）は repository にあり、dev の予告でだけ読める", () => {
  const loaded = loadProcedureFile({
    root: REPO_ROOT,
    version: DEV_DRAFT_PROCEDURE_VERSION,
    purpose: "dev-preview",
  });
  assert.equal(isLoadedProcedure(loaded), true);
  assert.equal(loaded.draft, true);
  assert.equal(loaded.commit, null);
  assert.equal(loaded.values.wFMs, K64_W_F_MS);
  assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.values));
  // 写しや書換えは読み込んだものではない。
  assert.equal(isLoadedProcedure({ ...loaded }), false);
  assert.equal(isLoadedProcedure(JSON.parse(JSON.stringify(loaded))), false);
  assert.throws(
    () =>
      loadProcedureFile({
        root: REPO_ROOT,
        version: DEV_DRAFT_PROCEDURE_VERSION,
        purpose: "formal",
      }),
    /\[precheck\].*draft|\[precheck\].*commit/,
  );
  assert.throws(
    () =>
      loadProcedureFile({
        root: REPO_ROOT,
        version: DEV_DRAFT_PROCEDURE_VERSION,
        purpose: "other",
      }),
    /purpose/,
  );
  // 閾値を option で渡すことはできない（N-9）。
  assert.throws(
    () =>
      loadProcedureFile({
        root: REPO_ROOT,
        version: DEV_DRAFT_PROCEDURE_VERSION,
        purpose: "dev-preview",
        wFMs: 200,
      }),
    /frozen/,
  );
});

test("手順のファイル: 正式の版は commit から読み、draft の版を拒み、bytes の sha256 を記録する", async () => {
  const value = formal();
  const draft = {
    ...formal({ version: "draft-2", draft: true, review: null }),
  };
  const { repo, head } = await repositoryWith({
    [procedureFilePath("v1")]: value,
    [procedureFilePath("draft-2")]: draft,
    [procedureFilePath("v3")]: formal({ version: "v1" }),
  });
  try {
    assert.throws(
      () => loadProcedureFile({ root: repo, version: "v1", purpose: "formal" }),
      /commit/,
    );
    const loaded = loadProcedureFile({
      root: repo,
      version: "v1",
      commit: "HEAD",
      purpose: "formal",
    });
    assert.equal(loaded.commit, head);
    const bytes = execFileSync(
      "git",
      ["show", `${head}:${procedureFilePath("v1")}`],
      {
        cwd: repo,
      },
    );
    assert.equal(
      loaded.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(procedureSettings(loaded), {
      wFMs: K64_W_F_MS,
      tLateMs: K64_T_LATE_MS,
      tShowMs: K64_T_SHOW_MS,
      r1r4WaitMs: 5_000,
      procedureFile: {
        path: procedureFilePath("v1"),
        commit: head,
        sha256: loaded.sha256,
        version: "v1",
        draft: false,
      },
    });
    assert.throws(
      () =>
        loadProcedureFile({
          root: repo,
          version: "draft-2",
          commit: head,
          purpose: "formal",
        }),
      /draft/,
    );
    // file 名の版と中身の版が違えば読まない。
    assert.throws(
      () =>
        loadProcedureFile({
          root: repo,
          version: "v3",
          commit: head,
          purpose: "formal",
        }),
      /version/,
    );
    assert.throws(
      () =>
        loadProcedureFile({
          root: repo,
          version: "v9",
          commit: head,
          purpose: "formal",
        }),
      /cannot be read/,
    );
    assert.throws(() => procedureSettings({ ...loaded }), /loadProcedureFile/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
