import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { groupAlive, launchOwned, processesUnder, settlesWithin, terminateOwned, terminationProven } from "./process-tree.mjs";

// POSIX の process group と終了の証拠の試験（Windows の taskkill は hosted でだけ確かめる）
const posixOnly = { skip: process.platform === "win32" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nodeChild(script, exeDir) {
  return launchOwned({
    command: process.execPath,
    args: ["-e", script],
    env: { ...process.env },
    cwd: os.tmpdir(),
    exeDir,
    label: "test",
  });
}

test("SIGTERM で終わる子: close と process group の消滅を証拠にして ok", posixOnly, async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gps-pt-"));
  const owner = nodeChild("setInterval(() => {}, 1000)", empty);
  await sleep(200);
  assert.equal(owner.isAlive(), true);
  const evidence = await terminateOwned(owner, { graceMs: 5000, forceMs: 5000, settleMs: 2000 });
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.equal(evidence.forced, false);
  assert.equal(evidence.groupGone, true);
  assert.deepEqual(evidence.residual, []);
  assert.equal(evidence.closed.signal, "SIGTERM");
});

test("直接の子が終わっても group に孫が残れば、group に SIGKILL を送り、group が消えてから ok（close だけを証拠にしない）", posixOnly, async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gps-pt-"));
  // 孫は SIGTERM を無視して同じ group に残る。直接の子は SIGTERM で終わる
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `;
  const owner = nodeChild(script, empty);
  await sleep(500);
  const evidence = await terminateOwned(owner, { graceMs: 3000, forceMs: 5000, settleMs: 3000 });
  assert.equal(evidence.forced, true, JSON.stringify(evidence));
  assert.ok(evidence.steps.includes("SIGKILL(group)"));
  assert.equal(evidence.groupGone, true);
  assert.equal(evidence.ok, true);
  assert.equal(groupAlive(owner.pgid), false);
});

test("path の走査で見つけた owner でない process は kill せず、残存として ok を false にする（node の copy を一時 dir に置く）", { skip: process.platform !== "linux" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gps-nodecopy-"));
  const copy = path.join(dir, "node");
  fs.copyFileSync(process.execPath, copy);
  fs.chmodSync(copy, 0o755);
  // owner でない process: 同じ copy から別の process group で起動する（harness が起動していない利用者の process の代役）
  const { spawn } = await import("node:child_process");
  const stranger = spawn(copy, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const owner = launchOwned({ command: copy, args: ["-e", "setInterval(() => {}, 1000)"], env: process.env, cwd: dir, exeDir: dir, label: "owned" });
  try {
    await sleep(300);
    const found = processesUnder(dir);
    assert.ok(found.includes(owner.pid) && found.includes(stranger.pid), JSON.stringify(found));
    const evidence = await terminateOwned(owner, { graceMs: 5000, forceMs: 5000, settleMs: 1000 });
    assert.equal(evidence.closed != null, true);
    assert.deepEqual(evidence.residual, [stranger.pid]);
    assert.equal(evidence.ok, false);
    // owner でない process は生きている（kill していない）
    assert.doesNotThrow(() => process.kill(stranger.pid, 0));
  } finally {
    try { process.kill(stranger.pid, "SIGKILL"); } catch { /* 終わっている */ }
    try { process.kill(-owner.pgid, "SIGKILL"); } catch { /* 終わっている */ }
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux の走査: exe を読めない（EACCES。non-dumpable な sandbox の子）process は cmdline の argv[0] で照合する。消えた process は飛ばす", () => {
  const proc = {
    list: () => ["10", "11", "12", "13", "self"],
    exe: (pid) => {
      if (pid === "10" || pid === "13") throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (pid === "12") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return pid === "11" ? "/usr/bin/ssh-agent" : "";
    },
    cmdline: (pid) => {
      if (pid === "13") throw Object.assign(new Error("hidepid"), { code: "EACCES" });
      return "/opt/app/grimodex\0--type=zygote\0";
    },
  };
  assert.deepEqual(processesUnder("/opt/app", "linux", { proc }), [10]);
  // 走査そのものが失敗したら null（観測できない）。[] にしない
  assert.equal(processesUnder("/opt/app", "linux", { proc: { ...proc, list: () => { throw new Error("no /proc"); } } }), null);
  assert.equal(processesUnder("/opt/app", "darwin", { exec: () => { throw new Error("ps"); } }), null);
  assert.deepEqual(processesUnder("/opt/app", "darwin", { exec: () => "  10 /opt/app/Contents/MacOS/Grimodex --x\n  11 /opt/application/x\n" }), [10]);
});

/** 終わった子の owner の代役（配線の試験用。process を作らない） */
function closedOwner(platform) {
  const closed = { code: 0, signal: null, at: Date.now() };
  return { label: "fake", platform, pid: 424242, pgid: platform === "win32" ? null : 424242, exeDir: "/opt/app", exited: Promise.resolve(closed), isAlive: () => false, closed: () => closed, spawnError: () => null };
}

test("terminateOwned の配線: group が残る・走査できない・残存がある、のどれでも ok にしない。残存の pid に kill を送らない", async () => {
  const calls = [];
  const deps = (over) => ({
    groupAlive: () => false, processesUnder: () => [], taskkill: (pid, force) => { calls.push(["taskkill", pid, force]); return "requested"; },
    killPid: (pid, signal) => calls.push(["killPid", pid, signal]), killGroup: (pgid, signal) => calls.push(["killGroup", pgid, signal]), ...over,
  });
  const fast = { graceMs: 10, forceMs: 10, settleMs: 50 };
  assert.equal((await terminateOwned(closedOwner("linux"), { ...fast, deps: deps({}) })).ok, true);
  assert.equal((await terminateOwned(closedOwner("linux"), { ...fast, deps: deps({ groupAlive: () => true }) })).ok, false);
  assert.equal((await terminateOwned(closedOwner("linux"), { ...fast, deps: deps({ processesUnder: () => null }) })).ok, false);
  calls.length = 0;
  const residual = await terminateOwned(closedOwner("linux"), { ...fast, deps: deps({ processesUnder: () => [777] }) });
  assert.equal(residual.ok, false);
  assert.deepEqual(residual.residual, [777]);
  assert.ok(!calls.some(([, pid]) => pid === 777), JSON.stringify(calls));
  // Windows: exit を見た後は pid に taskkill を送らない（pid の再利用）
  calls.length = 0;
  const win = await terminateOwned(closedOwner("win32"), { ...fast, deps: deps({ processesUnder: () => [888] }) });
  assert.equal(win.ok, false);
  assert.deepEqual(calls.filter(([kind]) => kind === "taskkill"), []);
});

test("起動できない command は ok にしない", posixOnly, async () => {
  const owner = launchOwned({ command: path.join(os.tmpdir(), "gps-no-such-binary"), args: [], env: process.env, cwd: os.tmpdir(), exeDir: null, label: "x" });
  await sleep(200);
  const evidence = await terminateOwned(owner, { graceMs: 500, forceMs: 500, settleMs: 200 });
  assert.equal(evidence.ok, false);
});

test("終了の証拠の合成: close・group の消滅・実行体の dir の下の 0 のどれが欠けても証明にならない", () => {
  assert.equal(terminationProven({ isClosed: true, groupGone: true, residual: [] }), true);
  assert.equal(terminationProven({ isClosed: true, groupGone: null, residual: [] }), true); // Windows（group なし）
  assert.equal(terminationProven({ isClosed: false, groupGone: true, residual: [] }), false);
  assert.equal(terminationProven({ isClosed: true, groupGone: false, residual: [] }), false);
  assert.equal(terminationProven({ isClosed: true, groupGone: true, residual: [42] }), false);
  assert.equal(terminationProven({ isClosed: true, groupGone: true, residual: null }), false); // 観測できない
});

test("有限の待ちは解決した時点で timer を止める（残った timer で harness の終了が遅れない）", async () => {
  const started = Date.now();
  assert.equal(await settlesWithin(Promise.resolve(), 60_000), true);
  assert.equal(await settlesWithin(new Promise(() => {}), 20), false);
  assert.ok(Date.now() - started < 5_000);
  // 解決後に 60 秒の timer が event loop に残っていない
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, 0);
});

test("root が exit した後（close の前でも）は、その pid に taskkill も SIGTERM も送らない。exit 前なら送る（対照）", async () => {
  const calls = [];
  const deps = {
    groupAlive: () => false, processesUnder: () => [],
    taskkill: (pid, force) => { calls.push(["taskkill", pid, force]); return "requested"; },
    killPid: (pid, signal) => calls.push(["killPid", pid, signal]), killGroup: () => {},
  };
  // exit 済みで close がまだ（stdio が開いている）owner。close は少し後に来る
  const exitedNotClosed = (platform) => {
    let closed = null;
    const exited = new Promise((resolve) => setTimeout(() => { closed = { code: 0, signal: null, at: Date.now() }; resolve(closed); }, 100));
    return { label: "x", platform, pid: 4242, pgid: platform === "win32" ? null : 4242, exeDir: "/opt/app", exited,
      isAlive: () => closed == null, closed: () => closed, hasExited: () => true, spawnError: () => null };
  };
  await terminateOwned(exitedNotClosed("win32"), { graceMs: 10, forceMs: 1000, settleMs: 20, deps });
  await terminateOwned(exitedNotClosed("linux"), { graceMs: 10, forceMs: 1000, settleMs: 20, deps });
  assert.deepEqual(calls, []);
  // 対照: exit していない root には送る
  const running = { ...exitedNotClosed("win32"), hasExited: () => false };
  await terminateOwned(running, { graceMs: 10, forceMs: 1000, settleMs: 20, deps });
  assert.deepEqual(calls.map(([kind, , force]) => `${kind}:${force}`), ["taskkill:false", "taskkill:true"]);
});

test("launchOwned は exit を close と別に記録する（exit の後・close の前でも hasExited が true）", posixOnly, async () => {
  // 孫が stdout を持ったまま 1 秒残るので、直接の子の exit の後しばらく close が来ない
  const script = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { stdio: "inherit" }); process.exit(0);`;
  const owner = nodeChild(script, fs.mkdtempSync(path.join(os.tmpdir(), "gps-pt-")));
  assert.equal(owner.hasExited(), false);
  await new Promise((resolve) => owner.child.once("exit", resolve));
  await sleep(50);
  assert.equal(owner.closed(), null);
  assert.equal(owner.hasExited(), true);
  await owner.exited;
  try { process.kill(-owner.pgid, "SIGKILL"); } catch { /* 終わっている */ }
});
