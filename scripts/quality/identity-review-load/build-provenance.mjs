// 測定が動かす build 物の出所の照合（F2 の R2）。
//
// 測定の Electron は、build 済みの main・preload・mastra-agent と native（.node）を読む。製品の source の未 commit の
// 数（productVersion）は source しか見ないので、「これらが今の HEAD の source から作られたものか」は別に確かめる。
//   1. record-build-provenance.mjs が、build の直後に「出所の記録」を書く（HEAD の sha、build 物の sha256、build の入力の
//      source が clean であること、記録の時刻）。build 自体は実行しない・変更しない。
//   2. launcher（launcher-common.mjs の runCell と run-measure-b.mjs の本測定の前検査）が、記録が無い・HEAD と違う・
//      sha256 が違う・source が dirty・build 物の過不足があれば止める（fail-closed）。
// 迂回の対策（F3a の M3）：追跡している build の入力 file の mtime の最大が build 物の mtime の最小以下であること、を記録と
// 照合の両方で要る。checkout・revert・pull は書き換えた file の mtime を新しくするので、「dirty で build し、checkout で戻して
// 記録を取る」「build の後に別の commit へ移る」を弾く。
// build し直しが要る条件（F5 の m-i）：build 物は、build の入力（BUILD_SOURCE_PATHS）に触れた最後の commit
// （git log -1 --first-parent -- <入力>）より新しいこと。入力に触れない commit（scripts/quality だけの変更など）の後は build し直さず、
// 出所の記録だけ取り直せばよい（HEAD と guard の file の sha256 は別に記録・照合する）。commit 時刻は安全性の根拠ではない
// （merge で入った入力の commit は古くても、書き換わった file の mtime が新しいので上の mtime の規則が止める）。
// 限界（open）：記録の script は「build の直後に実行された」ことを証明できない。mtime を意図して書き換えられると通る。
// 例外は 1 path だけ（F4）：napi が .node の数秒後に書く型宣言 electron/native/grimodex-node/index.d.ts は、HEAD と同一
// （tracked・内容が HEAD の blob と同じ）である間だけ mtime の規則から外す（MTIME_EXEMPT_INPUT。定数 1 つ・option で増やせない）。
// 外したときは記録（exemptedInputs）と cell の records に path と clean であったことを残す。dirty・未追跡・HEAD に無いなら従来どおり。
// 測定の process の中で動く guard の file（renderer.ts・起動 script など）は sha256 を記録・照合する（GUARD_FILES）。
// 対象外：Graph の C-query worker（src-tauri/target/release/nir1-c-query-worker）は、公開 gate が閉じている間は起動しない
// （electron/main/backend.ts）ので入れていない。gate を開けたら BUILD_ARTIFACTS に足す。
// 出力は件数・ID・hash・path だけ。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";

export const PROVENANCE_SCHEMA = "identity-load-build-provenance/4";
/** 測定の Electron が実際に読む build 物（root からの相対 path）。.map は含めない。過不足は不一致として止める。 */
export const BUILD_ARTIFACTS = Object.freeze([
  "dist-electron/main.cjs",
  "dist-electron/mastra-agent.cjs",
  "dist-electron/preload.cjs",
  "electron/native/grimodex-node/grimodex-node.node",
]);
/**
 * 測定の process の中で動く guard の file（root からの相対 path。F3a の m5）。page で動く renderer.ts（Vite が配る）と
 * その import の lib.mjs、main で動く起動 script（safeStorage の上書きと共有の observer）。build 物ではないので sha256 だけ
 * 記録・照合する（mtime の規則は掛けない）。これらを変えたら記録を取り直す。
 * 対象外（限界）：node_modules（Vite・Playwright・Electron・mastra-agent.cjs が require する）、vite-cache、
 * .env*・VITE_*（gitignore 済み）、repo の外の cargo の設定（~/.cargo/config.toml・親 dir の .cargo・RUSTFLAGS・CARGO_*）。
 */
