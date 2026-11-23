// build 物の出所の照合の試験（F2 の R2）。fake の dir・合成の file・fake の git だけを使う（build・git の変更・Electron は不要）。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILD_ARTIFACTS,
  BUILD_SOURCE_PATHS,
  GUARD_FILES,
  MTIME_EXEMPT_INPUT,
  assertBuildProvenance,
  buildProvenanceRecord,
  collectBuildState,
  findProvenanceProblems,
  inputsNewerThanBuild,
  provenanceForRecord,
  readProvenanceRecord,
  sha256File,
} from "./build-provenance.mjs";
import {
  parseRecordArgs,
  recordBuildProvenance,
} from "./record-build-provenance.mjs";
import { assertOutputClean, findUnsafeStrings } from "./lib.mjs";
import { runCell, sameBuildProvenance } from "./launcher-common.mjs";
import { assessEgressObservation } from "./measure-b-core.mjs";
import { realCellStatus } from "./run-measure-b.mjs";

const HEAD = "1".repeat(40);
const COMMIT_SEC = 1_700_000_000;

/** build の入力（追跡している file）の合成。root に作る（makeRoot）。 */
const EXEMPT = "electron/native/grimodex-node/index.d.ts";
const INPUT_FILES = ["src/a.ts", "electron/b.ts", "src-tauri/c.rs", EXEMPT];
const BLOB = "a".repeat(40);

function fakeGit({
  head = HEAD,
  commitSec = COMMIT_SEC,
  // build の入力に触れた最後の commit の時刻（git log -1 --first-parent HEAD -- <入力>）。既定は HEAD と同じ。
  inputsCommitSec = commitSec,
  dirty = [],
  inputs = INPUT_FILES,
  // 例外の path（index.d.ts）の blob：HEAD の blob と作業 tree の内容の blob。違えば dirty（内容が HEAD と違う）。
  headBlob = BLOB,
  workBlob = BLOB,
} = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && String(args.at(-1)).startsWith("HEAD:")) {
      if (headBlob === null) throw new Error("not in HEAD");
      return `${headBlob}\n`;
    }
    if (args[0] === "hash-object") return `${workBlob}\n`;
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "log")
      return `${args.includes("--") ? inputsCommitSec : commitSec}\n`;
    if (args[0] === "status") return dirty.map((d) => ` M ${d}`).join("\n");
    if (args[0] === "ls-files") return inputs.map((f) => `${f}\0`).join("");
    throw new Error(`unexpected git ${args[0]}`);
  };
  git.calls = calls;
  return git;
}

/** build 物を合成した root。mtime は HEAD の commit より後（既定）。 */
function makeRoot({ mtimeSec = COMMIT_SEC + 100 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "idl-prov-"));
  // 追跡している入力（build より古い mtime）と、測定の process の中で動く guard の file。
  for (const relative of [...INPUT_FILES, ...GUARD_FILES]) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `synthetic ${relative}`);
    utimesSync(file, COMMIT_SEC + 50, COMMIT_SEC + 50);
  }
  for (const [i, relative] of BUILD_ARTIFACTS.entries()) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `synthetic build artifact ${i}`);
    utimesSync(file, mtimeSec, mtimeSec);
  }
  return root;
}
const touch = (root, relative, mtimeSec) =>
  utimesSync(path.join(root, relative), mtimeSec, mtimeSec);

function withRoot(fn, options) {
  const root = makeRoot(options);
  const finish = () => rmSync(root, { recursive: true, force: true });
  return Promise.resolve(fn(root)).finally(finish);
}

const recordNow = (root, git = fakeGit()) =>
  recordBuildProvenance({
    root,
    recordPath: path.join(root, "provenance.json"),
    state: collectBuildState({ root, git }),
    now: new Date(COMMIT_SEC * 1000 + 200_000),
  });
const NOW_MS = COMMIT_SEC * 1000 + 300_000;
const check = (root, git = fakeGit(), extra = {}) =>
  assertBuildProvenance({
    root,
    recordPath: path.join(root, "provenance.json"),
    git,
    nowMs: NOW_MS,
    ...extra,
  });

test("sha256File は分割して読んでも一括の sha256 と同じ（8 MB の境界をまたぐ file でも）", async () => {
  await withRoot((root) => {
    const file = path.join(root, "big.bin");
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 123, 7);
    writeFileSync(file, bytes);
    assert.equal(
      sha256File(file),
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
});

test("build の直後の記録：HEAD・build 物の sha256・source が clean・時刻を残し、照合は通る", async () => {
  await withRoot((root) => {
    const git = fakeGit();
    const { record } = recordNow(root, git);
    assert.equal(record.head, HEAD);
    assert.equal(record.sourceDirtyFileCount, 0);
    assert.deepEqual(record.sourcePaths, [...BUILD_SOURCE_PATHS]);
    assert.deepEqual(
      record.files.map((f) => f.path),
      [...BUILD_ARTIFACTS],
    );
    for (const f of record.files)
      assert.equal(
        f.sha256,
        createHash("sha256")
          .update(readFileSync(path.join(root, f.path)))
          .digest("hex"),
      );
    assert.equal(new Date(record.recordedAt).toISOString(), record.recordedAt);
    // 記録は 0600。
    assert.equal(
      statSync(path.join(root, "provenance.json")).mode & 0o777,
      0o600,
    );
    // git に聞くのは読み取りだけ（rev-parse・log・status）。build の入力の path に限って status を見る。
    assert.deepEqual([...new Set(git.calls.map((c) => c[0]))].sort(), [
      "log",
      "ls-files",
      "rev-parse",
      "status",
    ]);
    // 追跡 file の一覧は -z（非 ASCII の path が quote されない形）で、build の入力の path に限る。
    const listed = git.calls.find((c) => c[0] === "ls-files");
    assert.deepEqual(listed.slice(0, 2), ["ls-files", "-z"]);
    assert.deepEqual(listed.slice(-BUILD_SOURCE_PATHS.length), [
      ...BUILD_SOURCE_PATHS,
    ]);
    assert.deepEqual(
      git.calls
        .find((c) => c[0] === "status")
        .slice(-BUILD_SOURCE_PATHS.length),
      [...BUILD_SOURCE_PATHS],
    );
    // 照合が通れば、cell の records に残す形（HEAD・時刻・path と sha256）を返す。
    const summary = check(root);
    assert.equal(summary.head, HEAD);
    assert.equal(summary.recordedAt, record.recordedAt);
    assert.deepEqual(
      summary.files,
      record.files.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
    );
    // 測定の process の中で動く guard の file の sha256 も残す（F3a の m5）。
    assert.deepEqual(
      record.guardFiles.map((f) => f.path),
      [...GUARD_FILES],
    );
    assert.deepEqual(
      summary.guardFiles,
      record.guardFiles.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
    );
    // その形は出力の検査を通る（HEAD・64 桁の hash・path・日時）。
    assert.deepEqual(findUnsafeStrings(summary), []);
    assertOutputClean({ buildProvenance: summary }, ["彼は静かに歩いた。"]);
  });
});

test("照合：記録が無い・読めない・形が違うなら止まる", async () => {
  await withRoot((root) => {
    assert.throws(() => check(root), /BUILD_PROVENANCE_MISSING/u);
    const recordPath = path.join(root, "provenance.json");
    writeFileSync(recordPath, "{not json");
    assert.throws(() => check(root), /BUILD_PROVENANCE_MISSING/u);
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: "other/1" }));
    assert.equal(readProvenanceRecord(recordPath), null);
    assert.throws(() => check(root), /BUILD_PROVENANCE_MISSING/u);
    // 必須の欄が欠けた記録（HEAD が短い）。
    recordNow(root);
    const good = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...good, head: "abc" }));
    assert.throws(() => check(root), /BUILD_PROVENANCE_MISSING/u);
  });
});

