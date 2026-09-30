import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

// Exercise the Xvfb owner through the real supervisor with controlled child
// executables. No browser download or running desktop session is required.
let nextXvfbTestDisplay = 100;

async function xvfbFixture(t, mode = "") {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  const root = await fixture(t);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const prelude = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.XVFB_TEST_ROOT;
const mode = process.env.XVFB_TEST_MODE;
`;
  await writeFile(
    path.join(bin, "xauth"),
    prelude +
      `
const auth = process.argv[process.argv.indexOf('-f') + 1];
fs.writeFileSync(path.join(root, 'auth-started'), String(process.pid));
if (mode === 'auth-hold') { setInterval(() => {}, 1000); }
else {
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    if (mode === 'auth-fail') process.exit(8);
    fs.appendFileSync(auth, input);
  });
}
`,
  );
  await writeFile(
    path.join(bin, "Xvfb"),
    prelude +
      `
const auth = process.argv[process.argv.indexOf('-auth') + 1];
const state = { pid: process.pid, parent: process.ppid, auth, argv: process.argv.slice(2),
  mode: fs.statSync(auth).mode & 511,
  directoryMode: fs.statSync(path.dirname(auth)).mode & 511,
  authorizedBeforeStart: /MIT-MAGIC-COOKIE-1 [0-9a-f]{32}/.test(fs.readFileSync(auth, 'utf8')) };
fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify(state));
if (mode === 'server-fail') process.exit(9);
if (mode === 'eof') { fs.closeSync(3); setInterval(() => {}, 1000); }
else if (mode === 'hold-ready') { setInterval(() => {}, 1000); }
else {
  fs.writeSync(3, mode === 'bad-record' ? '12\\n13\\n' : mode === 'oversize' ? '9'.repeat(100) : process.env.XVFB_TEST_DISPLAY + '\\n');
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {
    if (mode === 'server-dies' && fs.existsSync(path.join(root, 'application-started'))) process.exit(10);
  }, 10);
}
`,
  );
  await Promise.all(
    ["Xvfb", "xauth"].map((name) => chmod(path.join(bin, name), 0o700)),
  );
  const helper = fileURLToPath(new URL("./local-ci-xvfb.mjs", import.meta.url));
  const entry = (source) => ({
    command: process.execPath,
    args: [helper, process.execPath, "-e", source],
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      XVFB_TEST_ROOT: root,
      XVFB_TEST_MODE: mode,
      XVFB_TEST_DISPLAY: String(nextXvfbTestDisplay++),
    },
  });
  const options = {
    root,
    logDirectory: ".logs",
    taskId: "xvfb",
    timeoutMs: 10_000,
  };
  return { root, entry, options };
}

async function waitForXvfbFile(file) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Xvfb test did not create ${file}`);
}

