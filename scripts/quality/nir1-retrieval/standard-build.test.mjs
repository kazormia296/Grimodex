import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  produceStandardBuildReceipt,
  produceStandardBuildFixtureReceipt,
} from "./standard-build.mjs";
import { runLocalCiCommand } from "../../local-ci-process-supervisor.mjs";
import { runNir1Retrieval } from "../run-nir1-retrieval.mjs";

const ARTIFACTS = [
  "dist/index.html",
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "electron/native/grimodex-node/grimodex-node.node",
];
const COMMANDS = [
  ["pnpm", "napi:build"],
  ["pnpm", "electron:build"],
];

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nir1-standard-build-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  execFileSync("git", ["init", "-q", root]);
  git(root, ["config", "user.name", "Build Receipt Fixture"]);
  git(root, ["config", "user.email", "build-fixture@example.invalid"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, ".gitignore"),
    ".artifacts/\ndist/\ndist-electron/\nelectron/native/grimodex-node/grimodex-node.node\n",
  );
  await writeFile(path.join(root, "src/source.txt"), "fixture source\n");
  git(root, ["add", ".gitignore", "src/source.txt"]);
  git(root, ["commit", "-m", "fixture base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/master", base]);
  return { root, base };
}

function fixtureBuildSource(
  index,
  { fail = false, groupSurvivor = false, marker = "" } = {},
) {
  if (groupSurvivor) {
    return [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));`,
      "process.exit(0);",
    ].join("");
  }
  const selected = index === 0 ? [ARTIFACTS[3]] : ARTIFACTS.slice(0, 3);
  const files = Object.fromEntries(
    selected
      .filter(
        (file) =>
          !(index === 1 && marker === "omit-renderer" && file === ARTIFACTS[0]),
      )
      .map((file) => [file, `fixture artifact ${index}: ${file}\n`]),
  );
  return [
    "const fs=require('node:fs');const path=require('node:path');",
    `for(const [file,contents] of Object.entries(${JSON.stringify(files)})){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contents);}`,
    fail ? "process.exitCode=23;" : "",
    "setInterval(()=>{},1000).unref();",
  ].join("");
}

function fixtureRunner(root, options = {}) {
  const calls = [];
  const run = async (entry, commandOptions) => {
    const index = calls.length;
    calls.push(entry);
    assert.deepEqual([entry.command, ...entry.args], COMMANDS[index]);
    const source =
      options.source?.(index) ??
      fixtureBuildSource(index, {
        fail: options.failAt === index,
        groupSurvivor: options.groupSurvivorAt === index,
        marker: options.marker,
      });
    const result = await runLocalCiCommand(
      { command: process.execPath, args: ["-e", source], cwd: ".", env: {} },
      {
        ...commandOptions,
        root,
        timeoutMs: options.timeoutMs ?? commandOptions.timeoutMs,
        termGraceMs: options.termGraceMs ?? 60,
        killGraceMs: options.killGraceMs ?? 250,
        closeGraceMs: options.closeGraceMs ?? 120,
        spawnProcess: options.spawnProcess,
      },
    );
    await options.afterCommand?.(index, root);
    return result;
  };
  run.calls = calls;
  return run;
}

function receiptPath(root, name = "standard-build.json") {
  return path.join(root, ".artifacts", name);
}

async function runFailure(options, message) {
  await assert.rejects(produceStandardBuildFixtureReceipt(options), (error) => {
    if (message) assert.match(error.message, message);
    return true;
  });
  return JSON.parse(await readFile(options.receiptPath, "utf8"));
}

test("clean fixture records commands but never qualifies as standard-build evidence", async (t) => {
  const { root, base } = await fixture(t);
  const output = receiptPath(root);
  const result = await produceStandardBuildFixtureReceipt({
    root,
    receiptPath: output,
    runCommand: fixtureRunner(root),
  });
  const receipt = JSON.parse(await readFile(output, "utf8"));

  assert.equal(receipt.status, "passed");
  assert.equal(receipt.root, root);
  assert.equal(receipt.standardBuild, false);
  assert.equal(receipt.schemaVersion, "nir1-standard-build-fixture/1");
  assert.equal(receipt.sourceUnchanged, true);
  assert.deepEqual(receipt.candidate, {
    requestedBase: "refs/remotes/origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: base,
    resolvedHeadSha: base,
    resolvedHeadTreeSha: git(root, ["rev-parse", "HEAD^{tree}"]),
    currentHeadSha: base,
    worktreeClean: true,
  });
  assert.deepEqual(
    receipt.commands.map(({ argv, exitCode }) => ({ argv, exitCode })),
    [
      { argv: ["pnpm", "napi:build"], exitCode: 0 },
      { argv: ["pnpm", "electron:build"], exitCode: 0 },
    ],
  );
  assert.ok(
    receipt.commands.every(
      (command) =>
        command.status === "passed" &&
        command.closeObserved === true &&
        command.cleanup.complete === true &&
        command.termination === "close-and-group-exit-observed",
    ),
  );
  assert.equal(result.receiptPath, output);
  assert.equal(path.isAbsolute(receipt.sourceManifest), true);
  const manifestBytes = await readFile(receipt.sourceManifest);
  assert.equal(
    createHash("sha256").update(manifestBytes).digest("hex"),
    receipt.sourceManifestSha256,
  );
  assert.deepEqual(Object.keys(JSON.parse(manifestBytes.toString("utf8"))), [
    ".gitignore",
    "src/source.txt",
  ]);
  assert.deepEqual(Object.keys(receipt.artifacts), ARTIFACTS);
  for (const file of ARTIFACTS) {
    const bytes = await readFile(path.join(root, file));
    assert.ok(bytes.length > 0);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      receipt.artifacts[file],
    );
  }
  for (const mode of ["precheck", "raw", "compare"]) {
    const consumed = await runNir1Retrieval({
      mode,
      output: path.join(root, ".artifacts", `reject-fixture-${mode}`),
      "build-receipt": output,
    });
    assert.equal(consumed.status, "blocked");
    assert.match(
      consumed.errors[0],
      /authoritative standard build is required/u,
    );
    assert.equal(consumed.models, undefined);
    assert.equal(consumed.artifacts, undefined);
    assert.deepEqual(consumed.cases, []);
  }
});

test("retrieval rejects failed and unknown-schema build receipts before model admission", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, ".artifacts"), { recursive: true });
  for (const [field, value, message] of [
    ["status", "failed", /build receipt status must be passed/u],
    [
      "schemaVersion",
      "nir1-standard-build-fixture/1",
      /unsupported standard-build receipt schema/u,
    ],
    ["schemaVersion", null, /unsupported standard-build receipt schema/u],
  ]) {
    const output = receiptPath(
      root,
      `invalid-${field}-${encodeURIComponent(value)}.json`,
    );
    await writeFile(
      output,
      JSON.stringify({
        status: "passed",
        standardBuild: true,
        schemaVersion: "nir1-standard-build/1",
        sourceUnchanged: true,
        [field]: value,
      }),
    );
    const consumed = await runNir1Retrieval({
      mode: "precheck",
      output: path.join(root, ".artifacts", `reject-${field}-${value}`),
      "build-receipt": output,
    });
    assert.equal(consumed.status, "blocked");
    assert.match(consumed.errors[0], message);
    assert.equal(consumed.models, undefined);
    assert.equal(consumed.artifacts, undefined);
  }
});

test("dirty source candidate is rejected before the first command", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "untracked.txt"), "dirty\n");
  const runner = fixtureRunner(root);
  const output = receiptPath(root);
  const receipt = await runFailure(
    { root, receiptPath: output, runCommand: runner },
    /must be clean/u,
  );

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.standardBuild, false);
  assert.equal(receipt.candidate.worktreeClean, false);
  assert.deepEqual(receipt.commands, []);
  assert.deepEqual(runner.calls, []);
});

test("production entrypoint rejects injected success runners before admission", async (t) => {
  const { root } = await fixture(t);
  let calls = 0;
  await assert.rejects(
    produceStandardBuildReceipt({
      root,
      receiptPath: receiptPath(root),
      runCommand: async () => {
        calls += 1;
        return {
          exitCode: 0,
          closeObserved: true,
          cleanup: { complete: true },
        };
      },
    }),
    /unsupported standard-build producer option/u,
  );
  assert.equal(calls, 0);
  await assert.rejects(readFile(receiptPath(root)), /ENOENT/u);
});

test("pre-existing source changes hidden by index flags reject before admission", async (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const { root } = await fixture(t);
    git(root, ["update-index", flag, "--", "src/source.txt"]);
    await writeFile(
      path.join(root, "src/source.txt"),
      "hidden source change\n",
    );
    assert.equal(git(root, ["status", "--porcelain"]), "");
    const runner = fixtureRunner(root);
    const receipt = await runFailure(
      { root, receiptPath: receiptPath(root), runCommand: runner },
      /source index must not use assume-unchanged or skip-worktree/u,
    );
    assert.equal(receipt.standardBuild, false);
    assert.equal(Object.hasOwn(receipt, "artifacts"), false);
    assert.deepEqual(receipt.commands, []);
    assert.equal(runner.calls.length, 0);
  }
});

test("post-build source hash drift fails even if Git status is hidden", async (t) => {
  const { root } = await fixture(t);
  const runner = fixtureRunner(root, {
    afterCommand: async (index) => {
      if (index !== 1) return;
      await writeFile(
        path.join(root, "src/source.txt"),
        "changed behind assume-unchanged\n",
      );
      git(root, ["update-index", "--assume-unchanged", "--", "src/source.txt"]);
    },
  });
  const receipt = await runFailure(
    { root, receiptPath: receiptPath(root), runCommand: runner },
    /source index must not use assume-unchanged or skip-worktree/u,
  );

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.standardBuild, false);
  assert.equal(receipt.sourceUnchanged, false);
  assert.equal(runner.calls.length, 2);
});

test("post-build HEAD and tree drift cannot produce a success receipt", async (t) => {
  const { root } = await fixture(t);
  const runner = fixtureRunner(root, {
    afterCommand: async (index, directory) => {
      if (index !== 1) return;
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "HEAD drift",
        ],
        { cwd: directory, stdio: "ignore" },
      );
    },
  });
  const receipt = await runFailure(
    { root, receiptPath: receiptPath(root), runCommand: runner },
    /base, HEAD, or tree changed/u,
  );

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.standardBuild, false);
  assert.equal(receipt.sourceUnchanged, false);
});

test("post-build tracked path-list drift cannot produce success", async (t) => {
  const { root } = await fixture(t);
  const runner = fixtureRunner(root, {
    afterCommand: async (index, directory) => {
      if (index !== 1) return;
      await writeFile(path.join(directory, "src/new-source.txt"), "new path\n");
      git(directory, ["add", "src/new-source.txt"]);
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "path drift",
        ],
        { cwd: directory, stdio: "ignore" },
      );
    },
  });
  const receipt = await runFailure(
    { root, receiptPath: receiptPath(root), runCommand: runner },
    /source path list changed/u,
  );

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.standardBuild, false);
});

test("spawn error is observed as failure and never admits command two", async (t) => {
  const { root } = await fixture(t);
  const calls = [];
  const runner = async (entry, options) => {
    calls.push(entry);
    assert.deepEqual([entry.command, ...entry.args], COMMANDS[0]);
    return runLocalCiCommand(
      {
        command: "nir1-fixture-executable-that-does-not-exist",
        args: [],
        cwd: ".",
      },
      { ...options, root },
    );
  };
  const receipt = await runFailure(
    { root, receiptPath: receiptPath(root), runCommand: runner },
    /did not complete cleanly/u,
  );

  assert.equal(receipt.commands[0].status, "spawn-error");
  assert.match(receipt.commands[0].error, /ENOENT/u);
  assert.equal(receipt.commands[0].closeObserved, true);
  assert.equal(calls.length, 1);
});

test("nonzero command status stops the ordered build without retry", async (t) => {
  const { root } = await fixture(t);
  const runner = fixtureRunner(root, { failAt: 0 });
  const receipt = await runFailure(
    { root, receiptPath: receiptPath(root), runCommand: runner },
    /did not complete cleanly/u,
  );

  assert.deepEqual(runner.calls, [
    { command: "pnpm", args: ["napi:build"], cwd: "." },
  ]);
  assert.equal(receipt.commands[0].exitCode, 23);
  assert.equal(receipt.commands[0].status, "failed");
  assert.equal(receipt.standardBuild, false);
});

test("timeout and abort close admission and preserve observed cleanup failure evidence", async (t) => {
  const timeoutFixture = await fixture(t);
  const timeoutRunner = fixtureRunner(timeoutFixture.root, {
    timeoutMs: 40,
    source: () => "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  });
  const timedOut = await runFailure(
    {
      root: timeoutFixture.root,
      receiptPath: receiptPath(timeoutFixture.root),
      runCommand: timeoutRunner,
    },
    /did not complete cleanly/u,
  );
  assert.equal(timedOut.commands[0].status, "timed-out");
  assert.equal(timedOut.commands[0].closeObserved, true);
  assert.equal(timedOut.commands[0].cleanup.complete, true);
  assert.equal(timeoutRunner.calls.length, 1);

  const abortFixture = await fixture(t);
  const controller = new AbortController();
  const ready = path.join(abortFixture.root, "abort-ready");
  const abortRunner = fixtureRunner(abortFixture.root, {
    source: () =>
      `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`,
  });
  const output = receiptPath(abortFixture.root);
  const running = produceStandardBuildFixtureReceipt({
    root: abortFixture.root,
    receiptPath: output,
    runCommand: abortRunner,
    signal: controller.signal,
  });
  while (true) {
    try {
      await readFile(ready);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  controller.abort(new Error("fixture abort"));
  await assert.rejects(running, /fixture abort/u);
  const interrupted = JSON.parse(await readFile(output, "utf8"));
  assert.equal(interrupted.commands[0].status, "interrupted");
  assert.equal(interrupted.commands[0].closeObserved, true);
  assert.equal(interrupted.commands[0].cleanup.complete, true);
  assert.equal(abortRunner.calls.length, 1);
});

test(
  "transient diagnostic failure retains unknown owner and blocks reentry until late cleanup",
  { timeout: 5_000 },
  async (t) => {
    const { root } = await fixture(t);
    const output = receiptPath(root);
    let resolveLateClose;
    const lateClose = new Promise((resolve) => {
      resolveLateClose = resolve;
    });
    let resolveFailureWritten;
    const failureWritten = new Promise((resolve) => {
      resolveFailureWritten = resolve;
    });
    const lateResult = {
      termination: "late-close-and-group-exit-observed",
      exitCode: 0,
      signal: null,
    };
    t.after(() => resolveLateClose(lateResult));
    let writeFailed = false;
    let commands = 0;
    let settled = false;
    const running = produceStandardBuildFixtureReceipt({
      root,
      receiptPath: output,
      runCommand: async () => {
        commands += 1;
        throw Object.assign(new Error("unobserved close"), {
          result: {
            closeObserved: false,
            cleanup: { complete: false, groupAlive: true },
            termination: "unknown",
          },
          lateClose,
        });
      },
      writeOwner: async (file, owner) => {
        if (owner.phase === "command-failed" && !writeFailed) {
          writeFailed = true;
          throw new Error("transient owner write failure");
        }
        await writeFile(file, JSON.stringify(owner));
        if (owner.status === "failed") resolveFailureWritten(owner.phase);
      },
    }).then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    assert.equal(await failureWritten, "termination-unknown");
    assert.equal(writeFailed, true);
    const blockedRunner = fixtureRunner(root);
    await assert.rejects(
      produceStandardBuildFixtureReceipt({
        root,
        receiptPath: receiptPath(root, "blocked-by-owner.json"),
        runCommand: blockedRunner,
      }),
      /EEXIST/u,
    );
    assert.equal(settled, false);
    assert.equal(commands, 1);
    assert.equal(blockedRunner.calls.length, 0);

    resolveLateClose(lateResult);
    const failure = await running;
    assert.match(failure?.message, /transient owner write failure/u);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    assert.equal(receipt.standardBuild, false);
    assert.equal(receipt.commands[0].termination, "unknown");
    assert.equal(Object.hasOwn(receipt, "artifacts"), false);
    await assert.rejects(
      readFile(
        path.join(root, ".artifacts/nir1-standard-build/active/owner.json"),
      ),
      /ENOENT/u,
    );
    const retry = await produceStandardBuildFixtureReceipt({
      root,
      receiptPath: receiptPath(root, "after-cleanup.json"),
      runCommand: fixtureRunner(root),
    });
    assert.equal(retry.receipt.status, "passed");
    assert.equal(retry.receipt.standardBuild, false);
  },
);

test("process-group survivor is cleaned but still fails without admitting command two", async (t) => {
  const { root } = await fixture(t);
  const marker = path.join(root, "survivor.pid");
  const runner = fixtureRunner(root, {
    groupSurvivorAt: 0,
    marker,
    termGraceMs: 30,
    killGraceMs: 200,
  });
  const receipt = await runFailure(
    {
      root,
      receiptPath: receiptPath(root),
      runCommand: runner,
      termGraceMs: 30,
      killGraceMs: 200,
    },
    /process group survived command close/u,
  );

  assert.equal(receipt.commands[0].closeObserved, true);
  assert.equal(receipt.commands[0].cleanup.complete, true);
  assert.equal(receipt.commands[0].status, "failed");
  assert.equal(runner.calls.length, 1);
  assert.match((await readFile(marker, "utf8")).trim(), /^\d+$/u);
});

test("missing build artifact and preexisting receipts never yield success or overwrite", async (t) => {
  const { root } = await fixture(t);
  const missingRunner = fixtureRunner(root, { marker: "omit-renderer" });
  const output = receiptPath(root, "missing-artifact.json");
  const missing = await runFailure(
    { root, receiptPath: output, runCommand: missingRunner },
    /ENOENT|regular and nonempty/u,
  );
  assert.equal(missing.status, "failed");
  assert.equal(missing.standardBuild, false);
  assert.equal(missing.sourceUnchanged, true);
  assert.equal(Object.hasOwn(missing, "artifacts"), false);
  assert.deepEqual(
    missing.commands.map((command) => command.status),
    ["passed", "passed"],
  );

  const blockedPath = receiptPath(root, "blocked.json");
  const priorManifest = `${blockedPath}.sources.json`;
  await mkdir(path.dirname(blockedPath), { recursive: true });
  await writeFile(priorManifest, "prior manifest\n");
  const noOutputRunner = fixtureRunner(root);
  const blocked = await runFailure(
    { root, receiptPath: blockedPath, runCommand: noOutputRunner },
    /refusing to overwrite existing output/u,
  );
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.standardBuild, false);
  assert.deepEqual(blocked.commands, []);
  assert.equal(await readFile(priorManifest, "utf8"), "prior manifest\n");
  assert.deepEqual(noOutputRunner.calls, []);

  const existingPath = receiptPath(root, "existing.json");
  await mkdir(path.dirname(existingPath), { recursive: true });
  await writeFile(existingPath, "prior receipt\n");
  const blockedRunner = fixtureRunner(root);
  await assert.rejects(
    produceStandardBuildFixtureReceipt({
      root,
      receiptPath: existingPath,
      runCommand: blockedRunner,
    }),
    /refusing to overwrite existing output/u,
  );
  assert.equal(await readFile(existingPath, "utf8"), "prior receipt\n");
  assert.deepEqual(blockedRunner.calls, []);
});