test("照合：HEAD が違う（記録の後に commit が進んだ）なら止まる", async () => {
  await withRoot((root) => {
    recordNow(root);
    assert.throws(
      () => check(root, fakeGit({ head: "2".repeat(40) })),
      /BUILD_PROVENANCE_HEAD_DIFFERS/u,
    );
  });
});

test("照合：build 物が差し替わった（sha256 が違う）なら止まる。native でも main でも", async () => {
  for (const relative of BUILD_ARTIFACTS) {
    await withRoot((root) => {
      recordNow(root);
      writeFileSync(path.join(root, relative), "rebuilt after the record");
      touch(root, relative, COMMIT_SEC + 150);
      assert.throws(() => check(root), /BUILD_PROVENANCE_HASH_DIFFERS/u);
    });
  }
});

test("照合：build の入力の source が dirty なら止まる（今の dirty も、記録の時点の dirty も）", async () => {
  await withRoot((root) => {
    recordNow(root);
    assert.throws(
      () => check(root, fakeGit({ dirty: ["src/a.ts"] })),
      /BUILD_PROVENANCE_SOURCE_DIRTY/u,
    );
    // 記録の時点で dirty だった build は、あとで clean になっても通さない。
    const recordPath = path.join(root, "provenance.json");
    const good = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(
      recordPath,
      JSON.stringify({ ...good, sourceDirtyFileCount: 2 }),
    );
    assert.throws(
      () => check(root),
      /BUILD_PROVENANCE_SOURCE_DIRTY_AT_RECORD/u,
    );
  });
});

test("照合：build 物の過不足（記録に無い・記録にあるのに無い）は不一致として止まる", async () => {
  await withRoot((root) => {
    recordNow(root);
    const recordPath = path.join(root, "provenance.json");
    const good = JSON.parse(readFileSync(recordPath, "utf8"));
    // 記録に 1 つ足りない。
    writeFileSync(
      recordPath,
      JSON.stringify({ ...good, files: good.files.slice(1) }),
    );
    assert.throws(() => check(root), /BUILD_PROVENANCE_FILE_SET_DIFFERS/u);
    // 記録に余計な file がある。
    writeFileSync(
      recordPath,
      JSON.stringify({
        ...good,
        files: [
          ...good.files,
          { path: "dist-electron/other.cjs", sha256: "0".repeat(64) },
        ],
      }),
    );
    assert.throws(() => check(root), /BUILD_PROVENANCE_FILE_SET_DIFFERS/u);
    // 照合の時に build 物が無い（build し直しで消えた）。
    writeFileSync(recordPath, JSON.stringify(good));
    rmSync(path.join(root, BUILD_ARTIFACTS[0]));
    assert.throws(() => check(root), /BUILD_PROVENANCE_ARTIFACT_MISSING/u);
  });
});

test("照合：build 物が、build の入力に触れた最後の commit より古い（dirty で build して commit した）なら止まる", async () => {
  await withRoot((root) => {
    recordNow(root);
    touch(root, BUILD_ARTIFACTS[1], COMMIT_SEC - 5);
    const problems = (() => {
      try {
        check(root);
        return "";
      } catch (error) {
        return String(error.message);
      }
    })();
    assert.match(problems, /BUILD_PROVENANCE_BUILD_OLDER_THAN_INPUT_COMMIT/u);
  });
});

test("照合：記録の時刻が未来なら止まる。複数の問題は件数と一覧を示す", async () => {
  await withRoot((root) => {
    recordNow(root);
    const recordPath = path.join(root, "provenance.json");
    const good = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(
      recordPath,
      JSON.stringify({ ...good, recordedAt: "2099-01-01T00:00:00.000Z" }),
    );
    assert.throws(() => check(root), /BUILD_PROVENANCE_RECORD_TIME_INVALID/u);
    const state = collectBuildState({
      root,
      git: fakeGit({ head: "2".repeat(40), dirty: ["src/x"] }),
    });
    assert.deepEqual(findProvenanceProblems(good, state, { nowMs: NOW_MS }), [
      "HEAD_DIFFERS",
      "SOURCE_DIRTY",
    ]);
    assert.throws(
      () =>
        check(root, fakeGit({ head: "2".repeat(40), dirty: ["src/x"] }), {}),
      /3 problems: HEAD_DIFFERS,SOURCE_DIRTY,RECORD_TIME_INVALID/u,
    );
  });
});