export const GUARD_FILES = Object.freeze([
  "scripts/quality/identity-review-load/renderer.ts",
  "scripts/quality/identity-review-load/renderer.html",
  "scripts/quality/identity-review-load/lib.mjs",
  "scripts/quality/identity-review-load/electron-observer-b.mjs",
  "scripts/quality/identity-review-load/plain-text-keystore.mjs",
  "scripts/quality/identity-review-load/dispatch-block.mjs",
  "scripts/quality/nir1-retrieval/electron-observer.mjs",
  // Vite（測定の page を配る）が実行時に読む設定。resolve.alias で page の `@/…`（judgeCandidates を含む）を差し替えられるので、
  // build の入力であるだけでなく sha256 も照合する（F5 の M-b）。esbuild の変換は tsconfig を読む。
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.node.json",
]);
/**
 * build の入力の source（root からの相対 path）。renderer は Vite が source から配る（build 物ではない）が、測定が
 * 動かす製品の一部なので入れる。scripts・docs・evals は build の入力でないので含めない（道具の変更だけが dirty でも
 * 測定は進める。道具の file のうち測定の process の中で動くものは GUARD_FILES で sha256 を見る）。
 * 辿った範囲（F5 の M-b）：vite.config.ts が import するのは node 組み込みと node_modules の plugin だけ、
 * electron/scripts/build.mjs の esbuild の入口は electron の下と mastra-ee-stub-plugin.mjs（electron の下）、
 * pnpm の patches は patches の下。public（静的 file）は module の解決に効かないので対象に含めない。
 */
export const BUILD_SOURCE_PATHS = Object.freeze([
  "src",
  "electron",
  "src-tauri",
  "packages",
  "patches",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  // build・配信の設定（F5 の M-b）。vite.config.ts は page の `@/…` の alias を、tsconfig は esbuild・tsc の解決と変換を、
  // .cargo/config.toml は native の build（cargo）の env・flag を決める。Cargo.toml・Cargo.lock は src-tauri・electron の下
  // （electron/native/grimodex-node/ を含む）、esbuild の入口 electron/scripts/build.mjs・electron/tsconfig.json は electron の下で、
  // 上の path に含まれる。
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.node.json",
  ".cargo",
  ".npmrc",
]);
/**
 * build の入力のうち mtime の規則から外す唯一の path（F4）。napi が .node の約 4 秒後に書く生成物の型宣言で、実行時には読まれない。
 * 外すのは「tracked で、内容が HEAD の blob と同じ」ときだけ（collectBuildState）。完全一致の 1 path で、glob・部分一致・option で増やせない。
 */
export const MTIME_EXEMPT_INPUT = "electron/native/grimodex-node/index.d.ts";
/** 記録の既定の置き場所。dist-electron は gitignore 済み。esbuild の outfile は上書きだけで dist-electron を消さないので、build し直しても記録は残るが、build 物の sha256 が変わって不一致で止まる。 */
export const PROVENANCE_RECORD_RELATIVE =
  "dist-electron/idl-build-provenance.json";

/** git を呼ぶ関数（root で実行）。試験では fake を渡す。 */
export function defaultGit(root) {
  return (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // 追跡 file の一覧（ls-files）は大きい。既定の 1 MB では足りない。
      maxBuffer: 256 * 1024 * 1024,
    });
}

/** file の sha256（8 MB ずつ読む。native は数百 MB になる）。 */
export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * 今の状態を集める：HEAD、HEAD の commit 時刻（秒）、build の入力に触れた最後の commit の時刻（秒）、build の入力の source の未 commit の数
 * （untracked を含む。ignore 済みは含まない）、build 物の sha256・大きさ・mtime。build 物が無ければ止める。
 */
