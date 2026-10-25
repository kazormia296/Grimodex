import assert from "node:assert/strict";
import test from "node:test";

import { listeningPids, pgrpFromStat, verifyCdpPortOwner } from "./port-owner.mjs";

const owner = { pid: 100, pgid: 100, exeDir: "/opt/app" };

test("Linux: listen している pid の process group が owner と同じときだけ owned", () => {
  const exec = () => 'LISTEN 0 10 127.0.0.1:9222 0.0.0.0:* users:(("grimodex",pid=101,fd=40))';
  const stat = (pgrp) => () => `101 (grimodex (x)) S 100 ${pgrp} ${pgrp} 0`;
  assert.equal(verifyCdpPortOwner({ port: 9222, owner, platform: "linux", exec, readStat: stat(100) }).owned, true);
  const other = verifyCdpPortOwner({ port: 9222, owner, platform: "linux", exec, readStat: stat(555) });
  assert.equal(other.owned, false);
  assert.match(other.reason, /process group/);
  assert.equal(verifyCdpPortOwner({ port: 9222, owner, platform: "linux", exec: () => "", readStat: stat(100) }).owned, false);
  assert.equal(verifyCdpPortOwner({ port: 9222, owner, platform: "linux", exec: () => { throw new Error("no ss"); } }).owned, false);
  assert.equal(pgrpFromStat("7 (a b) c) S 1 42 42 0"), 42);
});

test("macOS: lsof の pid の pgid、Windows: OwningProcess が owner の pid か実行体が owner の dir の下", () => {
  const mac = (pgid) => (command) => (command === "lsof" ? "101\n" : ` ${pgid}\n`);
  assert.equal(verifyCdpPortOwner({ port: 1, owner, platform: "darwin", exec: mac(100) }).owned, true);
  assert.equal(verifyCdpPortOwner({ port: 1, owner, platform: "darwin", exec: mac(7) }).owned, false);
  const win = (pid, exe) => (_command, args) => (String(args.at(-1)).startsWith("Get-NetTCPConnection") ? `${pid}\r\n` : `${exe}\r\n`);
  const winOwner = { pid: 100, pgid: null, exeDir: "C:\\a\\win-unpacked" };
  assert.equal(verifyCdpPortOwner({ port: 1, owner: winOwner, platform: "win32", exec: win(100, "") }).owned, true);
  if (process.platform === "win32") {
    assert.equal(verifyCdpPortOwner({ port: 1, owner: winOwner, platform: "win32", exec: win(5, "C:\\a\\win-unpacked\\Grimodex.exe") }).owned, true);
  }
  assert.equal(verifyCdpPortOwner({ port: 1, owner: winOwner, platform: "win32", exec: win(5, "C:\\Users\\u\\Grimodex.exe") }).owned, false);
  assert.deepEqual(listeningPids(1, "freebsd", () => ""), []);
});