test("記録の script：source が dirty か、build 物が HEAD の commit より古ければ、何も書かずに止まる", async () => {
  await withRoot((root) => {
    const recordPath = path.join(root, "provenance.json");
    assert.throws(
      () =>
        recordBuildProvenance({
          root,
          recordPath,
          state: collectBuildState({
            root,
            git: fakeGit({ dirty: ["electron/a.ts"] }),
          }),
        }),
      /BUILD_PROVENANCE_SOURCE_DIRTY/u,
    );
    assert.equal(readProvenanceRecord(recordPath), null);
    touch(root, BUILD_ARTIFACTS[0], COMMIT_SEC - 1);
    assert.throws(
      () => buildProvenanceRecord(collectBuildState({ root, git: fakeGit() })),
      /BUILD_PROVENANCE_BUILD_OLDER_THAN_INPUT_COMMIT/u,
    );
    assert.equal(readProvenanceRecord(recordPath), null);
  });
  // build 物が無ければ、記録を作らない。
  const empty = mkdtempSync(path.join(os.tmpdir(), "idl-prov-empty-"));
  try {
    assert.throws(
      () => collectBuildState({ root: empty, git: fakeGit() }),
      /BUILD_PROVENANCE_ARTIFACT_MISSING/u,
    );
    // HEAD が commit の形でなければ止める。
    assert.throws(
      () => collectBuildState({ root: empty, git: fakeGit({ head: "main" }) }),
      /BUILD_PROVENANCE_HEAD_UNREADABLE/u,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.deepEqual(parseRecordArgs([]), { record: "" });
  assert.deepEqual(parseRecordArgs(["--record", "/tmp/x.json"]), {
    record: "/tmp/x.json",
  });
  assert.throws(() => parseRecordArgs(["--record"]), /USAGE/u);
  assert.throws(() => parseRecordArgs(["--other", "x"]), /USAGE/u);
});

test("迂回（F3a の M3）：build の後に入力を書き換える（dirty で build して checkout で戻す・別の commit へ移る）と、記録も照合も止まる", async () => {
  await withRoot((root) => {
    recordNow(root);
    // checkout・revert は書き換えた file の mtime を新しくする。git status は clean のままでも、build 物より新しい入力として止める。
    touch(root, INPUT_FILES[1], COMMIT_SEC + 500);
    assert.throws(
      () => check(root),
      /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
    );
    // 記録の script も同じ理由で何も書かずに止まる。
    const recordPath = path.join(root, "again.json");
    assert.throws(
      () =>
        recordBuildProvenance({
          root,
          recordPath,
          state: collectBuildState({ root, git: fakeGit() }),
        }),
      /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
    );
    assert.equal(readProvenanceRecord(recordPath), null);
    // build 物と同時刻（以下）なら通る。build し直した後は新しい。
    touch(root, INPUT_FILES[1], COMMIT_SEC + 100);
    assert.doesNotThrow(() => check(root));
    // 一番古い build 物を基準にする（1 つでも入力より古ければ止める）。
    touch(root, BUILD_ARTIFACTS[2], COMMIT_SEC + 60);
    touch(root, INPUT_FILES[0], COMMIT_SEC + 70);
    assert.throws(() => check(root), /INPUT_NEWER_THAN_BUILD/u);
    // 追跡 file の一覧が空・どれも読めないなら、何も確かめていないので止める。
    assert.throws(
      () => collectBuildState({ root, git: fakeGit({ inputs: [] }) }),
      /BUILD_PROVENANCE_INPUTS_UNREADABLE/u,
    );
    assert.throws(
      () =>
        collectBuildState({
          root,
          git: fakeGit({ inputs: ["src/missing.ts"] }),
        }),
      /BUILD_PROVENANCE_INPUTS_UNREADABLE/u,
    );
  });
});

/** 例外の path（napi が build の後に書く index.d.ts）だけの規則（F4）。 */
const problemsOf = (root, git, extra = {}) => {
  const record = JSON.parse(
    readFileSync(path.join(root, "provenance.json"), "utf8"),
  );
  return findProvenanceProblems(record, collectBuildState({ root, git }), {
    nowMs: NOW_MS,
    ...extra,
  });
};
const NEWER = COMMIT_SEC + 103; // build 物（COMMIT_SEC + 100）の約 3 秒後。napi が型宣言を書く時刻の形。

test("F4(a)：index.d.ts だけが build 物より新しく、HEAD と同一なら通る。外したことを記録と cell の records に残す", async () => {
  await withRoot((root) => {
    // 先に、例外の path が build 物より古ければ外す必要がない（記録は空、blob も問い合わせない）。
    const quiet = fakeGit();
    const { record: plain } = recordNow(root, quiet);
    assert.deepEqual(plain.exemptedInputs, []);
    assert.ok(!quiet.calls.some((c) => c[0] === "hash-object"));
    touch(root, EXEMPT, NEWER);
    const git = fakeGit();
    const { record } = recordNow(root, git);
    assert.deepEqual(record.exemptedInputs, [
      { path: EXEMPT, cleanAtHead: true },
    ]);
    assert.equal(record.exemptedInputs[0].path, MTIME_EXEMPT_INPUT);
    // 確かめたのは HEAD の blob と作業 tree の blob の比較だけ（読み取り。その 1 path だけ）。
    assert.deepEqual(
      git.calls.filter((c) => c[0] === "hash-object"),
      [["hash-object", "--", EXEMPT]],
    );
    assert.deepEqual(
      git.calls.filter((c) => c[0] === "rev-parse" && c[1] !== "HEAD"),
      [["rev-parse", "--verify", `HEAD:${EXEMPT}`]],
    );
    // 照合（launcher の検査）も通り、cell の records に path と clean を残す。それは出力の検査を通る。
    const summary = check(root);
    assert.deepEqual(summary.exemptedInputs, [
      { path: EXEMPT, cleanAtHead: true },
    ]);
    const forRecord = provenanceForRecord(summary);
    assert.deepEqual(forRecord.exemptedInputs, summary.exemptedInputs);
    assert.deepEqual(findUnsafeStrings(forRecord), []);
    assertOutputClean({ buildProvenance: forRecord }, ["彼は静かに歩いた。"]);
    assert.deepEqual(problemsOf(root, fakeGit()), []);
  });
});

test("F4(b)：index.d.ts が新しく、内容が HEAD と違う・HEAD に無い・dirty なら止まる（例外を使わない）", async () => {
  await withRoot((root) => {
    recordNow(root);
    touch(root, EXEMPT, NEWER);
    // 内容が HEAD の blob と違う（git status の stat cache・skip-worktree に隠れていても、blob で見る）。
    const differs = fakeGit({ workBlob: "b".repeat(40) });
    assert.throws(
      () => check(root, differs),
      /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
    );
    assert.deepEqual(problemsOf(root, differs), ["INPUT_NEWER_THAN_BUILD"]);
    // HEAD に無い（未追跡・新規）。HEAD の blob が読めない。
    assert.deepEqual(problemsOf(root, fakeGit({ headBlob: null })), [
      "INPUT_NEWER_THAN_BUILD",
    ]);
    // 空・不正な blob は一致と見なさない。
    assert.deepEqual(
      problemsOf(root, fakeGit({ headBlob: "", workBlob: "" })),
      ["INPUT_NEWER_THAN_BUILD"],
    );
    // git status が dirty と言う（通常の dirty）。SOURCE_DIRTY と mtime の両方で止まり、記録の script も何も書かない。
    const dirty = fakeGit({ dirty: [EXEMPT], workBlob: "c".repeat(40) });
    assert.deepEqual(problemsOf(root, dirty), [
      "SOURCE_DIRTY",
      "INPUT_NEWER_THAN_BUILD",
    ]);
    assert.throws(
      () =>
        recordBuildProvenance({
          root,
          recordPath: path.join(root, "x.json"),
          state: collectBuildState({ root, git: differs }),
        }),
      /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
    );
    // clean に戻れば通る。
    assert.deepEqual(problemsOf(root, fakeGit()), []);
  });
});

test("F4(c)：index.d.ts 以外の入力が新しければ止まる（index.d.ts が古くても clean でも）", async () => {
  await withRoot((root) => {
    recordNow(root);
    for (const relative of INPUT_FILES.filter((f) => f !== EXEMPT)) {
      touch(root, relative, NEWER);
      assert.throws(
        () => check(root),
        /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
        relative,
      );
      touch(root, relative, COMMIT_SEC + 50);
    }
    assert.doesNotThrow(() => check(root));
  });
});

test("F4(d)：index.d.ts と別の入力の両方が新しければ止まる。別の入力が戻れば index.d.ts だけで通る", async () => {
  await withRoot((root) => {
    recordNow(root);
    touch(root, EXEMPT, NEWER);
    touch(root, INPUT_FILES[0], NEWER);
    const git = fakeGit();
    assert.throws(
      () => check(root, git),
      /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
    );
    assert.deepEqual(problemsOf(root, git), ["INPUT_NEWER_THAN_BUILD"]);
    // 別の入力の mtime が build 物より新しいだけで十分（index.d.ts のほうがさらに新しくても、外れるのは index.d.ts だけ）。
    touch(root, EXEMPT, NEWER + 1000);
    touch(root, INPUT_FILES[0], COMMIT_SEC + 101);
    assert.deepEqual(problemsOf(root, git), ["INPUT_NEWER_THAN_BUILD"]);
    touch(root, INPUT_FILES[0], COMMIT_SEC + 50);
    assert.deepEqual(problemsOf(root, git), []);
  });
});

test("F4(e)：類似の path（別の dir の index.d.ts・末尾が同じ別名・大文字小文字・親の dir 違い）は外れない。option でも増やせない", async () => {
  const lookalikes = [
    "electron/native/other-node/index.d.ts",
    "electron/native/grimodex-node/index.d.ts.bak",
    "electron/native/grimodex-node/xindex.d.ts",
    "electron/native/grimodex-node/sub/index.d.ts",
    "electron/native/grimodex-node/Index.d.ts",
    "electron/index.d.ts",
    "src/electron/native/grimodex-node/index.d.ts",
  ];
  for (const lookalike of lookalikes) {
    await withRoot((root) => {
      const file = path.join(root, lookalike);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "synthetic lookalike");
      touch(root, lookalike, NEWER);
      // 例外の path は古い（build より前）まま、別の path だけが新しい。git は clean と答える fake。
      const git = fakeGit({ inputs: [...INPUT_FILES, lookalike] });
      recordNow(root, fakeGit());
      const problems = problemsOf(root, git);
      assert.deepEqual(problems, ["INPUT_NEWER_THAN_BUILD"], lookalike);
      // blob を問い合わせたのは例外の path だけ、のはず。類似の path では問い合わせない。
      assert.ok(
        !git.calls.some((c) => c.includes(lookalike)),
        `${lookalike} was queried as an exempt candidate`,
      );
    });
  }
  // 例外の path を増やす option は無い（渡しても無視され、定数の 1 path だけ）。
  await withRoot((root) => {
    recordNow(root);
    touch(root, INPUT_FILES[0], NEWER);
    const state = collectBuildState({
      root,
      git: fakeGit(),
      exemptPaths: [INPUT_FILES[0]],
      mtimeExemptInputs: [INPUT_FILES[0]],
    });
    assert.deepEqual(state.exemptedInputs, []);
    assert.equal(
      findProvenanceProblems(
        JSON.parse(readFileSync(path.join(root, "provenance.json"), "utf8")),
        state,
        { nowMs: NOW_MS },
      )[0],
      "INPUT_NEWER_THAN_BUILD",
    );
  });
  assert.equal(MTIME_EXEMPT_INPUT, "electron/native/grimodex-node/index.d.ts");
});

test("F4(f)：記録の exemptedInputs は例外の path 1 件の clean だけ。ほかの path・clean でない・2 件・欠落は読まない。例外だけでは何も確かめたことにならない", async () => {
  await withRoot((root) => {
    recordNow(root);
    const recordPath = path.join(root, "provenance.json");
    const good = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(good.exemptedInputs, []);
    const bad = [
      [{ path: "src/a.ts", cleanAtHead: true }],
      [{ path: EXEMPT, cleanAtHead: false }],
      [{ path: EXEMPT }],
      [
        { path: EXEMPT, cleanAtHead: true },
        { path: EXEMPT, cleanAtHead: true },
      ],
      [
        { path: EXEMPT, cleanAtHead: true },
        { path: "src/a.ts", cleanAtHead: true },
      ],
      undefined,
      "all",
    ];
    for (const exemptedInputs of bad) {
      writeFileSync(recordPath, JSON.stringify({ ...good, exemptedInputs }));
      assert.equal(readProvenanceRecord(recordPath), null);
      assert.throws(() => check(root), /BUILD_PROVENANCE_MISSING/u);
    }
    writeFileSync(
      recordPath,
      JSON.stringify({
        ...good,
        exemptedInputs: [{ path: EXEMPT, cleanAtHead: true }],
      }),
    );
    assert.notEqual(readProvenanceRecord(recordPath), null);
  });
  await withRoot((root) => {
    touch(root, EXEMPT, NEWER);
    // 追跡している入力が例外の 1 件だけ（ほかが無い・読めない）なら、確かめられたのは何も無いので止める。
    assert.throws(
      () => collectBuildState({ root, git: fakeGit({ inputs: [EXEMPT] }) }),
      /BUILD_PROVENANCE_INPUTS_UNREADABLE/u,
    );
    // 一覧に 2 回出ても（競合した index）、外すのは 1 回だけで、残りの 1 件が mtime の規則に掛かる。
    const twice = collectBuildState({
      root,
      git: fakeGit({ inputs: [EXEMPT, EXEMPT] }),
    });
    assert.equal(twice.exemptedInputs.length, 1);
    assert.equal(inputsNewerThanBuild(twice), true);
  });
});

test("guard の file（renderer・起動 script など）が記録の後に変わった・増減したら止まる（F3a の m5）", async () => {
  assert.ok(GUARD_FILES.some((f) => f.endsWith("renderer.ts")));
  assert.ok(GUARD_FILES.some((f) => f.endsWith("electron-observer-b.mjs")));
  assert.ok(GUARD_FILES.some((f) => f.endsWith("plain-text-keystore.mjs")));
  assert.ok(
    GUARD_FILES.some((f) => f.endsWith("nir1-retrieval/electron-observer.mjs")),
  );
  for (const relative of GUARD_FILES) {
    await withRoot((root) => {
      recordNow(root);
      writeFileSync(path.join(root, relative), "edited after the record");
      assert.throws(() => check(root), /BUILD_PROVENANCE_GUARD_HASH_DIFFERS/u);
    });
  }
  await withRoot((root) => {
    recordNow(root);
    const recordPath = path.join(root, "provenance.json");
    const good = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(
      recordPath,
      JSON.stringify({ ...good, guardFiles: good.guardFiles.slice(1) }),
    );
    assert.throws(
      () => check(root),
      /BUILD_PROVENANCE_GUARD_FILE_SET_DIFFERS/u,
    );
    // 旧い形（guard の欄が無い）の記録は読めない。
    const { guardFiles: _omit, ...legacy } = good;
    writeFileSync(recordPath, JSON.stringify(legacy));
    assert.throws(() => check(root), /BUILD_PROVENANCE_MISSING/u);
    // 照合の時に guard の file が無ければ止まる。
    writeFileSync(recordPath, JSON.stringify(good));
    rmSync(path.join(root, GUARD_FILES[0]));
    assert.throws(() => check(root), /BUILD_PROVENANCE_GUARD_FILE_MISSING/u);
  });
});

// ---- runCell の振る舞い（出所の照合を注入して、本物の runCell を fake の Electron で動かす） -----------------------

const PROV_A = {
  head: HEAD,
  recordedAt: "2026-11-23T00:00:00.000Z",
  files: [{ path: BUILD_ARTIFACTS[0], sha256: "a".repeat(64) }],
  guardFiles: [{ path: GUARD_FILES[0], sha256: "b".repeat(64) }],
};

/** runCell を、fake の照合・作品・Electron で動かす。launch は呼ばれた回数だけ数え、既定は例外で終わる（cell は失敗）。 */
async function runFakeCell(
  root,
  {
    provenance,
    launch,
    cellId = "A-test",
    body = async () => ({}),
    extraDeps = {},
    runOptions = {},
  },
) {
  const output = path.join(root, "out");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const events = [];
  const result = await runCell({
    ...runOptions,
    output,
    vite: { httpServer: { address: () => ({ port: 1 }) } },
    busAddress: "unix:path=/nonexistent",
    cellId,
    workKey: "any",
    body: async (ctx) => {
      events.push("body");
      return body(ctx);
    },
    deps: {
      root,
      loadWork: () => ({
        work: { scenes: [] },
        scenes: [],
        scenesTexts: [],
      }),
      productVersion: () => ({ head: HEAD }),
      assertBuildProvenance: () => {
        events.push("provenance");
        return provenance(events.filter((e) => e === "provenance").length);
      },
      launchElectron:
        launch ??
        (async () => {
          events.push("launch");
          throw new Error("launch stub");
        }),
      ...extraDeps,
    },
  });
  return { ...result, events };
}

test("runCell：cell の頭と起動の直前の 2 回照合し、起動の前に照合が揃わなければ Electron を起動しない（F3a の M3）", async () => {
  await withRoot(async (root) => {
    // 2 回とも同じ → 2 回の照合の後に、起動（launch）に進む。
    const same = await runFakeCell(root, { provenance: () => PROV_A });
    assert.deepEqual(same.events, ["provenance", "provenance", "launch"]);
    // 2 回目（起動の直前）の照合の結果が違う（cell の準備の間に build 物が差し替わった）→ 起動しない。
    const changed = await runFakeCell(root, {
      provenance: (n) =>
        n === 1
          ? PROV_A
          : {
              ...PROV_A,
              files: [{ path: BUILD_ARTIFACTS[0], sha256: "c".repeat(64) }],
            },
    });
    assert.ok(!changed.events.includes("launch"));
    assert.equal(changed.cell.status, "failed");
    assert.match(
      JSON.stringify(changed.cell.errors),
      /BUILD_PROVENANCE_CHANGED_DURING_CELL_SETUP/u,
    );
    // guard の file の sha256 が違っても同じ（renderer・起動 script が差し替わった）。
    const guardChanged = await runFakeCell(root, {
      provenance: (n) =>
        n === 1
          ? PROV_A
          : {
              ...PROV_A,
              guardFiles: [{ path: GUARD_FILES[0], sha256: "d".repeat(64) }],
            },
    });
    assert.ok(!guardChanged.events.includes("launch"));
    assert.equal(guardChanged.cell.status, "failed");
    // 最初の照合が通らなければ、2 回目にも起動にも進まない。
    const first = await runFakeCell(root, {
      provenance: () => {
        throw new Error("[precheck] BUILD_PROVENANCE_MISSING no record");
      },
    });
    assert.deepEqual(first.events, ["provenance"]);
    assert.equal(first.cell.status, "failed");
    assert.equal(first.cell.buildProvenance, undefined);
  });
});

test("runCell：cell の後にも出所を照合し、変わっていれば records に残して実測定の採否を build-unverified にする（F3a の m5）", async () => {
  const fakeApp = () => {
    let evaluated = 0;
    return {
      process: () => ({ pid: 0 }),
      evaluate: async (fn) => {
        // 拒否する層の有効の確認（要求しない cell では無いこと）は、呼出し順に数えない。
        if (String(fn).includes("idlDispatchBlock")) return false;
        evaluated++;
        if (evaluated === 1) return { names: [], rustLog: "", nodeOptions: "" };
        if (evaluated === 2) return "0.0.0";
        return [];
      },
      firstWindow: async () => ({
        waitForFunction: async () => undefined,
        evaluate: async (fn) => {
          const text = String(fn);
          if (text.includes("buildNestedWork"))
            return {
              text: { mismatched: 0 },
              folderChecks: {},
              sceneCount: 0,
              paragraphCount: 0,
              folderSceneCounts: {},
              ruby: {},
            };
          return {};
        },
      }),
      close: async () => undefined,
    };
  };
  await withRoot(async (root) => {
    const stable = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => fakeApp(),
    });
    assert.deepEqual(stable.events, [
      "provenance",
      "provenance",
      "body",
      "provenance",
    ]);
    assert.equal(stable.cell.status, "completed");
    assert.equal(stable.cell.buildProvenance.stableAfterCell, true);
    // records には guard の file の path を載せず、件数と digest だけを残す。ありふれた ASCII の語（renderer・plain・text・quality・
    // review など）を records に増やさないので、原稿の語に当たって output-withheld（以後の送信が止まる）になりにくい（F3a の m5）。
    const recorded = JSON.stringify(stable.cell.buildProvenance);
    for (const word of ["renderer", "plain", "quality", "review", "keystore"])
      assert.ok(!recorded.includes(word), word);
    assert.equal(stable.cell.buildProvenance.guardFileCount, 1);
    assert.match(stable.cell.buildProvenance.guardDigest, /^[0-9a-f]{64}$/u);
    assertOutputClean({ observed: stable.cell }, [
      "彼は text plain quality review renderer identity load を口にした。",
    ]);
    // digest は guard の file の sha256 が変われば変わる。
    assert.notEqual(
      provenanceForRecord(PROV_A).guardDigest,
      provenanceForRecord({
        ...PROV_A,
        guardFiles: [{ path: GUARD_FILES[0], sha256: "9".repeat(64) }],
      }).guardDigest,
    );
    // body に渡る宛先の観測は、呼ぶたびに同期で標本を 1 回採る（直近の tick が古くならない）。pid が無い fake では採取に失敗する
    // ので、観測は「標本 0・直近の tick は失敗」で、判定は止める側（F3a の B1）。
    const observed = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => fakeApp(),
      body: async (ctx) => ({ observation: ctx.egressObservation() }),
    });
    const observation = observed.value.observation;
    assert.equal(observation.sampleCount, 0);
    assert.equal(observation.lastTickOk, false);
    assert.notEqual(observation.ageMs, null);
    assert.equal(assessEgressObservation(observation), "EGRESS_UNOBSERVED");
    // cell の間に build 物が変わった（3 回目の照合だけ違う）。cell は completed のまま値を残し、採否が止める。
    const drifted = await runFakeCell(root, {
      provenance: (n) =>
        n < 3
          ? PROV_A
          : {
              ...PROV_A,
              files: [{ path: BUILD_ARTIFACTS[0], sha256: "e".repeat(64) }],
            },
      launch: async () => fakeApp(),
    });
    assert.equal(drifted.cell.status, "completed");
    assert.equal(drifted.cell.buildProvenance.stableAfterCell, false);
    // 照合が例外になった（記録が消えた・dirty になった）ときも不安定。
    const threw = await runFakeCell(root, {
      provenance: (n) => {
        if (n >= 3) throw new Error("[precheck] BUILD_PROVENANCE_SOURCE_DIRTY");
        return PROV_A;
      },
      launch: async () => fakeApp(),
    });
    assert.equal(threw.cell.buildProvenance.stableAfterCell, false);
    const egress = {
      policyApplied: true,
      sampleCount: 3,
      socketCountMax: 4,
      tcpSocketCountMax: 2,
      disallowedDestinations: [],
    };
    const adopt = (cell) =>
      realCellStatus(
        {
          ipc: { commandNames: [], commandCounts: {} },
          egress,
          buildProvenance: cell.buildProvenance,
        },
        null,
      );
    assert.equal(adopt(stable.cell), "ok");
    assert.equal(adopt(drifted.cell), "build-unverified");
    assert.equal(adopt(threw.cell), "build-unverified");
  });
  assert.equal(sameBuildProvenance(PROV_A, { ...PROV_A }), true);
  assert.equal(sameBuildProvenance(PROV_A, null), false);
});

