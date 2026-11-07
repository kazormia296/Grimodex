// K6/4 の手順のファイル（S1f）の schema・loader・validator。正式の版は一時の git
// repository に置いて読む。dev の仮の版（draft）は repository の file を読む。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  GRAPH_EVAL_B_MS,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_HYBRID_P95_LIMIT_MS,
  K64_FREEZE,
  K65_FREEZE,
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

/** A reviewed (non-draft) procedure file of version `v2`. */
function formal(overrides = {}) {
  return {
    schema: PROCEDURE_SCHEMA,
    version: "v2",
    draft: false,
    contract: {
      draftRef: K65_FREEZE.draftRef,
      contractId: K65_FREEZE.contractId,
      sha256: K65_FREEZE.sha256,
    },
    values: {
      dMs: GRAPH_EVAL_D_MS,
      bMs: GRAPH_EVAL_B_MS,
      hybridP95LimitMs: GRAPH_EVAL_HYBRID_P95_LIMIT_MS,
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
  assert.deepEqual(procedureFileErrors(formal(), { version: "v2" }), []);
  assert.equal(
    procedureFilePath("v2"),
    "scripts/quality/nir1-graph-eval/procedure/k64-procedure.v2.json",
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
    // K6/5-N1: K6/4 の D（10.84 ms）の手順のファイルは /5 の判定に使えない。
    ["dMs", 10.84],
    // K6/5-N4: B と Hybrid p95 の上限は契約の値だけ（P の 65.04 ms、D から
    // 逆算した 200 ms／240 ms を拒む）。
    ["bMs", 200],
    ["bMs", 10.84 / 0.2],
    ["hybridP95LimitMs", 65.04],
    ["hybridP95LimitMs", 240],
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
  assert.match(errorsOf(formal(), "v3"), /version/);
  assert.match(errorsOf(formal({ version: "v3" }), "v2"), /version/);
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
    [procedureFilePath("v2")]: value,
    [procedureFilePath("draft-2")]: draft,
    [procedureFilePath("v4")]: formal({ version: "v2" }),
  });
  try {
    assert.throws(
      () => loadProcedureFile({ root: repo, version: "v2", purpose: "formal" }),
      /commit/,
    );
    const loaded = loadProcedureFile({
      root: repo,
      version: "v2",
      commit: "HEAD",
      purpose: "formal",
    });
    assert.equal(loaded.commit, head);
    const bytes = execFileSync(
      "git",
      ["show", `${head}:${procedureFilePath("v2")}`],
      {
        cwd: repo,
      },
    );
    assert.equal(
      loaded.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(procedureSettings(loaded), {
      dMs: GRAPH_EVAL_D_MS,
      bMs: GRAPH_EVAL_B_MS,
      hybridP95LimitMs: GRAPH_EVAL_HYBRID_P95_LIMIT_MS,
      wFMs: K64_W_F_MS,
      tLateMs: K64_T_LATE_MS,
      tShowMs: K64_T_SHOW_MS,
      r1r4WaitMs: 5_000,
      procedureFile: {
        path: procedureFilePath("v2"),
        commit: head,
        sha256: loaded.sha256,
        version: "v2",
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
          version: "v4",
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

test("K6/5: 手順のファイルは /5 の契約（draftRef・SHA-256）と schema /2 を要し、K6/4 の file（schema /1）は読まない", () => {
  assert.equal(K65_FREEZE.draftRef, "nir1-final-request-eval-proposal/5");
  assert.equal(GRAPH_EVAL_D_MS, 40);
  assert.equal(GRAPH_EVAL_B_MS, 54.2);
  assert.equal(GRAPH_EVAL_HYBRID_P95_LIMIT_MS, 94.2);
  assert.equal(K64_T_LATE_MS, 100);
  // K6/5-N1: K6/4 の契約を名乗る file は拒む。
  assert.match(
    errorsOf(
      formal({
        contract: {
          draftRef: "nir1-final-request-eval-proposal/4",
          contractId: "graph-eval-procedure",
          sha256: K64_FREEZE.sha256,
        },
      }),
    ),
    /contract\.draftRef must be K6\/5's/,
  );
  assert.match(
    errorsOf(formal({ schema: "nir1-cp4-k64-procedure/1" })),
    /schema must be nir1-cp4-k64-procedure\/2/,
  );
  // v1・draft-1・draft-2 は schema /1 の履歴の file で、loader は読まない。
  for (const version of ["v1", "draft-1", "draft-2"])
    assert.throws(
      () =>
        loadProcedureFile({
          root: REPO_ROOT,
          version,
          purpose: "dev-preview",
        }),
      /schema must be nir1-cp4-k64-procedure\/2/,
      version,
    );
});

test("K6/5: レビューが placeholder の v<N> は読まない（S3 の記録の前に正式の run を始めさせない）", () => {
  for (const key of ["reviewer", "record"])
    assert.match(
      errorsOf(
        formal({
          review: { ...formal().review, [key]: "S3 待ち（placeholder）" },
        }),
      ),
      /still a placeholder/,
      key,
    );
});

test("K6/5: k64-procedure.v2.json は draft-3 と版・draft・review だけが違い、draft-3 は dev で読める", () => {
  const read = (version) =>
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, procedureFilePath(version)), "utf8"),
    );
  const draft = read("draft-3");
  const v2 = read("v2");
  assert.deepEqual(
    { ...v2, version: draft.version, draft: draft.draft, review: draft.review },
    draft,
  );
  assert.equal(draft.draft, true);
  assert.equal(v2.draft, false);
  assert.deepEqual(draft.values, {
    dMs: 40,
    bMs: 54.2,
    hybridP95LimitMs: 94.2,
    wFMs: 100,
    tLateMs: 100,
    tShowMs: 2000,
    r1r4WaitMs: 10000,
  });
  assert.equal(DEV_DRAFT_PROCEDURE_VERSION, "draft-3");
  assert.deepEqual(procedureFileErrors(draft, { version: "draft-3" }), []);
  // v2 の review は S3 の記録まで placeholder で、loader が拒む。
  assert.match(
    procedureFileErrors(v2, { version: "v2" }).join(" | "),
    /still a placeholder/,
  );
});
