// Tests of the CP-4 S1a evaluation build plan and its checks. Nothing here
// runs cargo or napi: the commands are replaced by a fake that writes files.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_NODE,
  DEFAULT_OUT_DIR,
  TRACKED_DECLARATIONS,
  WORKER_ARTIFACT,
  commandStatus,
  planEvalNativeBuild,
  resolveEvalOutputDir,
  runEvalNativeBuild,
  verifyEvalBuild,
} from "./eval-native-build.mjs";
import {
  BINARY_MARKERS,
  EVAL_FEATURE,
  EVAL_NAPI_EXPORTS,
} from "./native-architecture.mjs";
import { assertEvalBuildReceipt } from "../nir1-retrieval/contract.mjs";

const ROOT = "/repo";

test("the output directory must be under .artifacts and outside the grimodex-node package", () => {
  assert.equal(resolveEvalOutputDir(ROOT), path.join(ROOT, DEFAULT_OUT_DIR));
  for (const outDir of [
    "electron/native/grimodex-node",
    "electron/native/grimodex-node/eval",
    path.dirname(DEFAULT_NODE),
    ".artifacts",
    "dist",
    "/tmp/eval-build",
    ".artifacts/../electron/native/grimodex-node",
    ".artifacts/cp4/other",
    ".artifacts/eval-build",
  ]) {
    assert.throws(
      () => resolveEvalOutputDir(ROOT, outDir),
      /\[precheck\]/,
      outDir,
    );
  }
});

test("the plan builds with the evaluation feature into the output directory only", () => {
  const plan = planEvalNativeBuild({ root: ROOT, targetDir: null });
  assert.deepEqual(plan.features, [EVAL_FEATURE]);
  const [native, worker] = plan.commands;
  assert.deepEqual(native.args.slice(0, 8), [
    "--dir",
    "electron/native/grimodex-node",
    "exec",
    "napi",
    "build",
    "--release",
    "--features",
    EVAL_FEATURE,
  ]);
  // napi resolves the destination from the package directory.
  assert.equal(
    path.resolve(ROOT, "electron/native/grimodex-node", native.args.at(-1)),
    path.join(ROOT, DEFAULT_OUT_DIR),
  );
  assert.ok(native.args.includes("--js") && native.args.includes("false"));
  assert.equal(
    plan.outputs.node,
    path.join(ROOT, DEFAULT_OUT_DIR, "grimodex-node.node"),
  );
  assert.notEqual(plan.outputs.node, path.join(ROOT, DEFAULT_NODE));
  assert.notEqual(
    plan.outputs.declarations,
    path.join(ROOT, TRACKED_DECLARATIONS),
  );
  // The worker is the product worker (no test seam feature) at its fixed name.
  assert.ok(!worker.args.includes("--features"));
  assert.deepEqual(worker.args.slice(-2), ["--bin", "nir1-c-query-worker"]);
  assert.equal(
    plan.outputs.worker,
    path.join(ROOT, DEFAULT_OUT_DIR, "nir1-c-query-worker"),
  );
  assert.equal(plan.copies[0].from, path.join(ROOT, WORKER_ARTIFACT));
});

const passed = {
  exitCode: 0,
  signal: null,
  cleanup: { complete: true },
  termination: "close-and-group-exit-observed",
};

test("a command passes only when it exited 0 and its group was observed closed", () => {
  assert.equal(commandStatus(passed), "passed");
  assert.equal(commandStatus({ ...passed, exitCode: 1 }), "failed");
  assert.equal(commandStatus({ ...passed, timedOut: true }), "timed-out");
  assert.equal(
    commandStatus({ ...passed, closeObserved: false }),
    "termination-unknown",
  );
  assert.equal(commandStatus(null), "not-started");
});

const goodInspection = {
  capabilities: { nir1GraphEval: true },
  exports: [...EVAL_NAPI_EXPORTS].sort(),
};
const evalBinary = Buffer.from(
  BINARY_MARKERS.map((marker) => `${marker}\0`).join(""),
);

test("a finished build is refused when the flag, the exports, the markers or the default files are wrong", () => {
  const base = {
    inspection: goodInspection,
    binary: evalBinary,
    defaultNodeBefore: "a",
    defaultNodeAfter: "a",
    declarationsBefore: "d",
    declarationsAfter: "d",
  };
  assert.deepEqual(verifyEvalBuild(base), []);
  assert.equal(
    verifyEvalBuild({
      ...base,
      inspection: { ...goodInspection, capabilities: { nir1GraphEval: false } },
    }).length,
    1,
  );
  assert.equal(
    verifyEvalBuild({
      ...base,
      inspection: {
        ...goodInspection,
        exports: [
          ...goodInspection.exports,
          "nir1GraphEvalConfigureWorker",
        ].sort(),
      },
    }).length,
    1,
  );
  assert.equal(
    verifyEvalBuild({ ...base, binary: Buffer.from("product") }).length,
    1,
  );
  assert.match(
    verifyEvalBuild({ ...base, defaultNodeAfter: "b" }).join("\n"),
    /default \.node changed/,
  );
  assert.match(
    verifyEvalBuild({ ...base, declarationsAfter: "e" }).join("\n"),
    /index\.d\.ts changed/,
  );
});