// ---- F5：build し直しの条件（m-i）と、出所の対象の見直し（M-b） ---------------------------------------------------

test("F5 m-i：build の入力に触れない commit（道具だけの変更）の後は、build し直さず出所の記録だけ取り直せば通る", async () => {
  await withRoot((root) => {
    // build 物の mtime は COMMIT_SEC + 100。入力に触れた最後の commit は COMMIT_SEC（build より古い）。
    const before = fakeGit({ inputsCommitSec: COMMIT_SEC });
    recordNow(root, before);
    check(root, before);
    // 道具だけの commit：HEAD の commit 時刻は build より新しく（COMMIT_SEC + 500）、HEAD も変わる。入力の commit は同じ。
    const OTHER_HEAD = "2".repeat(40);
    const tooled = fakeGit({
      head: OTHER_HEAD,
      commitSec: COMMIT_SEC + 500,
      inputsCommitSec: COMMIT_SEC,
    });
    // 記録を取り直さなければ HEAD の不一致で止まる（記録と今の HEAD の対応は残す）。
    assert.throws(() => check(root, tooled), /BUILD_PROVENANCE_HEAD_DIFFERS/u);
    // build し直さず（build 物に触れず）、記録だけ取り直せば、記録も照合も通る。
    const { record } = recordNow(root, tooled);
    assert.equal(record.head, OTHER_HEAD);
    assert.equal(record.inputsCommitTimeSec, COMMIT_SEC);
    check(root, tooled);
  });
});

