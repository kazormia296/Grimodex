import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runLocalCiCommand } from "./local-ci-process-supervisor.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-ci-supervisor-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { force: true, recursive: true });
  });
  return root;
}

function nodeCommand(source) {
  return {
    args: ["--input-type=commonjs", "-e", source],
    command: process.execPath,
    cwd: ".",
    env: {},
  };
}

test("captures successful stdout and stderr with exact hashes", async (t) => {
  const root = await fixture(t);
  const result = await runLocalCiCommand(
    nodeCommand(
      "process.stdout.write('hello'); process.stderr.write('warning');",
    ),
    { logDirectory: ".logs", root, taskId: "success" },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.cleanup.complete, true);
  for (const [stream, contents] of [
    ["stdout", "hello"],
    ["stderr", "warning"],
  ]) {
    const log = result.logs[stream];
    assert.equal(await readFile(path.join(root, log.path), "utf8"), contents);
    assert.equal(log.size, Buffer.byteLength(contents));
    assert.equal(
      log.sha256,
      `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    );
  }
});

test("timeout terminates the whole process group with TERM then KILL", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "grandchild-ready");
  const source = [
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['--input-type=commonjs','-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));`,
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ].join("");
  const result = await runLocalCiCommand(nodeCommand(source), {
    killGraceMs: 1_000,
    logDirectory: ".logs",
    root,
    taskId: "timeout",
    termGraceMs: 50,
    timeoutMs: 150,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanup.termSent, true);
  assert.equal(result.cleanup.killSent, true);
  assert.equal(result.cleanup.complete, true);
  assert.match(await readFile(marker, "utf8"), /^\d+$/u);
});

test("AbortSignal interrupts and cleans an admitted command", async (t) => {
  const root = await fixture(t);
  const ready = path.join(root, "ready");
  const controller = new AbortController();
  const running = runLocalCiCommand(
    nodeCommand(
      `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`,
    ),
    {
      logDirectory: ".logs",
      root,
      signal: controller.signal,
      taskId: "interrupt",
    },
  );
  while (true) {
    try {
      await readFile(ready);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  controller.abort();
  const result = await running;

  assert.equal(result.interrupted, true);
  assert.equal(result.cleanup.termSent, true);
  assert.equal(result.cleanup.complete, true);
});

test("rejects a command that exits while a same-group survivor remains", async (t) => {
  const root = await fixture(t);
  const source = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['--input-type=commonjs','-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref();",
    "process.exit(0);",
  ].join("");

  await assert.rejects(
    runLocalCiCommand(nodeCommand(source), {
      logDirectory: ".logs",
      root,
      taskId: "survivor",
    }),
    (error) => {
      assert.match(error.message, /process group survived command close/u);
      assert.equal(error.result?.cleanup?.survivorDetected, true);
      assert.equal(error.result?.cleanup?.complete, true);
      return true;
    },
  );
});

test("reports a missing executable without obscuring the spawn error", async (t) => {
  const root = await fixture(t);
  const result = await runLocalCiCommand(
    { args: [], command: "grimodex-command-that-does-not-exist", cwd: "." },
    { logDirectory: ".logs", root, taskId: "missing" },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.error, /ENOENT/u);
  assert.equal(result.cleanup.complete, true);
});
