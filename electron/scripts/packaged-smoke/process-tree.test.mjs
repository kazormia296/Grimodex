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

test("実行体の dir の下の process を path で見つける（Linux の /proc/<pid>/exe）。見つけても kill しない", { skip: process.platform !== "linux" }, async () => {
  const owner = nodeChild("setInterval(() => {}, 1000)", path.dirname(process.execPath));
  await sleep(200);
  const found = processesUnder(path.dirname(process.execPath));
  assert.ok(found.includes(owner.pid), JSON.stringify(found));
  assert.ok(!found.includes(process.pid));
  // 実行体の dir の下に残っている間は ok にしない（ここでは自分の子なので最後に終わらせる）
  const evidence = await terminateOwned(owner, { graceMs: 5000, forceMs: 5000, settleMs: 1000 });
  assert.equal(evidence.closed != null, true);
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