test("F5 m-i：入力に触れた最後の commit が build より新しければ止まる（記録の値だけでなく、今の git の値でも比べる）", async () => {
  await withRoot((root) => {
    const git = fakeGit({ inputsCommitSec: COMMIT_SEC });
    const { record } = recordNow(root, git);
    // 同じ HEAD で、今の git が「入力に触れた最後の commit は build より新しい」と答える（記録は古い値のまま）。
    const newer = collectBuildState({
      root,
      git: fakeGit({ inputsCommitSec: COMMIT_SEC + 200 }),
    });
    assert.ok(
      findProvenanceProblems(record, newer, { nowMs: NOW_MS }).includes(
        "BUILD_OLDER_THAN_INPUT_COMMIT",
      ),
    );
    // 記録の値が新しい場合も止まる（記録を書き換えて入力の commit 時刻を古くする迂回の逆。両方の大きい方で比べる）。
    const stale = collectBuildState({
      root,
      git: fakeGit({ inputsCommitSec: COMMIT_SEC }),
    });
    assert.ok(
      findProvenanceProblems(
        { ...record, inputsCommitTimeSec: COMMIT_SEC + 200 },
        stale,
        { nowMs: NOW_MS },
      ).includes("BUILD_OLDER_THAN_INPUT_COMMIT"),
    );
    // build し直した（build 物が入力の commit より新しい）なら通る。
    for (const relative of BUILD_ARTIFACTS)
      touch(root, relative, COMMIT_SEC + 300);
    assert.equal(
      findProvenanceProblems(
        record,
        collectBuildState({
          root,
          git: fakeGit({ inputsCommitSec: COMMIT_SEC + 200 }),
        }),
        { nowMs: NOW_MS },
      ).includes("BUILD_OLDER_THAN_INPUT_COMMIT"),
      false,
    );
  });
});

