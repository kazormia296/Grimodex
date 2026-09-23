import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
      termGraceMs: 50,
    }),
    (error) => {
      assert.match(error.message, /process group survived command close/u);
      assert.match(
        error.result?.logs?.stdout?.sha256 ?? "",
        /^sha256:[0-9a-f]{64}$/u,
      );
      assert.equal(error.result?.cleanup?.survivorDetected, true);
      assert.equal(error.result?.cleanup?.complete, true);
      return true;
    },
  );
});

test("bounded close observation reports unknown and retains late close/error ownership", async (t) => {
  const root = await fixture(t);
  let delayedError;
  const delayClose = (command, args, options) => {
    const child = spawn(command, args, options);
    const originalOnce = child.once.bind(child);
    child.once = (event, listener) => {
      if (event === "error") {
        delayedError = new Error("controlled late spawn error");
        originalOnce(event, listener);
        setTimeout(() => listener(delayedError), 190);
        return child;
      }
      if (event === "close") {
        originalOnce(event, (...values) =>
          setTimeout(() => listener(...values), 220),
        );
        return child;
      }
      return originalOnce(event, listener);
    };
    return child;
  };
  let unknown;
  await assert.rejects(
    runLocalCiCommand(
      nodeCommand("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"),
      {
        closeGraceMs: 25,
        killGraceMs: 100,
        logDirectory: ".logs",
        root,
        spawnProcess: delayClose,
        taskId: "late-close",
        termGraceMs: 25,
        timeoutMs: 30,
      },
    ),
    (error) => {
      unknown = error;
      assert.equal(error.result?.closeObserved, false);
      assert.equal(error.result?.cleanup?.complete, false);
      assert.equal(error.result?.termination, "unknown");
      assert.equal(error.result?.logs.stdout.complete, false);
      return true;
    },
  );

  const late = await unknown.lateClose;
  assert.equal(late.closeObserved, true);
  assert.equal(late.cleanup.complete, true);
  assert.equal(late.termination, "late-close-and-group-exit-observed");
  assert.equal(late.error, delayedError.message);
});

test("allows bounded process-group teardown after command close", async (t) => {
  const root = await fixture(t);
  const source = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['--input-type=commonjs','-e','setTimeout(()=>{},100)'],{stdio:'ignore'}).unref();",
    "process.exit(0);",
  ].join("");

  const result = await runLocalCiCommand(nodeCommand(source), {
    logDirectory: ".logs",
    root,
    taskId: "bounded-teardown",
    termGraceMs: 500,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.cleanup.termSent, false);
  assert.equal(result.cleanup.survivorDetected, undefined);
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