async function assertXvfbClean(root, result) {
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.cleanup.groupAlive, false);
  assert.throws(() => process.kill(-result.pid, 0), { code: "ESRCH" });
  let server;
  try {
    server = JSON.parse(await readFile(path.join(root, "server.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.throws(() => process.kill(server.pid, 0), { code: "ESRCH" });
  await assert.rejects(readFile(server.auth), { code: "ENOENT" });
  assert.equal(server.mode, 0o600);
  assert.equal(server.directoryMode, 0o700);
  assert.equal(server.authorizedBeforeStart, true);
  assert.deepEqual(server.argv, [
    "-displayfd",
    "3",
    "-screen",
    "0",
    "1920x1080x24",
    "-nolisten",
    "tcp",
    "-auth",
    server.auth,
  ]);
}

const xvfbApplicationStarted =
  "require('node:fs').writeFileSync(require('node:path').join(process.env.XVFB_TEST_ROOT,'application-started'),'yes');";

test("Xvfb owners run concurrently with separate displays and private authorization", async (t) => {
  const fixtures = await Promise.all([
    xvfbFixture(t),
    xvfbFixture(t),
    xvfbFixture(t),
  ]);
  const results = await Promise.all(
    fixtures.map(async ({ root, entry, options }) => {
      const result = await runLocalCiCommand(
        entry(`
      const fs = require('node:fs');
      const auth = fs.readFileSync(process.env.XAUTHORITY, 'utf8');
      require('node:assert/strict').match(auth, new RegExp('add ' + process.env.DISPLAY + ' MIT-MAGIC-COOKIE-1'));
      console.log(JSON.stringify({display:process.env.DISPLAY,auth:process.env.XAUTHORITY}));
      setTimeout(() => {}, 100);
    `),
        options,
      );
      assert.equal(result.exitCode, 0);
      await assertXvfbClean(root, result);
      return JSON.parse(
        await readFile(path.join(root, result.logs.stdout.path), "utf8"),
      );
    }),
  );
  assert.equal(new Set(results.map((result) => result.display)).size, 3);
  assert.equal(new Set(results.map((result) => result.auth)).size, 3);
});

for (const [label, mode] of [
  ["xauth failure", "auth-fail"],
  ["server startup failure", "server-fail"],
  ["displayfd EOF", "eof"],
  ["invalid displayfd", "bad-record"],
  ["oversized displayfd", "oversize"],
]) {
  test(`Xvfb ${label} fails closed without admitting application`, async (t) => {
    const { root, entry, options } = await xvfbFixture(t, mode);
    const result = await runLocalCiCommand(
      entry(xvfbApplicationStarted),
      options,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
    await assert.rejects(readFile(path.join(root, "application-started")), {
      code: "ENOENT",
    });
    await assertXvfbClean(root, result);
  });
}

for (const phase of ["auth-hold", "hold-ready", "running"]) {
  test(`Xvfb cancellation during ${phase} closes admission and reaps children`, async (t) => {
    const { root, entry, options } = await xvfbFixture(t, phase);
    const controller = new AbortController();
    const running = runLocalCiCommand(
      entry(xvfbApplicationStarted + "setInterval(()=>{},1000);"),
      { ...options, signal: controller.signal },
    );
    await waitForXvfbFile(
      path.join(
        root,
        phase === "auth-hold"
          ? "auth-started"
          : phase === "hold-ready"
            ? "server.json"
            : "application-started",
      ),
    );
    controller.abort();
    const result = await running;
    assert.equal(result.interrupted, true);
    assert.equal(result.exitCode, 143);
    if (phase !== "running")
      await assert.rejects(readFile(path.join(root, "application-started")), {
        code: "ENOENT",
      });
    await assertXvfbClean(root, result);
  });
}

test("Xvfb startup remains bounded by the supervisor task timeout", async (t) => {
  const { root, entry, options } = await xvfbFixture(t, "hold-ready");
  const result = await runLocalCiCommand(entry(xvfbApplicationStarted), {
    ...options,
    timeoutMs: 500,
  });
  assert.equal(result.timedOut, true);
  await assert.rejects(readFile(path.join(root, "application-started")), {
    code: "ENOENT",
  });
  await assertXvfbClean(root, result);
});

for (const [label, source, expected] of [
  ["nonzero exit", "process.exit(17)", 17],
  ["signal exit", "process.kill(process.pid,'SIGTERM')", 143],
]) {
  test(`Xvfb preserves application ${label} and removes the server`, async (t) => {
    const { root, entry, options } = await xvfbFixture(t);
    const result = await runLocalCiCommand(entry(source), options);
    assert.equal(result.exitCode, expected);
    await assertXvfbClean(root, result);
  });
}

test("Xvfb command spawn failure still reaps the server", async (t) => {
  const { root, entry, options } = await xvfbFixture(t);
  const command = entry("");
  command.args = [command.args[0], path.join(root, "missing-command")];
  const result = await runLocalCiCommand(command, options);
  assert.equal(result.exitCode, 1);
  await assertXvfbClean(root, result);
});

test("Xvfb unexpected server death terminates a running application", async (t) => {
  const { root, entry, options } = await xvfbFixture(t, "server-dies");
  const result = await runLocalCiCommand(
    entry(xvfbApplicationStarted + "setInterval(()=>{},1000);"),
    options,
  );
  assert.equal(result.exitCode, 1);
  await assertXvfbClean(root, result);
});

test("Xvfb teardown escalates a TERM-resistant server and waits for close", async (t) => {
  const { root, entry, options } = await xvfbFixture(t, "ignore-term");
  const result = await runLocalCiCommand(entry("process.exit(0)"), options);
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 500);
  await assertXvfbClean(root, result);
});

test("Xvfb SIGINT cancellation preserves status and leaves no owned process", async (t) => {
  const { root, entry, options } = await xvfbFixture(t, "hold-ready");
  const running = runLocalCiCommand(entry(xvfbApplicationStarted), options);
  const server = JSON.parse(
    await waitForXvfbFile(path.join(root, "server.json")),
  );
  // The fake server's parent is the helper; signal only that owner.
  process.kill(server.parent, "SIGINT");
  const result = await running;
  assert.equal(result.exitCode, 130);
  await assert.rejects(readFile(path.join(root, "application-started")), {
    code: "ENOENT",
  });
  await assertXvfbClean(root, result);
});

test("Xvfb executable missing fails before application admission", async (t) => {
  const { root, entry, options } = await xvfbFixture(t);
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(root, "bin", "Xvfb"));
  const command = entry(xvfbApplicationStarted);
  command.env.PATH = path.join(root, "bin");
  const result = await runLocalCiCommand(command, options);
  assert.equal(result.exitCode, 1);
  await assert.rejects(readFile(path.join(root, "application-started")), {
    code: "ENOENT",
  });
  await assertXvfbClean(root, result);
});

test("Xvfb wrapper does not hide a surviving application descendant from supervisor", async (t) => {
  const { root, entry, options } = await xvfbFixture(t);
  await assert.rejects(
    runLocalCiCommand(
      entry(`
    require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref();
  `),
      { ...options, termGraceMs: 100 },
    ),
    (error) => {
      assert.match(error.message, /process group survived command close/);
      assert.equal(error.result.cleanup.survivorDetected, true);
      assert.equal(error.result.cleanup.complete, true);
      assert.throws(() => process.kill(-error.result.pid, 0), {
        code: "ESRCH",
      });
      return true;
    },
  );
  const server = JSON.parse(
    await readFile(path.join(root, "server.json"), "utf8"),
  );
  assert.throws(() => process.kill(server.pid, 0), { code: "ESRCH" });
  await assert.rejects(readFile(server.auth), { code: "ENOENT" });
});
