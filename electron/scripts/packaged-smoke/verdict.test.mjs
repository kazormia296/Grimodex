import assert from "node:assert/strict";
import test from "node:test";

import { judgeRecord } from "../webrtc-block-probe-verdict.mjs";
import { MATRIX_FLAGS, formatVerdict, judgeMatrix, judgeOs } from "./verdict.mjs";

// 合成の記録（K3/3 の RJ・NL・`.local` の規則と、DR-CP2B-P2-4 の (a)〜(g) だけを試す。実機の記録ではない）。
// 合格する 1 組を作り、各変異で合格しなくなることを確かめる（判定が緩むと落ちる）。
const clone = (value) => JSON.parse(JSON.stringify(value));
const n = "<n>";

function renderer(rows) {
  return rows.map(([id, outcome, extra = {}]) => ({ id, outcome, leaked: 0, leakDetail: {}, proxied: 0, ...extra }));
}

function base(config, rows, extra = {}) {
  return {
    label: `synthetic-${config}`,
    config,
    matrixFlags: { ...MATRIX_FLAGS },
    canaries: [{ label: "p-127.0.0.1", bound: true }, { label: "r-127.0.0.2", bound: true }],
    lifecycle: { ok: true },
    rows,
    rendererRowIds: rows.filter((row) => !row.id.startsWith("main.node-fetch")).map((row) => row.id),
    totals: { leakedProbes: rows.filter((row) => row.leaked > 0).length, probes: rows.length, canaryHits: rows.reduce((s, row) => s + row.leaked, 0), unattributed: 0 },
    mdns: { joined: true, nonceBearing: rows.reduce((s, row) => s + (row.mdnsQueries ?? 0), 0) },
    ...extra,
  };
}

function passingSet() {
  const baseline = base("baseline", [
    ...renderer([
      ["control.same-origin-fetch", "status:200"],
      ["main.turn-tcp.lo4", "gathering:gathering", { leaked: 2 }],
      ["main.stun.lo4", "gathering:gathering", { leaked: 1 }],
      ["main.stun.name", "gathering:complete", { dohNames: [`stunname-${n}.probe.test/1`] }],
      ["main.turn-udp.name", "gathering:complete", { dohNames: [`turnudpname-${n}.probe.test/1`] }],
      ["main.turn-tcp.name", "gathering:complete", { dohNames: [`turntcpname-${n}.probe.test/1`] }],
      ["main.turns.name", "gathering:complete", { dohNames: [`turnsname-${n}.probe.test/1`] }],
      ["dns.dns-prefetch", "link:dns-prefetch", { dohNames: [`dnsdnsprefetch-${n}.dnsprobe.test/1`] }],
      ["main.turn-tcp.lo6", "gathering:complete"],
      ["local-name.dns-prefetch", "link:dns-prefetch", { mdnsQueries: 2 }],
    ]),
    ...renderer([["main.node-fetch", "200"]]),
  ], {
    doh: { started: true, error: null },
    netLog: { error: null, ls1Ports: [], ls1Port: null, hostResolver: { requestHosts: { [`stunname-${n}.probe.test`]: 1 }, jobHosts: {}, nonceBearing: 5 } },
  });
  // mainSide の行（main.node-fetch）は renderer の行列の外（rendererRowIds に入れない）
  baseline.rendererRowIds = baseline.rows.filter((row) => row.id !== "main.node-fetch").map((row) => row.id);
  const packagedRows = renderer([
    ["control.same-origin-fetch", "status:200"],
    ["main.turn-tcp.lo4", "gathering:gathering", { proxied: 1 }],
    ["main.stun.lo4", "gathering:complete"],
    ["main.stun.name", "gathering:complete"],
    ["main.turn-udp.name", "gathering:complete"],
    ["main.turn-tcp.name", "gathering:gathering", { proxied: 1 }],
    ["main.turns.name", "gathering:gathering", { proxied: 2 }],
    ["dns.dns-prefetch", "link:dns-prefetch"],
    ["main.turn-tcp.lo6", "gathering:complete"],
    ["local-name.dns-prefetch", "link:dns-prefetch", { mdnsQueries: 0 }],
  ]);
  const packaged = base("packaged", packagedRows, {
    cdp: { injected: true, launchToTargetMs: 600 },
    pageShims: ["form-submit-shim"],
    netLog: {
      error: null, ls1Ports: [40000], ls1Port: 40000,
      hostResolver: { requestHosts: { "127.0.0.1": 3, "~notfound": 4, "github.com": 1 }, jobHosts: { "~notfound": 4 }, nonceBearing: 0 },
      nc1NetworkPhase: { lowerBoundMs: 4 },
    },
  });
  const toolcheckRows = renderer([
    ["control.same-origin-fetch", "status:200"],
    ["main.turn-tcp.lo4", "gathering:gathering", { proxied: 1, proxiedListener: 1, proxiedNetLog: 1 }],
    ["main.turn-tcp.name", "gathering:gathering", { proxied: 1, proxiedListener: 1, proxiedNetLog: 1 }],
    ["main.turns.name", "gathering:gathering", { proxied: 2, proxiedListener: 2, proxiedNetLog: 2 }],
    ["main.turn-tcp.lo6", "gathering:complete", { proxiedListener: 0, proxiedNetLog: 0 }],
  ]);
  const toolcheck = base("toolcheck", toolcheckRows, {
    nc1: { startOk: true, listenerPort: 40001, failures: [] },
    netLog: { error: null, ls1Ports: [40001], ls1Port: 40001, hostResolver: { requestHosts: {}, jobHosts: {}, nonceBearing: 0 } },
  });
  return { baseline, toolcheck, packaged, packageCheck: { ok: true, failures: [], recorded: {} } };
}

