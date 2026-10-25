import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GRAPH_WORKER_SEAM_MARKER } from "../verify-release-graph-worker.mjs";
import { FORBIDDEN_ASAR_CONTENT, FORBIDDEN_ASAR_ENTRY, checkPackage, forbiddenContent, listAsarEntries, peSubsystem, resourcesDirOf } from "./package-check.mjs";

/** asar の header だけを持つ合成の file（中身の bytes は使わない） */
function writeAsar(file, tree) {
  const json = Buffer.from(JSON.stringify({ files: tree }), "utf8");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  fs.writeFileSync(file, Buffer.concat([head, json]));
}

function fakeApp({ asarTree, workerBytes = Buffer.from("worker-binary"), executable = true }) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "gps-pkg-"));
  const resources = resourcesDirOf(appDir, "linux");
  fs.mkdirSync(path.join(resources, "bin"), { recursive: true });
  const worker = path.join(resources, "bin", "nir1-c-query-worker");
  fs.writeFileSync(worker, workerBytes);
  fs.chmodSync(worker, executable ? 0o755 : 0o644);
  writeAsar(path.join(resources, "app.asar"), asarTree);
  return appDir;
}

const PRODUCT_TREE = {
  "package.json": { size: 2, offset: "0" },
  "dist-electron": { files: { "main.cjs": { size: 1, offset: "0" } } },
  dist: { files: { "index.html": { size: 1, offset: "0" } } },
};

test("asar の header から file の一覧を読む", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gps-asar-"));
  const file = path.join(dir, "app.asar");
  writeAsar(file, PRODUCT_TREE);
  assert.deepEqual(listAsarEntries(file), ["dist-electron/main.cjs", "dist/index.html", "package.json"]);
  fs.writeFileSync(file, Buffer.alloc(8));
  assert.throws(() => listAsarEntries(file), /短い/);
});

test("harness・probe の file 名は禁止の対象（製品の file は対象外）", () => {
  for (const entry of ["electron/scripts/packaged-smoke/run.mjs", "electron/scripts/webrtc-block-probe-renderer.js", "x/renderer-isolation-probe.mjs", "dnslog.so", "doh-canary.js"]) {
    assert.match(entry, FORBIDDEN_ASAR_ENTRY);
  }
  for (const entry of ["dist-electron/main.cjs", "dist/assets/index-abc.js", "electron/native/grimodex-node/grimodex-node.node"]) {
    assert.doesNotMatch(entry, FORBIDDEN_ASAR_ENTRY);
  }
});

test("package の検査: seam のない実行可能な worker と harness の無い app.asar で合格", { skip: process.platform === "win32" }, async () => {
  const appDir = fakeApp({ asarTree: PRODUCT_TREE });
  const result = await checkPackage({ appDir, platform: "linux" });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.recorded.asar.entries, 3);
});

test("package の検査: worker に seam の文字列、実行権なし、不在、app.asar に harness の file があれば不合格", { skip: process.platform === "win32" }, async () => {
  const seam = await checkPackage({ appDir: fakeApp({ asarTree: PRODUCT_TREE, workerBytes: Buffer.from(`xx${GRAPH_WORKER_SEAM_MARKER}HOLD`) }), platform: "linux" });
  assert.equal(seam.ok, false);
  assert.match(seam.failures.join("\n"), /test seam/);
  const notExecutable = await checkPackage({ appDir: fakeApp({ asarTree: PRODUCT_TREE, executable: false }), platform: "linux" });
  assert.equal(notExecutable.ok, false);
  const absentDir = fakeApp({ asarTree: PRODUCT_TREE });
  fs.rmSync(path.join(resourcesDirOf(absentDir, "linux"), "bin", "nir1-c-query-worker"));
  assert.equal((await checkPackage({ appDir: absentDir, platform: "linux" })).ok, false);
  const harness = await checkPackage({
    appDir: fakeApp({ asarTree: { ...PRODUCT_TREE, electron: { files: { scripts: { files: { "packaged-smoke": { files: { "run.mjs": { size: 1, offset: "0" } } } } } } } } }),
    platform: "linux",
  });
  assert.equal(harness.ok, false);
  assert.match(harness.failures.join("\n"), /packaged-smoke/);
  const empty = await checkPackage({ appDir: fakeApp({ asarTree: {} }), platform: "linux" });
  assert.equal(empty.ok, false);
});

test("PE の subsystem を読む（記録だけ）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gps-pe-"));
  const file = path.join(dir, "x.exe");
  const buffer = Buffer.alloc(0x200);
  buffer.write("MZ", 0, "latin1");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "latin1");
  buffer.writeUInt16LE(3, 0x80 + 24 + 68);
  fs.writeFileSync(file, buffer);
  assert.deepEqual(peSubsystem(file), { value: 3, name: "windows-console" });
  fs.writeFileSync(file, Buffer.from("not a pe"));
  assert.equal(peSubsystem(file), null);
});

test("macOS の resources は bundle の Contents/Resources", () => {
  assert.equal(resourcesDirOf("/a/Grimodex.app", "darwin"), path.join("/a/Grimodex.app", "Contents", "Resources"));
  assert.equal(resourcesDirOf("/a/linux-unpacked", "linux"), path.join("/a/linux-unpacked", "resources"));
});

test("app.asar の中身に harness・probe の固有の文字列があれば不合格（chunk の境界をまたぐ一致も見る）", { skip: process.platform === "win32" }, async () => {
  const appDir = fakeApp({ asarTree: PRODUCT_TREE });
  const asar = path.join(resourcesDirOf(appDir, "linux"), "app.asar");
  assert.deepEqual(forbiddenContent(asar), []);
  // 1 MiB の境界をまたいで文字列を置く
  const filler = Buffer.alloc(1024 * 1024 - 5, 0x20);
  fs.appendFileSync(asar, Buffer.concat([filler, Buffer.from("x.dnsprobe.test/x")]));
  assert.deepEqual(forbiddenContent(asar), ["dnsprobe.test"]);
  const result = await checkPackage({ appDir, platform: "linux" });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /中身に harness／probe の文字列: dnsprobe\.test/);
  assert.ok(FORBIDDEN_ASAR_CONTENT.includes("webrtc-block-probe"));
});