test("F5 m-i：commit 時刻は安全性の根拠にしない。入力の commit が古くても、入力の mtime が build より新しければ止まる（merge で入った入力）", async () => {
  await withRoot((root) => {
    const git = fakeGit({ inputsCommitSec: COMMIT_SEC - 1000 });
    recordNow(root, git);
    touch(root, INPUT_FILES[1], COMMIT_SEC + 500); // build 物（COMMIT_SEC + 100）より新しい
    assert.throws(
      () => check(root, git),
      /BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD/u,
    );
  });
});

test("F5 m-i：入力に触れた commit の時刻が読めなければ止まる（0 として通さない）。git には --first-parent と入力の path で聞く", async () => {
  for (const answer of ["", "0", "not-a-number"])
    assert.throws(
      () =>
        collectBuildState({
          root: "/nonexistent-root",
          git: (args) => {
            if (args[0] === "log" && args.includes("--")) return `${answer}\n`;
            return fakeGit()(args);
          },
        }),
      /BUILD_PROVENANCE_INPUTS_COMMIT_UNREADABLE/u,
      answer,
    );
  await withRoot((root) => {
    const git = fakeGit();
    collectBuildState({ root, git });
    const log = git.calls.find((c) => c[0] === "log" && c.includes("--"));
    assert.deepEqual(log.slice(0, 5), [
      "log",
      "-1",
      "--format=%ct",
      "--first-parent",
      "HEAD",
    ]);
    assert.deepEqual(log.slice(-BUILD_SOURCE_PATHS.length), [
      ...BUILD_SOURCE_PATHS,
    ]);
    // 記録の形：入力の commit 時刻を残し、旧い形（/3）の記録は読まない。
    const { record } = recordNow(
      root,
      fakeGit({ inputsCommitSec: COMMIT_SEC - 7 }),
    );
    assert.equal(record.inputsCommitTimeSec, COMMIT_SEC - 7);
    assert.equal(record.schemaVersion, "identity-load-build-provenance/4");
    const recordPath = path.join(root, "provenance.json");
    writeFileSync(
      recordPath,
      JSON.stringify({
        ...record,
        schemaVersion: "identity-load-build-provenance/3",
      }),
    );
    assert.equal(readProvenanceRecord(recordPath), null);
    const { inputsCommitTimeSec: _omitted, ...withoutInputs } = record;
    writeFileSync(recordPath, JSON.stringify(withoutInputs));
    assert.equal(readProvenanceRecord(recordPath), null);
  });
});