const statusOf = (set) => judgeOs(set).status;
const rowOf = (record, id) => record.rows.find((row) => row.id === id);

test("合成の 1 組は (34) の判定を通る（正の対照・道具の対照・行列・RJ・NL・.local・package）", () => {
  const set = passingSet();
  const verdict = judgeOs(set);
  assert.deepEqual(verdict.gaps, []);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.sections.local.status, "pass");
  assert.equal(verdict.sections.rj.byRegion.inert, 1);
  assert.match(formatVerdict("linux", verdict), /== \(34\) linux: pass/);
});

// ── 判定の不合格（finding）──────────────────────────────────────────────

test("packaged の行が canary に届けば不合格", () => {
  const set = passingSet();
  Object.assign(rowOf(set.packaged, "main.turn-tcp.name"), { leaked: 1 });
  set.packaged.totals.canaryHits = 1;
  set.packaged.totals.leakedProbes = 1;
  assert.equal(statusOf(set), "fail");
});

test("TCP の行で LS-1 への接続が 0 なら、canary 0 でも不合格", () => {
  const set = passingSet();
  rowOf(set.packaged, "main.turns.name").proxied = 0;
  assert.equal(statusOf(set), "fail");
});

test("UDP の行で ICE が進行していれば不合格", () => {
  const set = passingSet();
  rowOf(set.packaged, "main.stun.lo4").outcome = "gathering:gathering";
  assert.equal(statusOf(set), "fail");
});

test("packaged に baseline の行が欠けると不合格（RJ だけでは見逃す）", () => {
  const set = passingSet();
  set.packaged.rows = set.packaged.rows.filter((row) => row.id !== "main.turns.name");
  set.packaged.rendererRowIds = set.packaged.rendererRowIds.filter((id) => id !== "main.turns.name");
  // RJ（judgeRecord）は対照にある行の欠落を見ない
  const rj = judgeRecord(set.packaged, { baseline: set.baseline });
  assert.equal(rj.fail + rj.recordFailures.length, 0);
  assert.equal(judgeMatrix(set.packaged, set.baseline).ok, false);
  assert.equal(statusOf(set), "fail");
});

test("baseline に無い行が packaged にあれば不合格", () => {
  const set = passingSet();
  set.packaged.rows.push({ id: "main.stuns.name", outcome: "gathering:complete", leaked: 0, proxied: 0 });
  set.packaged.rendererRowIds.push("main.stuns.name");
  assert.equal(statusOf(set), "fail");
});

test("NL: 許容集合の外の host、nonce を含む生の host があれば不合格", () => {
  const outside = passingSet();
  outside.packaged.netLog.hostResolver.requestHosts["example.org"] = 1;
  assert.equal(statusOf(outside), "fail");
  const nonce = passingSet();
  nonce.packaged.netLog.hostResolver.nonceBearing = 1;
  assert.equal(statusOf(nonce), "fail");
  const lan = passingSet();
  lan.packaged.netLog.hostResolver.jobHosts["127.0.0.2"] = 1; // EXCLUDE していない IP literal
  assert.equal(statusOf(lan), "fail");
});

test("記録全体の必要条件: どの行にも帰属しない canary 到達があれば不合格", () => {
  const set = passingSet();
  set.packaged.totals.unattributed = 1;
  set.packaged.totals.canaryHits = 1;
  assert.equal(statusOf(set), "fail");
});

test("不活性の行でも canary に届けば不合格（不活性に逃がさない）", () => {
  const set = passingSet();
  Object.assign(rowOf(set.packaged, "main.turn-tcp.lo6"), { leaked: 1 });
  set.packaged.totals.canaryHits = 1;
  set.packaged.totals.leakedProbes = 1;
  assert.equal(statusOf(set), "fail");
});

