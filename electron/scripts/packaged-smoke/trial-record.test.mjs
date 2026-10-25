import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { formatVerdict, judgeOs, readOsRecords } from "./verdict.mjs";

// CP-2b P2 の Linux の試運転の記録（cp2b-decisions DR-CP2B-P2-9。G-pub の証跡ではない）を読み、判定の結果を実データで固定する。
// 判定の規則が変われば、この試験が記録との食い違いを示す（記録は手で書き換えない。採り直す）。
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const trialDir = path.join(repoRoot, "docs", "plans", "nir1-lane-decisions", "cp2b-p2-linux-trial", "linux");
const clone = (value) => JSON.parse(JSON.stringify(value));

test("記録の file は SHA256SUMS と一致し、raw の net log や userData を含まない", () => {
  const sums = fs.readFileSync(path.join(trialDir, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.split(/\s+/));
  const listed = sums.map(([, name]) => name).sort();
  const present = fs.readdirSync(trialDir).filter((name) => name !== "SHA256SUMS").sort();
  assert.deepEqual(listed, present);
  for (const [digest, name] of sums) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(trialDir, name))).digest("hex"), digest, name);
  }
  assert.deepEqual(present, ["baseline.json", "package-check.json", "packaged.json", "toolcheck.json", "verdict.json", "verdict.txt"]);
});

test("試運転の記録は (34) の判定を通り、verdict.json／verdict.txt は判定の再計算と一致する", () => {
  const records = readOsRecords(trialDir);
  const verdict = judgeOs(records);
  assert.deepEqual(verdict.gaps, []);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.status, "pass");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(trialDir, "verdict.json"), "utf8")), JSON.parse(JSON.stringify(verdict)));
  assert.equal(fs.readFileSync(path.join(trialDir, "verdict.txt"), "utf8"), formatVerdict("linux", verdict) + "\n");
});

test("試運転の記録の道具の対照: toolcheck の listener と net log の接続は TCP の行で食い違わず、正の対照が成立している", () => {
  const records = readOsRecords(trialDir);
  const verdict = judgeOs(records);
  assert.equal(verdict.sections.toolcheck.mismatched.length, 0);
  assert.ok(verdict.sections.toolcheck.observedRows > 0);
  assert.ok(verdict.sections.positive.netLog.observed > 0);
  assert.equal(records.toolcheck.nc1.listenerHits, records.toolcheck.netLog.ls1Connects);
  assert.equal(verdict.sections.matrix.missing.length + verdict.sections.matrix.extra.length, 0);
  assert.ok(verdict.sections.rj.byRegion.active > 0 && verdict.sections.rj.byRegion.canaryless > 0);
  // 記録は head に束縛される（GDX-TRACE-001）。3 構成が同じ head で採られている
  const heads = new Set([records.baseline, records.toolcheck, records.packaged].map((record) => record.environment.candidate.head));
  assert.equal(heads.size, 1);
  assert.match([...heads][0], /^[0-9a-f]{40}$/);
});

test("実データの変異: packaged の 1 行の canary 到達、TCP の行の LS-1 への接続 0、行の欠落は合格しない", () => {
  const records = readOsRecords(trialDir);
  const leak = clone(records);
  const tcpRow = leak.packaged.rows.find((row) => row.id === "main.turn-tcp.lo4");
  tcpRow.leaked = 1;
  leak.packaged.totals.canaryHits += 1;
  leak.packaged.totals.leakedProbes += 1;
  assert.equal(judgeOs(leak).status, "fail");
  const direct = clone(records);
  direct.packaged.rows.find((row) => row.id === "main.turn-tcp.lo4").proxied = 0;
  assert.equal(judgeOs(direct).status, "fail");
  const dropped = clone(records);
  dropped.packaged.rows = dropped.packaged.rows.filter((row) => row.id !== "main.turns.name");
  dropped.packaged.rendererRowIds = dropped.packaged.rendererRowIds.filter((id) => id !== "main.turns.name");
  assert.equal(judgeOs(dropped).status, "fail");
  // canary を置けない宛先（LAN）の TCP の行の LS-1 への接続 0 も不合格（security レビュー A）
  const lan = clone(records);
  const lanRow = lan.packaged.rows.find((row) => row.id === "main.turn-tcp.lan");
  assert.ok(lanRow && lanRow.proxied >= 1);
  lanRow.proxied = 0;
  assert.equal(judgeOs(lan).status, "fail");
  const name = clone(records);
  name.packaged.netLog.hostResolver.requestHosts["attacker.example"] = 1;
  assert.equal(judgeOs(name).status, "fail");
});