export function collectBuildState({
  root,
  git = defaultGit(root),
  artifacts = BUILD_ARTIFACTS,
  sourcePaths = BUILD_SOURCE_PATHS,
  guardPaths = GUARD_FILES,
  hashFile = sha256File,
  statFile = statSync,
}) {
  const head = git(["rev-parse", "HEAD"]).trim();
  assert.ok(
    /^[0-9a-f]{40}$/u.test(head),
    "[precheck] BUILD_PROVENANCE_HEAD_UNREADABLE git HEAD is not a commit id",
  );
  const headCommitTimeSec = Number(
    git(["log", "-1", "--format=%ct", "HEAD"]).trim(),
  );
  assert.ok(
    Number.isSafeInteger(headCommitTimeSec) && headCommitTimeSec > 0,
    "[precheck] BUILD_PROVENANCE_HEAD_UNREADABLE git commit time is not readable",
  );
  // build の入力に触れた最後の commit の時刻（秒。F5 の m-i）。--first-parent なので、merge で入った入力の変更は merge の commit の
  // 時刻になる。読めない（空・0）なら止める（0 として通さない）。
  const inputsCommitTimeSec = Number(
    git([
      "log",
      "-1",
      "--format=%ct",
      "--first-parent",
      "HEAD",
      "--",
      ...sourcePaths,
    ]).trim(),
  );
  assert.ok(
    Number.isSafeInteger(inputsCommitTimeSec) && inputsCommitTimeSec > 0,
    "[precheck] BUILD_PROVENANCE_INPUTS_COMMIT_UNREADABLE no commit time for the build input paths is readable",
  );
  const sourceDirtyFileCount = git([
    "status",
    "--porcelain",
    "--",
    ...sourcePaths,
  ])
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  const files = artifacts.map((relative) => {
    const file = path.join(root, relative);
    assert.ok(
      existsSync(file),
      `[precheck] BUILD_PROVENANCE_ARTIFACT_MISSING ${relative}`,
    );
    const info = statSync(file);
    assert.ok(
      info.isFile(),
      `[precheck] BUILD_PROVENANCE_ARTIFACT_MISSING ${relative}`,
    );
    return {
      path: relative,
      sha256: hashFile(file),
      bytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  });
  // 追跡している入力 file の mtime の最大（F3a の M3）。build の後に checkout・revert・pull で書き換えた file は mtime が新しくなるので、
  // 「dirty で build してから git checkout で戻して記録を取る」「build の後に別の commit へ移る」という迂回を、build 物より新しい入力として弾く。
  const tracked = git(["ls-files", "-z", "--", ...sourcePaths])
    .split("\0")
    .filter((line) => line !== "");
  assert.ok(
    tracked.length > 0,
    "[precheck] BUILD_PROVENANCE_INPUTS_UNREADABLE no tracked build input files were listed",
  );
  const oldestBuildMtimeMs = Math.min(...files.map((f) => f.mtimeMs));
  const exemptedInputs = [];
  let inputNewestMtimeMs = 0;
  for (const relative of tracked) {
    let mtimeMs;
    try {
      mtimeMs = statFile(path.join(root, relative)).mtimeMs;
    } catch {
      // 追跡しているが無い file は dirty（git status）として見つかる。
      continue;
    }
    // 例外（F4）：build 物より新しい MTIME_EXEMPT_INPUT が HEAD と同一のときだけ、mtime の最大から外して記録に残す。
    // 完全一致の 1 path。確かめられない・違うなら外さない（従来どおり INPUT_NEWER_THAN_BUILD または SOURCE_DIRTY で止まる）。
    if (
      relative === MTIME_EXEMPT_INPUT &&
      exemptedInputs.length === 0 &&
      mtimeMs > oldestBuildMtimeMs &&
      isCleanAtHead(git, relative)
    ) {
      exemptedInputs.push({ path: relative, cleanAtHead: true });
      continue;
    }
    inputNewestMtimeMs = Math.max(inputNewestMtimeMs, mtimeMs);
  }
  assert.ok(
    inputNewestMtimeMs > 0,
    "[precheck] BUILD_PROVENANCE_INPUTS_UNREADABLE no tracked build input file could be read",
  );
  const guardFiles = guardPaths.map((relative) => {
    const file = path.join(root, relative);
    assert.ok(
      existsSync(file),
      `[precheck] BUILD_PROVENANCE_GUARD_FILE_MISSING ${relative}`,
    );
    return {
      path: relative,
      sha256: hashFile(file),
      bytes: statFile(file).size,
    };
  });
  return {
    head,
    headCommitTimeSec,
    inputsCommitTimeSec,
    sourceDirtyFileCount,
    inputFileCount: tracked.length,
    inputNewestMtimeMs,
    exemptedInputs,
    guardFiles,
    files,
  };
}

/**
 * file の内容が HEAD の blob と同じか（tracked で、作業 tree の内容が HEAD と一致）。git status の stat cache や
 * skip-worktree・assume-unchanged に頼らず、blob の id を直接比べる。読み取りだけ（hash-object は -w なし）。
 * HEAD に無い・読めない・git が失敗するなら false（外さない側に倒す）。
 */
export function isCleanAtHead(git, relative) {
  try {
    const headBlob = git(["rev-parse", "--verify", `HEAD:${relative}`]).trim();
    const workBlob = git(["hash-object", "--", relative]).trim();
    return /^[0-9a-f]{40,64}$/u.test(headBlob) && headBlob === workBlob;
  } catch {
    return false;
  }
}

/** 追跡している入力 file の最も新しい mtime が、build 物の最も古い mtime より新しいか（build の後に入力が書き換わった）。 */
export function inputsNewerThanBuild(state) {
  // inputNewestMtimeMs は MTIME_EXEMPT_INPUT（HEAD と同一のとき）を除いた最大（collectBuildState）。
  const oldestBuild = Math.min(...state.files.map((f) => f.mtimeMs));
  return state.inputNewestMtimeMs > oldestBuild;
}

/**
 * 記録を作る（書く前の検査つき）：source が dirty なら、build 物が build の入力に触れた最後の commit より古ければ作らない。
 * dirty の build の記録は launcher が拒むので、早く止める。
 */
export function buildProvenanceRecord(state, { now = new Date() } = {}) {
  assert.equal(
    state.sourceDirtyFileCount,
    0,
    `[precheck] BUILD_PROVENANCE_SOURCE_DIRTY ${state.sourceDirtyFileCount} uncommitted build input files`,
  );
  for (const file of state.files)
    assert.ok(
      Math.floor(file.mtimeMs / 1000) >= state.inputsCommitTimeSec,
      `[precheck] BUILD_PROVENANCE_BUILD_OLDER_THAN_INPUT_COMMIT ${file.path} is older than the last commit that touched a build input. Build again`,
    );
  assert.ok(
    !inputsNewerThanBuild(state),
    "[precheck] BUILD_PROVENANCE_INPUT_NEWER_THAN_BUILD a tracked build input file is newer than a build artifact. Build again after the last checkout",
  );
  return {
    schemaVersion: PROVENANCE_SCHEMA,
    head: state.head,
    headCommitTimeSec: state.headCommitTimeSec,
    inputsCommitTimeSec: state.inputsCommitTimeSec,
    sourcePaths: [...BUILD_SOURCE_PATHS],
    sourceDirtyFileCount: 0,
    inputFileCount: state.inputFileCount,
    exemptedInputs: state.exemptedInputs.map(({ path: p, cleanAtHead }) => ({
      path: p,
      cleanAtHead,
    })),
    recordedAt: now.toISOString(),
    files: state.files.map(({ path: p, sha256, bytes }) => ({
      path: p,
      sha256,
      bytes,
    })),
    guardFiles: state.guardFiles.map(({ path: p, sha256, bytes }) => ({
      path: p,
      sha256,
      bytes,
    })),
  };
}

/** 記録の exemptedInputs：空か、MTIME_EXEMPT_INPUT 1 件（clean であったこと）だけ。ほかの path を外した記録は読まない。 */
function validExemptedInputs(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (e) => e?.path === MTIME_EXEMPT_INPUT && e.cleanAtHead === true,
    ) &&
    value.length <= 1
  );
}