function git(root, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=cp4@example.invalid", "-c", "user.name=cp4", ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A clean candidate: one commit, `origin/master` at it, build outputs ignored. */
async function fakeRepository() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cp4-eval-build-")),
  );
  await mkdir(path.join(root, "electron/native/grimodex-node"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".artifacts/\nsrc-tauri/target/\n*.node\n",
  );
  await writeFile(path.join(root, DEFAULT_NODE), "product node");
  await writeFile(
    path.join(root, TRACKED_DECLARATIONS),
    "export class Backend {}\n",
  );
  await writeFile(path.join(root, "source.rs"), "fn main() {}\n");
  git(root, "init", "-q");
  git(root, "add", ".gitignore", TRACKED_DECLARATIONS, "source.rs");
  git(root, "commit", "-q", "-m", "candidate");
  git(root, "update-ref", "refs/remotes/origin/master", "HEAD");
  return root;
}

function fakeRun(root, { touchDefault = false, touchSource = false } = {}) {
  return async (entry, options) => {
    assert.equal(options.root, root);
    if (entry.args.includes("napi")) {
      const out = path.resolve(
        root,
        "electron/native/grimodex-node",
        entry.args.at(-1),
      );
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "grimodex-node.node"), evalBinary);
      await writeFile(
        path.join(out, "index.d.ts"),
        "export declare function nir1GraphEvalStatus(): string\n",
      );
      if (touchDefault)
        await writeFile(path.join(root, DEFAULT_NODE), evalBinary);
      if (touchSource)
        await writeFile(path.join(root, "source.rs"), "fn main() { 1; }\n");
    } else {
      await mkdir(path.join(root, path.dirname(WORKER_ARTIFACT)), {
        recursive: true,
      });
      await writeFile(path.join(root, WORKER_ARTIFACT), "worker");
    }
    return passed;
  };
}

const manifestPath = (root) =>
  path.join(root, DEFAULT_OUT_DIR, "eval-build.json");

test("the manifest of a clean candidate passes the Graph arm's receipt guard", async () => {
  const root = await fakeRepository();
  try {
    const manifest = await runEvalNativeBuild({
      targetDir: null,
      root,
      runCommand: fakeRun(root),
      inspect: () => goodInspection,
    });
    assert.equal(assertEvalBuildReceipt(manifest), manifest);
    const head = git(root, "rev-parse", "HEAD").trim();
    assert.equal(manifest.candidate.resolvedHeadSha, head);
    assert.equal(manifest.candidate.currentHeadSha, head);
    assert.equal(manifest.candidate.worktreeClean, true);
    assert.equal(manifest.sourceUnchanged, true);
    assert.deepEqual(manifest.features, [EVAL_FEATURE]);
    assert.deepEqual(manifest.capabilities, goodInspection.capabilities);
    assert.deepEqual(Object.keys(manifest.artifacts).sort(), [
      `${DEFAULT_OUT_DIR}/grimodex-node.node`,
      `${DEFAULT_OUT_DIR}/nir1-c-query-worker`,
    ]);
    assert.equal(manifest.declarations.path, `${DEFAULT_OUT_DIR}/index.d.ts`);
    assert.equal(manifest.distributed, false);
    assert.deepEqual(
      manifest.commands.map((command) => command.status),
      ["passed", "passed"],
    );
    assert.equal(
      await readFile(path.join(root, DEFAULT_NODE), "utf8"),
      "product node",
    );
    assert.deepEqual(
      JSON.parse(await readFile(manifestPath(root), "utf8")),
      manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dirty candidate, a source change during the build, a default .node write or a failed command leaves no manifest", async () => {
  const root = await fakeRepository();
  const run = (runCommand) =>
    runEvalNativeBuild({
      targetDir: null,
      root,
      runCommand,
      inspect: () => goodInspection,
    });
  try {
    // A manifest of an earlier success is removed before anything runs.
    await run(fakeRun(root));
    await writeFile(path.join(root, "untracked.txt"), "x");
    await assert.rejects(run(fakeRun(root)), /clean candidate worktree/);
    await assert.rejects(readFile(manifestPath(root)));
    await rm(path.join(root, "untracked.txt"));
    await assert.rejects(
      run(fakeRun(root, { touchSource: true })),
      /candidate changed during the evaluation build/,
    );
    await assert.rejects(readFile(manifestPath(root)));
    git(root, "checkout", "--", "source.rs");
    await assert.rejects(
      run(fakeRun(root, { touchDefault: true })),
      /default \.node changed/,
    );
    await assert.rejects(readFile(manifestPath(root)));
    await assert.rejects(
      run(async () => ({ ...passed, exitCode: 101 })),
      /eval-native build failed/,
    );
    await assert.rejects(readFile(manifestPath(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the worker is copied from CARGO_TARGET_DIR when it is set", () => {
  const plan = planEvalNativeBuild({
    root: ROOT,
    targetDir: "electron/native/grimodex-node/target",
  });
  assert.equal(
    plan.copies[0].from,
    path.join(
      ROOT,
      "electron/native/grimodex-node/target/release",
      path.basename(WORKER_ARTIFACT),
    ),
  );
  assert.equal(
    planEvalNativeBuild({ root: ROOT, targetDir: "/abs/target" }).copies[0]
      .from,
    path.join("/abs/target/release", path.basename(WORKER_ARTIFACT)),
  );
});
