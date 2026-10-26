import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { formatVerdict, judgeOs, readOsRecords } from "./verdict.mjs";

// CP-2b P4 の hosted の 3 OS の packaged smoke（G-pub、run 40256736959）の記録を読み、判定を再計算して保存した verdict と固定する。
// 記録は candidate の head に束縛される（PUB-G の最終候補では採り直す）。記録は手で書き換えない。
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const recordDir = path.join(repoRoot, "docs", "plans", "nir1-lane-decisions", "cp2b-g-pub");
const OSES = ["linux", "mac", "windows"];
const FILES = ["baseline.json", "package-check.json", "packaged.json", "toolcheck.json", "verdict.json", "verdict.txt"];
const clone = (value) => JSON.parse(JSON.stringify(value));

test("3 OS の記録の file は SHA256SUMS と一致し、raw の net log や userData を含まない", () => {
  for (const os of OSES) {
    const dir = path.join(recordDir, os);
    const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.split(/\s+/));
    const listed = sums.map(([, name]) => name).sort();
    const present = fs.readdirSync(dir).filter((name) => name !== "SHA256SUMS").sort();
    assert.deepEqual(listed, present, os);
    assert.deepEqual(present, FILES, os);
    for (const [digest, name] of sums) {
      assert.equal(createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"), digest, `${os}/${name}`);
    }
  }
});

test("3 OS とも (34) は pass で、verdict.json／verdict.txt は判定の再計算と一致する", () => {
  for (const os of OSES) {
    const dir = path.join(recordDir, os);
    const verdict = judgeOs(readOsRecords(dir));
    assert.deepEqual(verdict.gaps, [], os);
    assert.deepEqual(verdict.failures, [], os);
    assert.equal(verdict.status, "pass", os);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8")), JSON.parse(JSON.stringify(verdict)), os);
    assert.equal(fs.readFileSync(path.join(dir, "verdict.txt"), "utf8"), formatVerdict(os, verdict) + "\n", os);
  }
});

test("3 OS の記録は同じ candidate の head に束縛され、道具の対照と正の対照が成立している", () => {
  const heads = new Set();
  for (const os of OSES) {
    const records = readOsRecords(path.join(recordDir, os));
    const verdict = judgeOs(records);
    assert.equal(verdict.sections.toolcheck.mismatched.length, 0, os);
    assert.ok(verdict.sections.toolcheck.observedRows > 0, os);
    assert.ok(verdict.sections.positive.netLog.observed > 0, os);
    assert.equal(verdict.sections.matrix.missing.length + verdict.sections.matrix.extra.length, 0, os);
    for (const record of [records.baseline, records.toolcheck, records.packaged]) {
      assert.equal(record.environment.candidate.trackedDirty, false, os);
      heads.add(record.environment.candidate.head);
    }
  }
  assert.equal(heads.size, 1);
  assert.match([...heads][0], /^[0-9a-f]{40}$/);
});

test("記録に絶対 path、hostname、利用者名、LAN の IP、MAC、token が無い", () => {
  const forbidden = [
    ["posix の絶対 path", /(?:\/home\/|\/Users\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|\/runner\/)/],
    ["Windows の絶対 path", /[A-Za-z]:\\/],
    ["runner の利用者名", /runneradmin|runner@|\/home\/runner|vsts/i],
    ["hostname", /fv-az|\bWIN-[0-9A-Z]{6}|\bMac-[0-9A-F]{8}|\bAZ-?[A-Z0-9]*\.internal\.cloudapp\.net/],
    ["MAC", /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i],
    ["token", /ghp_|gho_|ghs_|github_pat_|sk-ant|xox[bap]-|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{16,}/],
  ];
  for (const os of OSES) {
    const dir = path.join(recordDir, os);
    for (const name of FILES) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      for (const [label, pattern] of forbidden) assert.doesNotMatch(text, pattern, `${os}/${name}: ${label}`);
      // IPv4 は loopback（127.0.0.0/8）だけ。LAN の宛先は <lan> に伏せてある
      for (const ip of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []) {
        assert.ok(ip.startsWith("127."), `${os}/${name}: ${ip}`);
      }
    }
  }
});

test("実データの変異: 記録の proxied を 0、verdict.json の結論の書き換えは判定の食い違いとして検出される", () => {
  for (const os of OSES) {
    const dir = path.join(recordDir, os);
    const records = readOsRecords(dir);
    const direct = clone(records);
    const tcpRow = direct.packaged.rows.find((row) => /^main\.turn-tcp\./.test(row.id) && row.proxied >= 1);
    assert.ok(tcpRow, os);
    tcpRow.proxied = 0;
    assert.equal(judgeOs(direct).status, "fail", os);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
    stored.status = "fail";
    assert.notDeepEqual(stored, JSON.parse(JSON.stringify(judgeOs(records))), os);
  }
});