test(".local: 対照で観測できた問合せが packaged で 1 件でもあれば不合格。対照が取れなければ unverified で合否に含めない", () => {
  const leak = passingSet();
  rowOf(leak.packaged, "local-name.dns-prefetch").mdnsQueries = 1;
  leak.packaged.mdns.nonceBearing = 1;
  assert.equal(statusOf(leak), "fail");
  const unobservable = passingSet();
  unobservable.baseline.mdns = { joined: false, error: "EADDRINUSE", nonceBearing: 0 };
  const verdict = judgeOs(unobservable);
  assert.equal(verdict.sections.local.status, "unverified");
  assert.equal(verdict.status, "pass");
});

test("package の検査が不合格なら不合格", () => {
  const set = passingSet();
  set.packageCheck = { ok: false, failures: ["worker: graph worker carries the test seam"] };
  assert.equal(statusOf(set), "fail");
  const missing = passingSet();
  missing.packageCheck = null;
  assert.equal(statusOf(missing), "fail");
});

// ── 観測の道具なし（その OS は (34) 不通過。合格にしない）───────────────────

const NO_TOOL_MUTATIONS = {
  "CDP の注入ができない": (set) => { set.packaged.cdp.injected = false; },
  "packaged の子 process の終了の証拠がない": (set) => { set.packaged.lifecycle = { ok: false, residual: [123] }; },
  "toolcheck の終了の証拠がない": (set) => { set.toolcheck.lifecycle = { ok: false }; },
  "LS-1 の port が 2 つ": (set) => { set.packaged.netLog.ls1Ports = [40000, 40002]; set.packaged.netLog.ls1Port = null; },
  "net log が読めない": (set) => { set.packaged.netLog = { error: "parse" }; },
  "攻撃 JS の flag が違う": (set) => { set.packaged.matrixFlags = { ...MATRIX_FLAGS, local: false }; },
  "攻撃 JS の flag が余る": (set) => { set.baseline.matrixFlags = { ...MATRIX_FLAGS, fqdn: true }; },
  "totals.unattributed がない": (set) => { delete set.packaged.totals.unattributed; },
  "baseline の DoH の canary を起動できない": (set) => { set.baseline.doh = { started: false, error: "openssl" }; },
  "toolcheck の listener と net log が食い違う": (set) => { rowOf(set.toolcheck, "main.turns.name").proxiedNetLog = 0; },
  "toolcheck の net log の port が Main の listener と違う": (set) => { set.toolcheck.nc1.listenerPort = 1; },
  "toolcheck の照合が空": (set) => { for (const row of set.toolcheck.rows) { row.proxiedListener = 0; row.proxiedNetLog = 0; } },
  "toolcheck の NC-1 の start が失敗": (set) => { set.toolcheck.nc1.startOk = false; },
  "正の対照: IP literal の行が canary に届かない": (set) => { rowOf(set.baseline, "main.stun.lo4").leaked = 0; },
  "正の対照: net log に攻撃者の名前が出ない": (set) => { set.baseline.netLog.hostResolver.nonceBearing = 0; },
  "正の対照: DoH の canary に STUN の名前が出ない": (set) => { rowOf(set.baseline, "main.stun.name").dohNames = []; },
  "baseline の記録がない": (set) => { set.baseline = null; },
  "packaged の net log の host resolver の観測がない": (set) => { set.packaged.netLog.hostResolver = null; },
};

for (const [name, mutate] of Object.entries(NO_TOOL_MUTATIONS)) {
  test(`観測の道具なし: ${name}`, () => {
    const set = passingSet();
    mutate(set);
    const verdict = judgeOs(set);
    assert.equal(verdict.status, "no-observation-tool", JSON.stringify(verdict.failures));
    assert.ok(verdict.gaps.length > 0);
    assert.equal(verdict.pass, false);
  });
}

test("bind できない canary の宛先の行は区分つきで列挙される（黙って落とさない）", () => {
  const set = passingSet();
  set.packaged.canaries = [{ label: "r-127.0.0.2", bound: false, error: "EADDRNOTAVAIL" }];
  for (const record of [set.baseline, set.packaged]) {
    record.rows.push({ id: "main.turn-tcp.lo4b", outcome: "gathering:gathering", leaked: 0, proxied: record === set.packaged ? 1 : 0 });
    record.rendererRowIds.push("main.turn-tcp.lo4b");
  }
  const verdict = judgeOs(set);
  assert.equal(verdict.status, "pass");
  assert.deepEqual(verdict.recorded.unboundCanaries[0].rows, [{ id: "main.turn-tcp.lo4b", verdict: "pass", region: "canaryless" }]);
  assert.match(formatVerdict("mac", verdict), /bind できない canary r-127\.0\.0\.2/);
});