/** 記録を読む。無い・読めない・形が違うなら null。 */
export function readProvenanceRecord(recordPath) {
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    if (
      record?.schemaVersion !== PROVENANCE_SCHEMA ||
      !/^[0-9a-f]{40}$/u.test(String(record.head)) ||
      !Array.isArray(record.files) ||
      !Array.isArray(record.guardFiles) ||
      !validExemptedInputs(record.exemptedInputs) ||
      !Number.isSafeInteger(record.headCommitTimeSec) ||
      !Number.isSafeInteger(record.inputsCommitTimeSec) ||
      record.inputsCommitTimeSec <= 0 ||
      !Number.isSafeInteger(record.sourceDirtyFileCount) ||
      Number.isNaN(Date.parse(record.recordedAt))
    )
      return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * 記録と今の状態を照合する。問題の code の配列（空なら一致）。
 * MISSING／FILE_SET_DIFFERS／HEAD_DIFFERS／SOURCE_DIRTY_AT_RECORD／SOURCE_DIRTY／HASH_DIFFERS／
 * BUILD_OLDER_THAN_INPUT_COMMIT／INPUT_NEWER_THAN_BUILD／GUARD_FILE_SET_DIFFERS／GUARD_HASH_DIFFERS／RECORD_TIME_INVALID
 */
export function findProvenanceProblems(
  record,
  state,
  { nowMs = Date.now() } = {},
) {
  if (!record) return ["MISSING"];
  const problems = [];
  const recorded = record.files.map((f) => f?.path);
  const expected = state.files.map((f) => f.path);
  if (
    recorded.length !== expected.length ||
    expected.some((p) => !recorded.includes(p))
  )
    problems.push("FILE_SET_DIFFERS");
  if (record.head !== state.head) problems.push("HEAD_DIFFERS");
  if (record.sourceDirtyFileCount !== 0)
    problems.push("SOURCE_DIRTY_AT_RECORD");
  if (state.sourceDirtyFileCount !== 0) problems.push("SOURCE_DIRTY");
  const byPath = new Map(record.files.map((f) => [f?.path, f]));
  if (
    state.files.some(
      (f) =>
        !/^[0-9a-f]{64}$/u.test(String(byPath.get(f.path)?.sha256)) ||
        byPath.get(f.path).sha256 !== f.sha256,
    )
  )
    problems.push("HASH_DIFFERS");
  // build 物は、build の入力に触れた最後の commit より新しいこと（記録の値と今の値の大きい方。F5 の m-i）。
  const inputsCommitTimeSec = Math.max(
    record.inputsCommitTimeSec,
    state.inputsCommitTimeSec,
  );
  if (
    state.files.some((f) => Math.floor(f.mtimeMs / 1000) < inputsCommitTimeSec)
  )
    problems.push("BUILD_OLDER_THAN_INPUT_COMMIT");
  if (inputsNewerThanBuild(state)) problems.push("INPUT_NEWER_THAN_BUILD");
  const recordedGuards = record.guardFiles.map((f) => f?.path);
  if (
    recordedGuards.length !== state.guardFiles.length ||
    state.guardFiles.some((f) => !recordedGuards.includes(f.path))
  )
    problems.push("GUARD_FILE_SET_DIFFERS");
  const guardByPath = new Map(record.guardFiles.map((f) => [f?.path, f]));
  if (
    state.guardFiles.some(
      (f) =>
        !/^[0-9a-f]{64}$/u.test(String(guardByPath.get(f.path)?.sha256)) ||
        guardByPath.get(f.path).sha256 !== f.sha256,
    )
  )
    problems.push("GUARD_HASH_DIFFERS");
  const recordedAtMs = Date.parse(record.recordedAt);
  if (recordedAtMs > nowMs + 60_000) problems.push("RECORD_TIME_INVALID");
  return problems;
}

/**
 * cell の records に残す形。guard の file は path を載せず、件数と digest（path と sha256 の対の sha256）だけにする
 * （records の ASCII の語が原稿の語に当たると output-withheld で送信が止まる。renderer・plain・text・quality など
 * ありふれた語を records に増やさない。F3a の m5）。build 物の path は F2 の時点から記録に含まれる。
 */
export function provenanceForRecord(provenance) {
  const guardFiles = provenance.guardFiles ?? [];
  return {
    head: provenance.head,
    recordedAt: provenance.recordedAt,
    files: provenance.files,
    exemptedInputs: provenance.exemptedInputs ?? [],
    guardFileCount: guardFiles.length,
    guardDigest: createHash("sha256")
      .update(
        JSON.stringify(
          guardFiles
            .map((f) => [f.path, f.sha256])
            .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        ),
      )
      .digest("hex"),
  };
}

/**
 * launcher の検査：問題があれば止める（最初の code を message に、全件数も付ける）。
 * 返り値は cell の records に残す形（HEAD・記録の時刻・build 物の path と sha256）。
 */
export function assertBuildProvenance({
  root,
  recordPath = path.join(root, PROVENANCE_RECORD_RELATIVE),
  git,
  artifacts,
  sourcePaths,
  guardPaths,
  hashFile,
  statFile,
  nowMs,
}) {
  const record = readProvenanceRecord(recordPath);
  if (!record)
    assert.fail(
      "[precheck] BUILD_PROVENANCE_MISSING no readable build provenance record. Run record-build-provenance.mjs right after the build",
    );
  const state = collectBuildState({
    root,
    ...(git ? { git } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(sourcePaths ? { sourcePaths } : {}),
    ...(guardPaths ? { guardPaths } : {}),
    ...(hashFile ? { hashFile } : {}),
    ...(statFile ? { statFile } : {}),
  });
  const problems = findProvenanceProblems(record, state, {
    ...(nowMs !== undefined ? { nowMs } : {}),
  });
  if (problems.length > 0)
    assert.fail(
      `[precheck] BUILD_PROVENANCE_${problems[0]} ${problems.length} problems: ${problems.join(",")}`,
    );
  return {
    head: state.head,
    recordedAt: record.recordedAt,
    files: state.files.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
    exemptedInputs: state.exemptedInputs.map(({ path: p, cleanAtHead }) => ({
      path: p,
      cleanAtHead,
    })),
    guardFiles: state.guardFiles.map(({ path: p, sha256 }) => ({
      path: p,
      sha256,
    })),
  };
}
