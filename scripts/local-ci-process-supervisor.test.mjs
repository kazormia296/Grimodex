import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runLocalCiCommand } from "./local-ci-process-supervisor.mjs";
import { resolveC2ZcRustAcceptanceCandidate } from "./c2zc-rust-acceptance-receipt.mjs";
import { isNativeBJourney, nativeBEnvironment, nativeBRootMarker, nativeBIncludesEditor } from "./local-ci-xvfb.mjs";
import { admitFullResources } from "./local-ci-full-admission.mjs";
import { assertNativeBQualification, createNativeBBusOwner, nativeBBusConfig, nativeBElectronEnvironment } from "../electron/scripts/product-journey-native-b.mjs";

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
// The file's existence is the readiness signal, so publish complete JSON atomically.
const serverFile = path.join(root, 'server.json');
const pendingServerFile = serverFile + '.tmp';
fs.writeFileSync(pendingServerFile, JSON.stringify(state));
fs.renameSync(pendingServerFile, serverFile);
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

test("Xvfb owners isolate X11 sessions with separate displays and private authorization", async (t) => {
  const fixtures = await Promise.all([
    xvfbFixture(t),
    xvfbFixture(t),
    xvfbFixture(t),
  ]);
  const results = await Promise.all(
    fixtures.map(async ({ root, entry, options }) => {
      const command = entry(`
      const fs = require('node:fs');
      const auth = fs.readFileSync(process.env.XAUTHORITY, 'utf8');
      const assert = require('node:assert/strict');
      assert.match(auth, new RegExp('add ' + process.env.DISPLAY + ' MIT-MAGIC-COOKIE-1'));
      assert.equal(process.env.XDG_SESSION_TYPE, 'x11');
      assert.equal(process.env.GRIMODEX_LOCAL_CI_XVFB, '1');
      assert.equal(process.env.WAYLAND_DISPLAY, undefined);
      assert.equal(process.env.WAYLAND_SOCKET, undefined);
      console.log(JSON.stringify({display:process.env.DISPLAY,auth:process.env.XAUTHORITY}));
      setTimeout(() => {}, 100);
    `);
      Object.assign(command.env, {
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-test",
        WAYLAND_SOCKET: "10",
      });
      const result = await runLocalCiCommand(command, options);
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

test("Full host gate rejects an unowned invocation before effects or privileged holding", async () => {
  let held = false;
  const options = { root: "/nonexistent-unadmitted-checkout", localRunId: "synthetic",
    holdNativeRoots() { held = true; throw new Error("privileged hold reached"); } };
  await assert.rejects(admitFullResources(options), /checkout-lock owning canonical Full invocation UUID/u);
  assert.equal(held, false);
  const controller = new AbortController();
  controller.abort(new Error("cancelled before Full admission"));
  await assert.rejects(admitFullResources({ ...options, signal: controller.signal }), /cancelled before/u);
  assert.equal(held, false);
  const args = shard => ["electron/scripts/product-journey-shards.mjs", "run", "--shard", String(shard),
    "--output-dir", ".artifacts/local-ci/runs/synthetic/product-journeys"];
  assert.equal(nativeBIncludesEditor(args(1), {}), true);
  for (let shard = 2; shard <= 7; shard++) assert.equal(nativeBIncludesEditor(args(shard), {}), false);
});

test("non-Editor shards use the ordinary Xvfb owner and reject removed holding flags", async (t) => {
  for (let shard = 2; shard <= 7; shard++) {
    const { root, entry, options } = await xvfbFixture(t);
    await mkdir(path.join(root, "electron/scripts"), { recursive: true });
    await writeFile(path.join(root, "electron/scripts/product-journey-shards.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync("application-started", "synthetic ordinary shard");`);
    const command = entry("");
    command.args = [command.args[0], process.execPath, "electron/scripts/product-journey-shards.mjs",
      "run", "--shard", String(shard), "--output-dir", ".artifacts/local-ci/runs/synthetic/product-journeys"];
    const result = await runLocalCiCommand(command, options);
    assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
    assert.equal(await readFile(path.join(root, "application-started"), "utf8"), "synthetic ordinary shard");
    await assertXvfbClean(root, result);
  }
  const { root, entry, options } = await xvfbFixture(t);
  const command = entry(xvfbApplicationStarted);
  command.args.splice(1, 0, "--hold-native-b");
  const result = await runLocalCiCommand(command, options);
  assert.equal(result.exitCode, 1);
  await assert.rejects(readFile(path.join(root, "application-started")), { code: "ENOENT" });
  await assertXvfbClean(root, result);
});

test("native B initial transport excludes named host sockets and files", async (t) => {
  const root = await fixture(t);
  const source = String.raw`
import io, json, os, pathlib, runpy, socket, sys
m = runpy.run_path(sys.argv[1])
transport = m["private_transport"]
a, b = socket.socketpair()
assert transport(a.fileno()) and transport(b.fileno())
a.close(); b.close()
r, w = os.pipe()
assert transport(r) and transport(w)
os.close(r); os.close(w)
with open("ordinary", "w") as f:
    assert not transport(f.fileno())
listener = socket.socket(socket.AF_UNIX)
listener.bind("named-host-route")
listener.listen()
assert not transport(listener.fileno())
listener.close()
assert "hold_setup" not in m and "held_observation" not in m
# Call the real request validator without namespace/privilege/workload effects.
# Only path existence is modeled; selection and exact request schema are real.
from types import SimpleNamespace
class Checkout:
    def is_absolute(self): return True
    def resolve(self, strict): return self
    def __str__(self): return "/home/runner/work/synthetic/synthetic"
checkout = Checkout()
original_path = pathlib.Path
g = m["request"].__globals__
g["pathlib"] = SimpleNamespace(Path=lambda value: checkout if value == str(checkout) else original_path(value))
qualification = {"intentDigest":"d"*64, "identities":{}, "source":{}, "head":"a"*40, "base":"b"*40,
                 "run":"200", "attempt":"1", "routes":{}}
value = {"uid":1001, "gid":1001, "checkout":str(checkout), "node":sys.executable,
         "args":["electron/scripts/product-journey-shards.mjs", "run", "--shard", "1", "--output-dir", ".artifacts/local-ci/runs/synthetic/product-journeys"],
         "environment":{"CI":"true", "GITHUB_RUN_ID":"200", "GITHUB_RUN_ATTEMPT":"1"},
         "hostNamespaces":{}, "gitView":{"head":"a"*40,"base":"b"*40}, "qualification":qualification,
         "resourceAdmission":{"path":"synthetic-host-receipt", "sha256":"f"*64}}
g["control_read"] = lambda deadline: value
assert m["request"]() is value
for shard in range(2, 8):
    value["args"][3] = str(shard)
    try: m["request"]()
    except RuntimeError: pass
    else: raise AssertionError("non-Editor privileged initializer admitted")
value["args"][3] = "1"
value["hold"] = {}
try: m["request"]()
except RuntimeError: pass
else: raise AssertionError("removed held request schema admitted")
print("initial transport/request model passed; actual native runtime NOTRUN")
`;
  const result = await runLocalCiCommand({ command: "python3", args: ["-I", "-c", source,
    fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url))] },
  { root, logDirectory: ".logs", taskId: "native-initial-transport", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
});

test("native B initial private resource gate refreshes actual host and rejects late shortages before workloads", async (t) => {
  const root = await fixture(t);
  const source = String.raw`
import copy, hashlib, json, os, pathlib, runpy, sys, time
from types import SimpleNamespace
native = runpy.run_path(sys.argv[1])
helpers = runpy.run_path(sys.argv[2])
checkout = pathlib.Path.cwd()
file = checkout / 'scripts/local-ci-full-filesystems.py'
file.parent.mkdir()
file.write_text('synthetic reviewed helper identity')
private = checkout / 'private'
private.mkdir()
psi = {k: dict(avg10='0.00', avg60='0.00', avg300='0.00', total='12') for k in ('some','full')}
quotas = [dict(type=n, state='kernel-disabled') for n in range(3)]
host_fs = dict(label='workspace', device='1', bytes='101', inodes='101', allocationUnit='4096', quotas=quotas)
root_fs = dict(label='native-b-root-1', device='2', bytes='51', inodes='51', allocationUnit='4096', quotas=quotas, mount=str(private))
mem = dict(membership='0::/synthetic\n', observedAt=int(time.time()*1000),
           host=dict(MemAvailable='201', MemTotal='300', SwapFree='100', SwapTotal='100'), pressure=psi,
           ancestors=[dict(path='.',state='kernel-root-no-controller-limit',pressure=psi)])
host = dict(locations=[['workspace',str(checkout)]], uid=os.getuid(), gids=[os.getgid()],
            filesystems=[host_fs], report=[dict(device='1',demandBytes='100',demandInodes='100')],
            memoryCgroup=mem['membership'], memory=dict(demand='200'), privateDemand=dict(bytes='50',inodes='50'),
            binding=dict(head='a'*40,base='b'*40,runId='200',attempt='1'),
            localRunId='00000000-0000-4000-8000-000000000001', estimateDigest='d'*64)
value = dict(gid=os.getgid(),qualification=dict(source={'scripts/local-ci-full-filesystems.py':hashlib.sha256(file.read_bytes()).hexdigest()}))
actual_host, actual_root, actual_mem = map(copy.deepcopy,(host_fs,root_fs,mem))
calls = []
def inspect(locations, uid, gids):
    calls.append(locations[0][0])
    return [actual_root if locations[0][0]=='native-b-root-1' else actual_host]
g = native['private_resource_gate'].__globals__
g['runpy'] = SimpleNamespace(run_path=lambda _: dict(inspect=inspect,inspect_memory=lambda _:actual_mem,assess_memory=helpers['assess_memory']))
g['os'] = SimpleNamespace(stat=lambda p:SimpleNamespace(st_dev=2 if p==private else 1))
run = lambda:native['private_resource_gate'](checkout,private,value,host)
assert run()['state']=='private-accepted'
assert calls==['workspace','native-b-root-1']
def reject():
    try: run()
    except (RuntimeError,ValueError,KeyError): return
    raise AssertionError('late unknown/shortage admitted as host or whole-run success')
for field,val in [('bytes','50'),('inodes','50'),('allocationUnit','8192'),('mount',str(checkout))]:
    actual_root[field]=val; reject(); actual_root=copy.deepcopy(root_fs)
actual_root['quotas'][0]['state']='kernel-enabled'; reject(); actual_root=copy.deepcopy(root_fs)
actual_host['bytes']='100'; reject(); actual_host=copy.deepcopy(host_fs)
actual_host['device']='foreign'; reject(); actual_host=copy.deepcopy(host_fs)
actual_host['quotas'][0]=dict(type=0,state='kernel-enabled',bytes='100',inodes=None)
reject(); actual_host=copy.deepcopy(host_fs)
actual_mem['host']['MemAvailable']='200'; reject(); actual_mem=copy.deepcopy(mem)
actual_mem['membership']='0::/replacement\n'; reject(); actual_mem=copy.deepcopy(mem)
actual_mem['observedAt']-=31000; reject(); actual_mem=copy.deepcopy(mem)
actual_mem['pressure']['some']['avg10']='0.01'; reject(); actual_mem=copy.deepcopy(mem)
g['CLOSED']=True; reject()
print('synthetic late gate only; no native setup, quota syscall, qualification or workload')
`;
  const result = await runLocalCiCommand({ command: "python3", args: ["-I", "-c", source,
    fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url)),
    fileURLToPath(new URL("./local-ci-full-filesystems.py", import.meta.url))] },
  { root, logDirectory: ".logs", taskId: "native-private-gate-contract", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
  const initializer = await readFile(new URL("./local-ci-native-b.py", import.meta.url), "utf8");
  const main = initializer.slice(initializer.indexOf("def main():"), initializer.indexOf("def client_boundary():"));
  const ordered = ["evidence_sources(", 'mount("tmpfs"', "private_resource_gate(", "os.chroot(", "os.close(0)", "os.closerange(", "facts = drop(", "qualify_routes(", "probe=True", "return supervise("];
  let cursor = -1;
  for (const token of ordered) { const next = main.indexOf(token, cursor + 1); assert.ok(next > cursor, token); cursor = next; }
  assert.doesNotMatch(main, /hold_setup|held_observation|Popen|subprocess\.run/u);
});

test("native B rejects injected transport/runtime selectors and keeps the sandbox", () => {
  for (const selector of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "DBUS_STARTER_ADDRESS",
    "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "ELECTRON_DISABLE_SANDBOX", "ELECTRON_RENDERER_URL"]) {
    assert.throws(() => nativeBEnvironment({ [selector]: "injected" }), /rejects/u);
  }
  const address = `unix:path=/tmp/synthetic/bus,guid=${"a".repeat(32)}`;
  const env = nativeBElectronEnvironment({ DISPLAY: ":42", XAUTHORITY: "/tmp/synthetic/Xauthority",
    PATH: "/usr/bin:/bin", HOME: "/home/runner", SECRET_TEST_VALUE: "not-forwarded", CI: "true" }, address);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, address);
  assert.equal(env.SECRET_TEST_VALUE, undefined);
  assert.equal(env.ELECTRON_DISABLE_SANDBOX, undefined);
  assert.throws(() => nativeBElectronEnvironment({ DISPLAY: ":42", XAUTHORITY: "/tmp/auth" }, "autolaunch:"));
  assert.equal(isNativeBJourney("node", ["electron/scripts/product-journey-shards.mjs", "run"]), true);
  assert.equal(isNativeBJourney("node", ["-e", "arbitrary"]), false);
  const config = nativeBBusConfig(1001, "/tmp/synthetic/bus");
  assert.match(config, /<auth>EXTERNAL<\/auth>/u);
  assert.match(config, /<deny own="\*"\/>/u);
  assert.match(config, /<deny send_destination="\*"\/>/u);
  assert.match(config, /<deny[^>]+send_member="StartServiceByName"/u);
  assert.doesNotMatch(config, /ANONYMOUS|<include|<servicedir|<servicehelper|tcp:|<allow own=|<allow send_destination="\*"/u);
});

test("native B launch options prevent Playwright from silently disabling the sandbox", async (t) => {
  if (process.platform !== "linux") return t.skip("Playwright's Linux sandbox argument default");
  const root = await fixture(t);
  const executable = path.join(root, "synthetic-electron");
  // The real locked launcher builds argv, but this shim never starts Electron,
  // an inspector, a debugging listener, a bus or a native namespace.
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\nexit 23\n', { mode: 0o700 });
  const harness = await readFile(new URL("../electron/scripts/product-journey-harness.mjs", import.meta.url), "utf8");
  const launch = harness.match(/electronLauncher\.launch\((\{[\s\S]*?\n          \})\)/u);
  assert.ok(launch, "exercise the production launch-options expression");
  const source = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {_electron} from ${JSON.stringify(import.meta.resolve("playwright"))};
// Locked Playwright also leaves its internal launch-line waiters rejected when
// the shim exits early; only that exact launch failure is tolerated.
process.on('unhandledRejection', (error) => { if (!/^Process failed to launch!$/u.test(error?.message)) throw error; });
const electronBin=${JSON.stringify(executable)}, electronArgs=['synthetic-main.cjs'], launchTimeoutMs=1500;
for (const nativeBus of [true, false]) {
  const capture=${JSON.stringify(root)}+'/'+(nativeBus?'native':'default')+'-args';
  const env={PATH:process.env.PATH,CAPTURE_ARGS:capture};
  const options=(${launch[1]});
  await assert.rejects(_electron.launch(options), /Process failed to launch!/u);
  const args=(await readFile(capture,'utf8')).trim().split('\\n');
  assert.ok(args.includes('--inspect=0') && args.includes('--remote-debugging-port=0'));
  assert.equal(args.includes('--no-sandbox'), !nativeBus, 'effective Playwright argv, not just harness args');
  assert.equal(args.filter(a=>a==='synthetic-main.cjs').length,1);
}
console.log('locked Playwright argv regression only; actual Electron/sandbox/native runtime NOTRUN');
`;
  const result = await runLocalCiCommand({ command: process.execPath,
    args: ["--input-type=module", "-e", source], timeoutMs: 10_000 },
  { root, logDirectory: ".logs", taskId: "native-sandbox-launch", closeGraceMs: 2_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  await assertXvfbClean(root, result);
});

test("native B admits only the private namespace loopback for the debugger transport", async (t) => {
  const initializer = fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url));
  const source = await readFile(initializer, "utf8");
  const main = source.slice(source.indexOf("def main():"), source.indexOf("def client_boundary():"));
  // lo is configured once, as root, before the private root and permanent drop.
  const ordered = ['network_interfaces() == ["lo"]', "loopback = private_loopback()", 'mount("tmpfs"', "os.chroot(", "facts = drop(", '"loopback": loopback'];
  let cursor = -1;
  for (const token of ordered) { const next = main.indexOf(token, cursor + 1); assert.ok(next > cursor, token); cursor = next; }
  assert.equal(main.match(/private_loopback\(/gu).length, 1);
  assert.doesNotMatch(source, /\/sys\/class\/net|SIOCSIFADDR|SIOCADDRT|RTM_NEW|veth|ip_forward/u);
  const unit = `
import copy, runpy, sys
g = runpy.run_path(sys.argv[1], run_name='contract')
good = {'interfaces': ['lo'], 'up': True, 'ipv4': [['lo', '127.0.0.1']], 'ipv6': [['lo', '0' * 31 + '1']],
        'ipv4MainRoutes': 0, 'ipv6Routes': [['lo', '00', True], ['lo', '80', False]]}
assert g['admissible_loopback'](good)
for change in (lambda f: f.update(interfaces=['eth0', 'lo']), lambda f: f.update(up=False),
               lambda f: f['ipv4'].append(['lo', '127.0.0.2']), lambda f: f.update(ipv4=[['lo', '10.0.0.1']]),
               lambda f: f['ipv6'].append(['lo', 'fe80' + '0' * 28]), lambda f: f.update(ipv4MainRoutes=1),
               lambda f: f['ipv6Routes'].append(['lo', '00', False]), lambda f: f['ipv6Routes'].append(['eth0', '40', False])):
    facts = copy.deepcopy(good); change(facts); assert not g['admissible_loopback'](facts)
print('synthetic loopback admission contract')
`;
  const root = await fixture(t);
  const contract = await runLocalCiCommand({ command: "python3", args: ["-I", "-c", unit, initializer] },
    { root, logDirectory: ".logs", taskId: "native-loopback-contract", timeoutMs: 10_000 });
  assert.equal(contract.exitCode, 0, await readFile(path.join(root, contract.logs.stderr.path), "utf8"));
  if (process.platform !== "linux") return t.skip("Linux network namespaces only");
  // Real lo-up in a throwaway network namespace: unprivileged user namespace
  // first, else the runner's existing passwordless sudo -> unshare route.
  const probe = `
import json, runpy, socket, sys
g = runpy.run_path(sys.argv[1], run_name='probe')
result = g['private_loopback']()
assert result['interfaces'] == ['lo'] and result['ipv4'] == [['lo', '127.0.0.1']] and result['ipv4MainRoutes'] == 0
with socket.socket() as server:
    server.bind(('127.0.0.1', 0)); server.listen()
    socket.create_connection(server.getsockname(), 1).close()
try:
    socket.create_connection(('192.0.2.1', 9), 1)
except OSError as error:
    assert error.errno in (101, 113), error.errno
else:
    raise SystemExit('external route reachable')
try:
    g['private_loopback']()
except RuntimeError as error:
    assert 'not fresh' in str(error)
else:
    raise SystemExit('non-fresh namespace reconfigured')
print(json.dumps(result))
`;
  const routes = [["/usr/bin/unshare", ["-rn"]], ["/usr/bin/sudo", ["-n", "/usr/bin/unshare", "--net"]]];
  for (const [command, prefix] of routes) {
    const result = await runLocalCiCommand({ command, args: [...prefix, "python3", "-I", "-c", probe, initializer] },
      { root, logDirectory: ".logs", taskId: `native-loopback-${path.basename(command)}`, timeoutMs: 10_000 });
    assert.equal(result.cleanup.complete, true);
    const stderr = await readFile(path.join(root, result.logs.stderr.path), "utf8");
    if (result.exitCode === 0) {
      const facts = JSON.parse((await readFile(path.join(root, result.logs.stdout.path), "utf8")).trim());
      assert.equal(facts.version, "B-debugger-private-loopback-v1");
      return;
    }
    // Only an unavailable namespace/privilege route (an unshare or privilege
    // wrapper refusal, or a user namespace without CAP_NET_ADMIN) may fall
    // through; any other failure inside an admitted namespace fails the test.
    assert.match(stderr, /native B loopback ioctl not permitted|^unshare: |^sudo: /mu, stderr);
    assert.doesNotMatch(stderr, /AssertionError|SystemExit|not fresh|configuration unexpected|listing|ioctl failed/u, stderr);
  }
  t.skip("no network namespace route on this host; actual lo-up NOTRUN");
});

test("native B canonical markers and exclusive output leaves reject redirected or duplicate ownership", async (t) => {
  const root = await fixture(t);
  const output = ".artifacts/local-ci/runs/synthetic-run/product-journeys";
  const args = (shard, directory = output) => ["electron/scripts/product-journey-shards.mjs", "run",
    "--shard", String(shard), "--output-dir", directory];
  const markers = Array.from({ length: 7 }, (_, index) => nativeBRootMarker(args(index + 1)));
  assert.equal(new Set(markers).size, 7);
  assert.notEqual(markers[0], nativeBRootMarker(args(1, output.replace("synthetic-run", "other-run"))));
  assert.equal(nativeBRootMarker(["electron/scripts/product-journeys.mjs"]), ".artifacts/native-b-root");
  for (const invalid of [args(0), args(8), args("1\n"), args(1, `${output}\n`),
    args(1, output.replace("synthetic-run", "../escape")), args(1, `/${output}`),
    args(1, output.replace("/runs/", "/runs//")), args(1, output.replace("product-journeys", "other")),
    [...args(1), "--retry"], ["electron/scripts/product-journey-shards.mjs", "aggregate"]]) {
    assert.throws(() => nativeBRootMarker(invalid), /canonical journey command/u);
  }
  // Exercise only the initializer's ordinary filesystem seams. This is not
  // namespace/authentication/retirement qualification and starts no workload.
  const source = String.raw`
import concurrent.futures, json, os, pathlib, runpy, sys
module = runpy.run_path(sys.argv[1])
paths, claim = module["journey_paths"], module["owned_directory"]
checkout, output = pathlib.Path.cwd(), sys.argv[2]
uid, gid = os.getuid(), os.getgid()
def rejected(operation):
    try:
        operation()
    except (RuntimeError, FileExistsError):
        return
    raise AssertionError("duplicate/redirected owner was admitted")
def args(shard, directory=output):
    return ["electron/scripts/product-journey-shards.mjs", "run", "--shard", str(shard), "--output-dir", directory]
def allocate(shard):
    marker, leaf = paths(args(shard))
    claim(checkout, marker, uid, gid)
    claim(checkout, leaf, uid, gid)
    return marker, leaf
with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
    allocated = list(pool.map(allocate, range(1, 8)))
for shard, (marker, leaf) in enumerate(allocated, 1):
    assert leaf == f"{output}/shard-{shard}"
    assert (checkout / leaf).is_dir()
    rejected(lambda: claim(checkout, marker, uid, gid))
    rejected(lambda: claim(checkout, leaf, uid, gid))
    (checkout / marker).rmdir()  # Simulate proved retirement of ONLY this marker.
    rejected(lambda: claim(checkout, leaf, uid, gid))  # Output still fences repeat.
redirect = checkout / ".artifacts/local-ci/runs/redirect"
redirect.symlink_to(checkout, target_is_directory=True)
rejected(lambda: claim(checkout, f"{redirect.relative_to(checkout)}/product-journeys/shard-1", uid, gid))
(checkout / output).chmod(0o777)
rejected(lambda: claim(checkout, f"{output}/shard-8", uid, gid))
(checkout / output).chmod(0o700)
for invalid in json.loads(sys.argv[3]):
    rejected(lambda: paths(invalid))
print(json.dumps([marker for marker, _ in allocated]))
`;
  const invalid = [args(0), args(8), args("1\n"), args(1, `${output}\n`),
    args(1, output.replace("synthetic-run", "../escape")), args(1, `/${output}`),
    args(1, output.replace("/runs/", "/runs//")), [...args(1), "--retry"]];
  const result = await runLocalCiCommand({ command: "python3", cwd: ".", env: {},
    args: ["-I", "-c", source, fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url)), output, JSON.stringify(invalid)] },
  { root, logDirectory: ".logs", taskId: "native-b-shard-paths", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, result.logs.stdout.path), "utf8")), markers);
});

test("native B binds forbid privilege regain for read-only and writable views", async (t) => {
  const root = await fixture(t);
  // Invoke the real bind helper with intercepted mounts, never real privilege.
  // This checks flags only, not kernel enforcement or Chromium suitability.
  const source = String.raw`
import pathlib, runpy, sys
module = runpy.run_path(sys.argv[1])
source = pathlib.Path.cwd() / "source"
source.mkdir()
executable = source / "setuid-file"
executable.write_text("synthetic executable")
executable.chmod(0o4755)
calls = []
def record_mount(source, target, *, flags):
    calls.append((source, target, flags))
module["bind"].__globals__["mount"] = record_mount
for index, (entry, readonly) in enumerate(((source, True), (executable, True), (source, False), (executable, False))):
    private = pathlib.Path.cwd() / ("private-" + str(index))
    private.mkdir()
    calls.clear()
    module["bind"](private, str(entry), readonly=readonly)
    target = str(module["private_path"](private, str(entry)))
    expected = module["MS_BIND"] | module["MS_REMOUNT"] | module["MS_NOSUID"] | module["MS_NODEV"]
    if readonly:
        expected |= module["MS_RDONLY"]
    assert calls == [(str(entry), target, module["MS_BIND"]), (None, target, expected)], calls
`;
  const result = await runLocalCiCommand({ command: "python3", cwd: ".", env: {},
    args: ["-I", "-c", source, fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url))] },
  { root, logDirectory: ".logs", taskId: "native-b-nosuid-binds", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
});

test("native B admits only the locked pnpm workspace links and exact read-only builds", async (t) => {
  const root = await fixture(t);
  // Synthetic files + copied bind model only: no privilege, namespace, B or
  // Editor purpose. Node exercises actual resolution through the private view.
  const source = String.raw`
import json, os, pathlib, runpy, shutil, sys
module = runpy.run_path(sys.argv[1])
checkout = pathlib.Path.cwd() / "checkout"
checkout.mkdir()
def file(relative, contents):
    target = checkout / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(contents)
    return target
def rejected(operation):
    try:
        operation()
    except (RuntimeError, FileNotFoundError):
        return
    raise AssertionError("unsafe workspace view admitted")
file("package.json", '{"type":"module"}')
tracked = ["package.json"]
for name in module["WORKSPACES"]:
    manifest = f"packages/{name}/package.json"
    file(manifest, json.dumps(dict(name="@grimodex/" + name, type="module", exports="./dist/index.js")))
    file(f"packages/{name}/src/index.ts", "// reviewed synthetic source\n")
    tracked.extend((manifest, f"packages/{name}/src/index.ts"))
    file(f"packages/{name}/untracked-private", "synthetic-do-not-expose")
    alias = checkout / "node_modules/@grimodex" / name
    alias.parent.mkdir(parents=True, exist_ok=True)
    alias.symlink_to("../../packages/" + name, target_is_directory=True)
file("packages/scan-contract/dist/index.js", "export const value = 41;\n")
file("packages/scan-core/dist/index.js", "import { value } from '@grimodex/scan-contract'; export const result = value + 1;\n")
# Ordinary locked pnpm also has this nested alias; its parent is NOT mounted.
nested = checkout / "packages/scan-core/node_modules/@grimodex/scan-contract"
nested.parent.mkdir(parents=True)
nested.symlink_to("../../../scan-contract", target_is_directory=True)
base = [checkout / name for name in module["CHECKOUT"] if (checkout / name).exists()]
# This is the actual old failure predicate, not a weakened expectation.
rejected(lambda: module["audit_checkout"](checkout / "node_modules", base))
workspaces, links = module["workspace_sources"](checkout)
admitted = base + workspaces
assert {str(p.relative_to(checkout)) for p in workspaces} == {
    f"packages/{name}/{leaf}" for name in module["WORKSPACES"] for leaf in ("package.json", "dist")}
for path in admitted:
    module["audit_checkout"](path, admitted, links)
private = pathlib.Path.cwd() / "private"
private.mkdir()
mounts = []
def copy_mount(source, target, kind=None, flags=0, data=None):
    assert kind is None and data is None
    target = pathlib.Path(target)
    mounts.append(flags)
    if source is not None:
        assert flags == module["MS_BIND"]  # No recursive mount.
        source = pathlib.Path(source)
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True, symlinks=True)
        else:
            shutil.copyfile(source, target)
    else:
        assert flags == (module["MS_BIND"] | module["MS_REMOUNT"] | module["MS_RDONLY"] |
                         module["MS_NOSUID"] | module["MS_NODEV"])
module["bind"].__globals__["mount"] = copy_mount
for path in admitted:
    module["bind"](private, str(path))
for name in tracked:
    path = module["exact_file"](checkout, name)
    if not any(path == base or base in path.parents for base in admitted):
        module["bind"](private, str(path))
inside = module["private_path"](private, str(checkout))
assert mounts and len(mounts) % 2 == 0
for name in module["WORKSPACES"]:
    package = inside / "packages" / name
    assert (inside / "node_modules/@grimodex" / name).resolve(strict=True) == package
    assert (package / "src/index.ts").read_bytes() == (checkout / "packages" / name / "src/index.ts").read_bytes()
    assert not (package / "untracked-private").exists() and not (package / "node_modules").exists()
# Fixed aliases cannot swap even to the other admitted workspace/build tree.
alias = checkout / "node_modules/@grimodex/scan-core"
for destination in ("../../packages/scan-contract", "../../packages/scan-core/dist", "../../outside", "../../missing"):
    alias.unlink()
    alias.symlink_to(destination, target_is_directory=True)
    rejected(lambda: module["workspace_sources"](checkout))
    rejected(lambda: module["audit_checkout"](checkout / "node_modules", admitted, links))
alias.unlink()
alias.symlink_to("../../packages/scan-core", target_is_directory=True)
extra = checkout / "node_modules/unreviewed-workspace"
extra.symlink_to("../packages/scan-core", target_is_directory=True)
rejected(lambda: module["audit_checkout"](checkout / "node_modules", admitted, links))
extra.unlink()
secret = file("packages/scan-core/dist/.env", "synthetic-secret")
rejected(lambda: module["audit_checkout"](secret.parent, admitted, links))
secret.unlink()
escape = checkout / "packages/scan-core/dist/escape"
escape.symlink_to(checkout / "packages/scan-core/untracked-private")
rejected(lambda: module["audit_checkout"](escape.parent, admitted, links))
escape.unlink()
manifest = checkout / "packages/scan-core/package.json"
manifest.unlink()
manifest.symlink_to(checkout / "packages/scan-contract/package.json")
rejected(lambda: module["workspace_sources"](checkout))
# A dist parent alias must not expose an unreviewed runtime tree either.
dist = checkout / "packages/scan-contract/dist"
dist.rename(dist.with_name("other-build"))
dist.symlink_to("other-build", target_is_directory=True)
rejected(lambda: module["workspace_sources"](checkout))
print(json.dumps(dict(inside=str(inside))))
`;
  const result = await runLocalCiCommand({ command: "python3", cwd: ".", env: {},
    args: ["-I", "-c", source, fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url))] },
  { root, logDirectory: ".logs", taskId: "native-b-workspace-views", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
  const { inside } = JSON.parse(await readFile(path.join(root, result.logs.stdout.path), "utf8"));
  const imported = await runLocalCiCommand({ command: process.execPath, cwd: inside, env: {},
    args: ["--input-type=module", "-e", "import { result } from '@grimodex/scan-core'; if (result !== 42) throw new Error('workspace resolution failed');"] },
  { root, logDirectory: ".logs", taskId: "native-b-workspace-import", timeoutMs: 10_000 });
  assert.equal(imported.exitCode, 0, await readFile(path.join(root, imported.logs.stderr.path), "utf8"));
  assert.equal(imported.cleanup.complete, true);
});

test("native B exact source views preserve Git child mounts and live identity without host metadata", async (t) => {
  const root = await fixture(t);
  // Ordinary synthetic Git/filesystem plus mount-topology model ONLY. Copies
  // check bytes; the model detects covering overlays that copies alone miss.
  // Actual mount/root/route/auth/retirement proof remains separate.
  const source = String.raw`
import json, os, pathlib, runpy, shutil, subprocess, sys
module = runpy.run_path(sys.argv[1])
checkout = pathlib.Path.cwd() / "checkout"
checkout.mkdir()
def git(*args):
    return subprocess.check_output(["git", *args], cwd=checkout, stderr=subprocess.DEVNULL).decode()
def file(relative, contents):
    target = checkout / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(contents)
    return target
git("init", "--quiet")
file(".gitignore", ".artifacts/\n.logs/\n")
file(".npmrc", "ignore-scripts=true\n")
file("package.json", '{}\n')
file("docs/source.md", "synthetic source\n")
git("add", ".")
git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "synthetic")
head = git("rev-parse", "HEAD").strip()
git("update-ref", "refs/remotes/origin/master", head)
file(".git/shallow", head + "\n")  # Include the optional third child mount.
view = dict(head=head, base=head, tracked=git("ls-files", "-z").rstrip("\0").split("\0"))
# These owned synthetic secrets must never enter the view, even as files.
file(".git/config", (checkout / ".git/config").read_text() + '\n[credential]\n helper = forbidden-synthetic-helper\n')
file(".git/hooks/forbidden", "synthetic-credential-do-not-copy")
receipt = ".artifacts/local-ci/c2-zc-rust-acceptance.json"
fixture = ".artifacts/local-ci/c2-zc-restore-fixture/synthetic-run"
for name in (receipt, receipt + ".sha256", *(fixture + "/" + name for name in
             ("c2zc-restore-fixture.manifest.json", "c2zc-restore-fixture.backup.db", "c2zc-restore-fixture.db"))):
    file(name, "synthetic immutable evidence " + name)
file(".artifacts/local-ci/runs/foreign/product-journeys/shard-2/private", "unrelated-output")
environment = dict(GRIMODEX_C2ZC_RUST_RECEIPT_PATH=receipt, GRIMODEX_C2ZC_RESTORE_FIXTURE=json.dumps(dict(
    path=str(checkout / fixture / "c2zc-restore-fixture.backup.db"),
    manifest=str(checkout / fixture / "c2zc-restore-fixture.manifest.json"))))
tracked = module["git_sources"](checkout, view)
evidence = module["evidence_sources"](checkout, environment)
assert len(evidence) == 5
private = pathlib.Path.cwd() / "private"
private.mkdir()
visible_mounts, mount_calls = set(), []
frozen = False
inside = module["private_path"](private, str(checkout))
git_directory = inside / ".git"
expected_git_mounts = {git_directory / name for name in ("index", "objects", "shallow")}
def copy_bind(root, source, **options):
    assert not frozen, "child mounted after metadata freeze"
    assert options.get("readonly", True), "Git/evidence mount is writable"
    source = pathlib.Path(source)
    target = module["private_path"](root, str(source))
    visible_mounts.add(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target)
    else:
        shutil.copyfile(source, target)
def model_mount(source, target, *, flags):
    global frozen
    target = pathlib.Path(target)
    assert target == git_directory
    mount_calls.append((source, flags))
    if flags == module["MS_BIND"]:
        assert source == str(target)
        # Nonrecursive self-bind clones the underlying directory mount, not
        # its child mounts. A later parent overlay makes those unreachable.
        visible_mounts.difference_update(child for child in tuple(visible_mounts) if target in child.parents)
        visible_mounts.add(target)
    else:
        assert source is None
        assert flags == (module["MS_BIND"] | module["MS_REMOUNT"] | module["MS_RDONLY"] |
                         module["MS_NOSUID"] | module["MS_NODEV"])
        assert expected_git_mounts <= visible_mounts, "parent self-bind hid Git child mounts"
        frozen = True  # Remount changes flags, not mount topology.
module["materialize_git"].__globals__["bind"] = copy_bind
module["materialize_git"].__globals__["mount"] = model_mount
for source in tracked + evidence:
    copy_bind(private, source)
module["materialize_git"](private, checkout, view, os.getuid(), os.getgid())
assert frozen and len(mount_calls) == 2
assert expected_git_mounts <= visible_mounts
# Check the model's adversarial covering-overlay behavior explicitly. The old
# production ordering fails above; no real privilege/mount is exercised here.
model_mount(str(git_directory), str(git_directory), flags=module["MS_BIND"])
assert not expected_git_mounts.intersection(visible_mounts)
# Mounts are copies in this ordinary test. Restore directory modes only for
# fixture teardown and the deliberate tracked-source corruption below.
inside.chmod(0o755)
(inside / ".git").chmod(0o755)
assert not (inside / ".git/hooks").exists()
assert "credential" not in (inside / ".git/config").read_text()
assert not (inside / ".artifacts/local-ci/runs").exists()
assert all((inside / name.relative_to(checkout)).read_bytes() == name.read_bytes() for name in evidence)
def rejected(operation):
    try:
        operation()
    except (RuntimeError, ValueError, FileNotFoundError):
        return
    raise AssertionError("unsafe exact view admitted")
for path in ("../outside", ".git/config", ".ralph/secret", ".env", "/etc/passwd", "docs//source.md"):
    rejected(lambda: module["git_sources"](checkout, dict(view, tracked=[path])))
redirect = checkout / "redirect"
redirect.symlink_to(checkout / "docs", target_is_directory=True)
rejected(lambda: module["git_sources"](checkout, dict(view, tracked=["redirect/source.md"])))
redirect.unlink()
alternates = file(".git/objects/info/alternates", "/forbidden-synthetic-objects")
rejected(lambda: module["git_sources"](checkout, view))
alternates.unlink()
for path in ("/tmp/receipt", ".artifacts/local-ci/runs/foreign/private", receipt + "/../other"):
    rejected(lambda: module["evidence_sources"](checkout, dict(environment, GRIMODEX_C2ZC_RUST_RECEIPT_PATH=path)))
rejected(lambda: module["evidence_sources"](checkout, dict(environment, GRIMODEX_C2ZC_RESTORE_FIXTURE=json.dumps(dict(
    path=str(checkout / fixture / "c2zc-restore-fixture.backup.db"), manifest="/tmp/foreign-manifest")))))
print(json.dumps(dict(checkout=str(checkout), inside=str(inside))))
`;
  const result = await runLocalCiCommand({ command: "python3", cwd: ".", env: {},
    args: ["-I", "-c", source, fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url))] },
  { root, logDirectory: ".logs", taskId: "native-b-exact-views", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
  const { checkout, inside } = JSON.parse(await readFile(path.join(root, result.logs.stdout.path), "utf8"));
  const before = await resolveC2ZcRustAcceptanceCandidate({ root: checkout });
  const after = await resolveC2ZcRustAcceptanceCandidate({ root: inside });
  assert.equal(before.worktreeClean, true);
  assert.deepEqual(after, before);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(inside, "docs/source.md"), "changed synthetic source");
  const changed = await resolveC2ZcRustAcceptanceCandidate({ root: inside });
  assert.equal(changed.worktreeClean, false);
  assert.notEqual(changed.worktreeFingerprint, before.worktreeFingerprint);
});

test("native B pending/reentrant owner stays single and exit alone cannot retire it", async (t) => {
  let child;
  let count = 0;
  let spawned;
  const ready = new Promise((resolve) => { spawned = resolve; });
  const owner = createNativeBBusOwner({
    readBoundary: async () => ({ uid: 1001 }),
    spawnProcess(command, args, options) {
      count++;
      assert.equal(command, "/usr/bin/dbus-daemon");
      assert.equal(args[0], "--nofork");
      assert.equal(options.detached, false);
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      child.kill = () => { child.emit("exit", 0, null); return true; };
      const config = args[1].slice("--config-file=".length);
      const directory = path.dirname(config);
      t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(directory, { recursive: true, force: true }); });
      spawned({ config, directory });
      return child;
    },
  });
  const first = owner.start();
  const second = owner.start();
  const { directory, config } = await ready;
  assert.match(await readFile(config, "utf8"), /<auth>EXTERNAL<\/auth>/u);
  child.stdio[3].end(`unix:path=${directory}/bus,guid=${"a".repeat(32)}\n`);
  assert.equal(await first, await second);
  assert.equal(count, 1);
  let retired = false;
  const retirement = owner.retire().then(() => { retired = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retired, false, "kill/exit is not close plus stream EOF");
  await assert.rejects(owner.start(), /admission closed/u);
  child.stdout.end(); child.stderr.end();
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0, null);
  await retirement;
  assert.equal(count, 1);
});

test("native B cancellation closes pending admission before a late boundary resolves", async () => {
  const controller = new AbortController();
  let release;
  let count = 0;
  const boundary = new Promise((resolve) => { release = resolve; });
  const owner = createNativeBBusOwner({ signal: controller.signal, readBoundary: () => boundary,
    spawnProcess() { count++; throw new Error("late start must not happen"); } });
  const pending = owner.start();
  controller.abort();
  const retirement = owner.retire();
  const rejectedStart = assert.rejects(pending, /quarantined/u);
  const rejectedRetirement = assert.rejects(retirement, /quarantined/u);
  release({ uid: 1001 });
  await Promise.all([rejectedStart, rejectedRetirement]);
  assert.equal(count, 0);
  await assert.rejects(owner.start(), /admission closed/u);
});

test("native B qualification is mandatory before Electron and scoped to the original Editor partition", async () => {
  const boundary = { qualification: { intentDigest: "a".repeat(64),
    routes: { pathnameDenied: true, abstractDenied: true, tcpDenied: true, hostViewDenied: true },
    retirement: { setsidDoubleFork: true, stdoutEOF: true, stderrEOF: true, descendantsAbsent: true, reaped: 2 } } };
  assert.equal(assertNativeBQualification(boundary), boundary.qualification);
  for (const absent of [null, {}, { qualification: {} }]) assert.throws(() => assertNativeBQualification(absent), /prerequisite absent/u);
  for (const group of ["routes", "retirement"]) {
    for (const key of Object.keys(boundary.qualification[group])) {
      const changed = structuredClone(boundary);
      changed.qualification[group][key] = key === "reaped" ? 1 : "true";
      assert.throws(() => assertNativeBQualification(changed), /prerequisite absent/u);
    }
  }
  const direct = ["electron/scripts/product-journeys.mjs"];
  assert.equal(nativeBIncludesEditor(direct, {}), true);
  assert.equal(nativeBIncludesEditor(direct, { GRIMODEX_PRODUCT_JOURNEY_IDS: '["editor-persistence"]' }), true);
  assert.equal(nativeBIncludesEditor(direct, { GRIMODEX_PRODUCT_JOURNEY_IDS: '["chat-authority-isolation"]' }), false);
  for (let shard = 1; shard <= 7; shard++) {
    assert.equal(nativeBIncludesEditor(["electron/scripts/product-journey-shards.mjs", "run", "--shard", String(shard),
      "--output-dir", ".artifacts/local-ci/runs/synthetic/product-journeys"], {}), shard === 1);
  }
  let starts = 0;
  const owner = createNativeBBusOwner({ readBoundary: async () => null,
    spawnProcess() { starts++; throw new Error("missing native proof must not spawn"); } });
  await assert.rejects(owner.qualify(), /quarantined/u);
  await assert.rejects(owner.qualify(), /admission closed/u);
  await assert.rejects(owner.retire(), /quarantined/u);
  assert.equal(starts, 0);
  const harness = await readFile(new URL("../electron/scripts/product-journey-harness.mjs", import.meta.url), "utf8");
  assert.match(harness, /nativeBElectronEnvironment\(process\.env, await nativeBus\.qualify\(\)\)/u);
  assert.match(harness, /runHarnessOperation\("native-b:qualification", \(\) => nativeBus\.qualify\(\)/u);
  assert.match(harness, /if \(nativeBus && !nativeQualificationRecorded\) \{\s*throw new Error\("native B requires qualification before case admission"\)/u);
  assert.doesNotMatch(harness, /await nativeBus\.start\(\)/u);
});

test("native B real pending client cancellation suppresses late input and joins actual close/EOF", async (t) => {
  const root = await fixture(t);
  // Ordinary synthetic child lifecycle only, NOT native boundary qualification.
  // Replace only client_boundary; execute the actual fixed cancellation mode.
  const source = String.raw`
import os, pathlib, runpy, select, signal, subprocess, sys
module = runpy.run_path(sys.argv[1])
module["qualify_bus"].__globals__["client_boundary"] = lambda: {}
# Fork a scoped known child; never inventory or kill host /proc/process groups.
read, write = os.pipe()
output, out_write = os.pipe()
errors, err_write = os.pipe()
pid = os.fork()
if pid == 0:
    os.dup2(read, 0); os.dup2(out_write, 1); os.dup2(err_write, 2)
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
    sys.exit(module["qualify_bus"]("--cancel-client"))
os.close(read); os.close(out_write); os.close(err_write)
def read_line(descriptor):
    data = bytearray()
    while not data.endswith(b"\n"):
        assert select.select([descriptor], [], [], 2)[0], "child barrier/EOF timed out"
        chunk = os.read(descriptor, 1)
        assert chunk, "child closed before barrier"
        data.extend(chunk)
    return data
assert read_line(output) == b"ready-for-input\n"
admission_closed = True
os.kill(pid, signal.SIGTERM)
# The actual later input callback is suppressed, not delivered to a cancelled
# socket client. Pipe remains held until its child has actually exited.
if not admission_closed:
    os.write(write, b"unapproved-late-endpoint")
assert read_line(output) == b"cancelled-before-input\n"
joined, status = os.waitpid(pid, 0)
assert joined == pid and os.waitstatus_to_exitcode(status) == 0
assert os.read(output, 1) == b"" and os.read(errors, 1) == b""
for descriptor in (write, output, errors):
    os.close(descriptor)
print("actual cancelled known child exit/EOF/join; native proof NOTRUN")
`;
  const result = await runLocalCiCommand({ command: "python3", cwd: ".", env: {},
    args: ["-I", "-c", source, fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url))] },
  { root, logDirectory: ".logs", taskId: "native-b-client-cancel", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, await readFile(path.join(root, result.logs.stderr.path), "utf8"));
  assert.equal(result.cleanup.complete, true);
});