test("F5 M-b：build・配信の設定（vite.config.ts・tsconfig・.cargo・.npmrc）は build の入力に、vite.config.ts・tsconfig は guard の file（sha256）にも入る", () => {
  for (const relative of [
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json",
    ".cargo",
    ".npmrc",
  ])
    assert.ok(BUILD_SOURCE_PATHS.includes(relative), relative);
  for (const relative of [
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json",
  ])
    assert.ok(GUARD_FILES.includes(relative), relative);
  // Cargo.toml・Cargo.lock・esbuild の入口・patches は、入力の path（src-tauri・electron・patches）の下にある（辿った結果）。
  const root = path.resolve(import.meta.dirname, "../../..");
  for (const relative of [
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "electron/native/grimodex-node/Cargo.toml",
    "electron/native/grimodex-node/Cargo.lock",
    "electron/scripts/build.mjs",
    "electron/tsconfig.json",
    ".cargo/config.toml",
    "vite.config.ts",
    "tsconfig.json",
  ]) {
    assert.ok(
      BUILD_SOURCE_PATHS.some(
        (entry) => relative === entry || relative.startsWith(`${entry}/`),
      ),
      relative,
    );
    assert.ok(statSync(path.join(root, relative)).isFile(), relative);
  }
  // vite.config.ts と esbuild の入口が相対 path で import する file も、入力か guard の file に含まれる（辿れる範囲の機械的な確認）。
  const covered = (relative) =>
    BUILD_SOURCE_PATHS.some(
      (entry) => relative === entry || relative.startsWith(`${entry}/`),
    ) || GUARD_FILES.includes(relative);
  for (const entry of ["vite.config.ts", "electron/scripts/build.mjs"]) {
    const text = readFileSync(path.join(root, entry), "utf8");
    for (const match of text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
      const resolved = path
        .relative(root, path.resolve(root, path.dirname(entry), match[1]))
        .split(path.sep)
        .join("/");
      assert.ok(covered(resolved), `${entry} imports ${resolved}`);
    }
  }
});

test("F5 M-b：vite.config.ts を（commit 済みでも）書き換えたら、記録の sha256 と合わず止まる。dirty なら build の入力の未 commit として止まる", async () => {
  await withRoot((root) => {
    recordNow(root);
    writeFileSync(
      path.join(root, "vite.config.ts"),
      "export default { resolve: { alias: [] } };\n",
    );
    assert.throws(() => check(root), /BUILD_PROVENANCE_GUARD_HASH_DIFFERS/u);
    // dirty（git status に出る）も build の入力として止まる。
    const { record: _ } = recordNow(root);
    assert.throws(
      () => check(root, fakeGit({ dirty: ["vite.config.ts"] })),
      /BUILD_PROVENANCE_SOURCE_DIRTY/u,
    );
    const git = fakeGit({ dirty: ["vite.config.ts"] });
    collectBuildState({ root, git });
    assert.ok(
      git.calls.find((c) => c[0] === "status").includes("vite.config.ts"),
    );
    assert.ok(git.calls.find((c) => c[0] === "ls-files").includes(".cargo"));
  });
});

// ---- F5：main の env の検査（M1c）と app.close の期限（m-g） ------------------------------------------------------

/** runCell が使う面だけを持つ fake の Electron。mainEnv は main の process.env の写し、close は app.close() の挙動。 */
function fakeElectron({
  mainEnv = { names: [], rustLog: "", nodeOptions: "" },
  close = async () => undefined,
  kills = [],
} = {}) {
  let evaluated = 0;
  return {
    process: () => ({ pid: 0, kill: (signal) => kills.push(signal) }),
    evaluate: async (fn) => {
      // 拒否する層の有効の確認（要求しない cell では無いこと）は、呼出し順に数えない。
      if (String(fn).includes("idlDispatchBlock")) return false;
      evaluated++;
      if (evaluated === 1) return mainEnv;
      if (evaluated === 2) return "0.0.0";
      return [];
    },
    firstWindow: async () => ({
      waitForFunction: async () => undefined,
      evaluate: async (fn) =>
        String(fn).includes("buildNestedWork")
          ? {
              text: { mismatched: 0 },
              folderChecks: {},
              sceneCount: 0,
              paragraphCount: 0,
              folderSceneCounts: {},
              ruby: {},
            }
          : {},
    }),
    close,
  };
}

test("F5 M1c：main の process.env に key を出しうる env（debug 系・NODE_OPTIONS）があれば、body（key を使う処理）に進まず cell を止める", async () => {
  await withRoot(async (root) => {
    for (const mainEnv of [
      { names: ["PATH", "DEBUG"], rustLog: "", nodeOptions: "" },
      { names: ["ELECTRON_ENABLE_LOGGING"], rustLog: "", nodeOptions: "" },
      { names: ["RUST_LOG"], rustLog: "trace", nodeOptions: "" },
      { names: ["NODE_OPTIONS"], rustLog: "", nodeOptions: "--require /x.js" },
      {
        names: ["NODE_OPTIONS"],
        rustLog: "",
        nodeOptions: "--max-old-space-size=4096",
      },
      { names: ["GRIMODEX_AI_WIRE_LOG"], rustLog: "", nodeOptions: "" },
    ]) {
      const result = await runFakeCell(root, {
        provenance: () => PROV_A,
        launch: async () => fakeElectron({ mainEnv }),
        body: async () => {
          throw new Error("body must not run");
        },
      });
      assert.equal(result.cell.status, "failed", JSON.stringify(mainEnv));
      assert.match(
        JSON.stringify(result.cell.errors),
        /FORBIDDEN_ENV_SET/u,
        JSON.stringify(mainEnv),
      );
      assert.ok(!result.events.includes("body"), JSON.stringify(mainEnv));
    }
    // 立っていなければ（名前があっても NODE_OPTIONS が空・RUST_LOG が info）body に進む。
    const clean = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () =>
        fakeElectron({
          mainEnv: {
            names: ["PATH", "RUST_LOG", "NODE_OPTIONS"],
            rustLog: "info",
            nodeOptions: "",
          },
        }),
    });
    assert.ok(clean.events.includes("body"));
    assert.equal(clean.cell.status, "completed");
  });
});

test("F5 m-g：app.close() が返らなければ期限で諦め、Electron を SIGKILL して cell を failed にし、key の残りの検査と workRoot の削除へ進む", async () => {
  await withRoot(async (root) => {
    const kills = [];
    const started = Date.now();
    const hung = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () =>
        fakeElectron({ close: () => new Promise(() => undefined), kills }),
      extraDeps: { closeTimeoutMs: 30 },
    });
    assert.ok(Date.now() - started < 5_000, "期限で先へ進む");
    assert.deepEqual(kills, ["SIGKILL"]);
    assert.equal(hung.cell.status, "failed");
    assert.match(JSON.stringify(hung.cell.errors), /APP_CLOSE_TIMEOUT/u);
    // 後始末は進む（key の残りの検査・workRoot の削除）。
    assert.equal(hung.cell.keyCleanup.workRootRemoved, true);
    assert.equal(hung.cell.keyCleanup.keyFilesWithEntries, 0);
    // close が throw しても、返っても、kill しない・cell は completed のまま。
    for (const close of [
      async () => undefined,
      async () => {
        throw new Error("close failed");
      },
    ]) {
      const killed = [];
      const normal = await runFakeCell(root, {
        provenance: () => PROV_A,
        launch: async () => fakeElectron({ close, kills: killed }),
        extraDeps: { closeTimeoutMs: 1_000 },
      });
      assert.deepEqual(killed, []);
      assert.equal(normal.cell.status, "completed");
      assert.equal(normal.cell.keyCleanup.workRootRemoved, true);
    }
  });
});

test("runCell：失敗した cell に、落ちた段の印（failedPhase）を定型の token で残す（body の失敗は body、起動の失敗は launch、成功した cell には付けない）", async () => {
  await withRoot(async (root) => {
    // body が投げた：段は body。
    const inBody = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => fakeElectron(),
      body: async () => {
        throw new Error("page.evaluate: Execution context was destroyed");
      },
    });
    assert.equal(inBody.cell.status, "failed");
    assert.equal(inBody.cell.failedPhase, "body");
    assert.ok(!JSON.stringify(inBody.cell).includes("Execution context"));
    // 落ちたときの Electron の process の状態（数と短い token だけ）。fake は終了コード・シグナルを持たないので null。
    assert.deepEqual(inBody.cell.appProcess, {
      exitCode: null,
      signalCode: null,
      pageClosed: null,
    });
    // 起動が投げた：段は launch。
    const inLaunch = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => {
        throw new Error("launch failed");
      },
    });
    assert.equal(inLaunch.cell.status, "failed");
    assert.equal(inLaunch.cell.failedPhase, "launch");
    // 成功した cell には付けない。
    const ok = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => fakeElectron(),
    });
    assert.equal(ok.cell.status, "completed");
    assert.equal(ok.cell.failedPhase, undefined);
  });
});

test("runCell：乾いた実行（blockDispatch）の、本体の後の処理の失敗に限り、メッセージの先頭を ASCII の識別子の形に落として残す（key のある cell・他の段・他の cell には付けない）", async () => {
  await withRoot(async (root) => {
    // post-body の最初の処理（main への evaluate）が、非 ASCII を含むメッセージで落ちる fake。
    const failingElectron = ({ failIpc = true } = {}) => ({
      process: () => ({ pid: 0 }),
      evaluate: async (fn) => {
        const text = String(fn);
        if (text.includes("idlDispatchBlock")) return true;
        if (text.includes("nir1IpcTrace") && failIpc)
          throw new Error(
            "electronApplication.evaluate: Target closed \u7269\u8a9e with /tmp/x and 'quotes'",
          );
        if (text.includes("Object.keys(process.env)"))
          return { names: [], rustLog: "", nodeOptions: "" };
        if (text.includes("process.versions.electron")) return "0.0.0";
        return [];
      },
      firstWindow: async () => ({
        isClosed: () => false,
        waitForFunction: async () => undefined,
        evaluate: async (fn) =>
          String(fn).includes("buildNestedWork")
            ? {
                text: { mismatched: 0 },
                folderChecks: {},
                sceneCount: 0,
                paragraphCount: 0,
                folderSceneCounts: {},
                ruby: {},
              }
            : {},
      }),
      close: async () => undefined,
    });
    const dry = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => failingElectron(),
      runOptions: { blockDispatch: true },
    });
    assert.equal(dry.cell.status, "failed");
    assert.equal(dry.cell.failedPhase, "post-body");
    // 非 ASCII は _ に落ち、記号は識別子の形だけが残る。200 字まで。
    assert.match(dry.cell.errorHead, /^electronApplication\.evaluate: Target closed __ with \/tmp\/x and _quotes_$/u);
    assert.ok(dry.cell.errorHead.length <= 200);
    assert.equal(dry.cell.appProcess.pageClosed, false);
    // blockDispatch でない cell（測定 A・目録・本測定。key がありうる）には付けない。
    const plain = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => ({
        ...failingElectron(),
        evaluate: async (fn) => {
          const text = String(fn);
          if (text.includes("idlDispatchBlock")) return false;
          if (text.includes("nir1IpcTrace"))
            throw new Error("electronApplication.evaluate: Target closed");
          if (text.includes("Object.keys(process.env)"))
            return { names: [], rustLog: "", nodeOptions: "" };
          if (text.includes("process.versions.electron")) return "0.0.0";
          return [];
        },
      }),
    });
    assert.equal(plain.cell.status, "failed");
    assert.equal(plain.cell.failedPhase, "post-body");
    assert.equal(plain.cell.errorHead, undefined);
    // 乾いた実行でも、本体（body）の中の失敗には付けない（製品の例外に、原稿の文字列が入りうる）。
    const inBody = await runFakeCell(root, {
      provenance: () => PROV_A,
      launch: async () => failingElectron({ failIpc: false }),
      body: async () => {
        throw new Error("product said \u7269\u8a9e");
      },
      runOptions: { blockDispatch: true },
    });
    assert.equal(inBody.cell.failedPhase, "body");
    assert.equal(inBody.cell.errorHead, undefined);
  });
});
