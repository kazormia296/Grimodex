// 実測定の cell の宛先の判定の試験（F2 の R3）。許可リストは試験用の文書用の範囲（RFC 5737・3849）を使い、
// 実際の Anthropic の範囲はこの道具に持たない（人が --egress-allow で渡す）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEgressPolicy,
  classifyDestination,
  cidrContains,
  createEgressSampler,
  parseCidr,
  parseIp,
  splitList,
} from "./egress-policy.mjs";
import { realCellStatus } from "./run-measure-b.mjs";
import { isLoopbackOrAny, parseHexAddress } from "./run-inventory.mjs";
import {
  EGRESS_OBSERVATION_MAX_AGE_MS,
  assessEgressObservation,
} from "./measure-b-core.mjs";

const ALLOW = ["198.51.100.0/24", "2001:db8:abcd::/48"];
const policy = buildEgressPolicy({ allowCidrs: ALLOW });

test("許可リストは明示の入力で、無い・空・不正・広すぎる・私的な範囲なら本測定を始めない", () => {
  assert.throws(
    () => buildEgressPolicy({ allowCidrs: [] }),
    /EGRESS_ALLOWLIST_REQUIRED/u,
  );
  assert.throws(() => buildEgressPolicy({}), /EGRESS_ALLOWLIST_REQUIRED/u);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList(" a , b,,"), ["a", "b"]);
  for (const bad of [
    "not-a-cidr",
    "198.51.100.0",
    "198.51.100.0/33",
    "999.0.0.0/24",
    "198.51.100.0/24/1",
    "2001:db8::/129",
    "198.51.100.0/-1",
  ])
    assert.throws(
      () => buildEgressPolicy({ allowCidrs: [bad] }),
      /EGRESS_ALLOWLIST_INVALID/u,
      bad,
    );
  for (const wide of [
    "0.0.0.0/0",
    "198.0.0.0/8",
    "198.51.0.0/15",
    "::/0",
    "2001::/16",
  ])
    assert.throws(
      () => buildEgressPolicy({ allowCidrs: [wide] }),
      /EGRESS_ALLOWLIST_(TOO_WIDE|PRIVATE)/u,
      wide,
    );
  for (const priv of [
    "10.1.0.0/16",
    "172.16.4.0/24",
    "192.168.1.0/24",
    "127.0.0.0/16",
    "169.254.0.0/16",
    "100.64.0.0/16",
    "fc00::/32",
    "fe80::/32",
  ])
    assert.throws(
      () => buildEgressPolicy({ allowCidrs: [priv] }),
      /EGRESS_ALLOWLIST_PRIVATE/u,
      priv,
    );
  assert.throws(
    () => buildEgressPolicy({ allowCidrs: ALLOW, resolverIps: ["x"] }),
    /EGRESS_RESOLVER_INVALID/u,
  );
  assert.equal(policy.describe.allowCidrCount, 2);
});

test("CIDR と IP の解釈：IPv4・IPv6（省略形・IPv4-mapped）", () => {
  assert.equal(parseIp("198.51.100.7").family, 4);
  assert.equal(parseIp("2001:db8:abcd:1::7").family, 6);
  // /proc/net の IPv6 の形（0 埋めなし・16 進）と IPv4-mapped。
  assert.equal(
    parseIp("0:0:0:0:0:ffff:c633:6407").value,
    parseIp("198.51.100.7").value,
  );
  assert.equal(parseIp("::ffff:198.51.100.7").family, 4);
  assert.equal(parseIp("zzz"), null);
  assert.equal(parseIp("1:2:3"), null);
  assert.equal(parseIp(":::"), null);
  const cidr = parseCidr("198.51.100.0/24");
  assert.ok(cidrContains(cidr, parseIp("198.51.100.255")));
  assert.ok(!cidrContains(cidr, parseIp("198.51.101.0")));
  assert.ok(!cidrContains(cidr, parseIp("2001:db8:abcd::1"))); // 族が違う
  assert.equal(parseCidr("::ffff:198.51.100.0/120"), null);
});

test("宛先の判定：許可リストの tcp 443 だけ anthropic。port・protocol が違う、範囲の外、読めない形は許可しない", () => {
  const cls = (d) => classifyDestination(d, policy);
  assert.equal(cls("tcp 198.51.100.7:443"), "anthropic");
  assert.equal(cls("tcp 2001:db8:abcd:1:0:0:0:7:443"), "anthropic");
  assert.equal(cls("tcp 0:0:0:0:0:ffff:c633:6407:443"), "anthropic"); // IPv4-mapped
  assert.equal(cls("tcp 198.51.100.7:80"), "disallowed");
  assert.equal(cls("udp 198.51.100.7:443"), "disallowed");
  assert.equal(cls("tcp 203.0.113.5:443"), "disallowed");
  assert.equal(cls("tcp 2001:db8:abce::1:443"), "disallowed");
  assert.equal(cls("garbage"), "disallowed");
  assert.equal(cls("tcp 198.51.100.7:99999"), "disallowed");
  // policy なし（A・乾いた実行）は loopback 以外をすべて許可しない。
  assert.equal(classifyDestination("tcp 198.51.100.7:443", null), "disallowed");
});

test("名前解決の resolver は、明示したときだけ port 53 を許す（既定は不採用）", () => {
  const withResolver = buildEgressPolicy({
    allowCidrs: ALLOW,
    resolverIps: ["203.0.113.53"],
  });
  assert.equal(
    classifyDestination("udp 203.0.113.53:53", withResolver),
    "resolver",
  );
  assert.equal(
    classifyDestination("tcp 203.0.113.53:53", withResolver),
    "resolver",
  );
  assert.equal(
    classifyDestination("tcp 203.0.113.53:443", withResolver),
    "disallowed",
  );
  assert.equal(
    classifyDestination("udp 203.0.113.54:53", withResolver),
    "disallowed",
  );
  assert.equal(
    classifyDestination("udp 203.0.113.53:53", policy),
    "disallowed",
  );
});

test("標本：許可リスト以外が出たら violations に残る。採取の失敗は成功に数えない", () => {
  const seen = [];
  const sampler = createEgressSampler({
    rootPid: 1,
    policy,
    sample: (pid, destinations) => {
      for (const d of seen) destinations.add(d);
      return { tablesRead: 4, socketCount: seen.length };
    },
  });
  sampler.tick();
  assert.deepEqual(sampler.violations(), []);
  seen.push("tcp 198.51.100.7:443");
  sampler.tick();
  assert.deepEqual(sampler.violations(), []);
  assert.equal(sampler.snapshot().anthropicDestinationCount, 1);
  seen.push("tcp 203.0.113.5:443", "udp 203.0.113.9:53");
  sampler.tick();
  assert.deepEqual(sampler.violations(), [
    "tcp 203.0.113.5:443",
    "udp 203.0.113.9:53",
  ]);
  const snap = sampler.snapshot();
  assert.equal(snap.sampleCount, 3);
  assert.equal(snap.sampleFailures, 0);
  assert.equal(snap.policyApplied, true);
  assert.equal(snap.nonLoopbackDestinationCount, 3);
  assert.deepEqual(snap.disallowedDestinations, [
    "tcp 203.0.113.5:443",
    "udp 203.0.113.9:53",
  ]);
  // 採取が 1 度も成り立たない（表が読めない・例外）cell は標本 0 のまま。
  const failing = createEgressSampler({
    rootPid: 1,
    policy,
    sample: () => ({ tablesRead: 0, socketCount: 0 }),
  });
  failing.tick();
  const throwing = createEgressSampler({
    rootPid: 1,
    policy,
    sample: () => {
      throw new Error("x");
    },
  });
  throwing.tick();
  for (const s of [failing, throwing]) {
    assert.equal(s.snapshot().sampleCount, 0);
    assert.equal(s.snapshot().sampleFailures, 1);
  }
});

test("標本から cell の採否まで：Anthropic への接続だけなら採用、許可リスト以外が 1 つでもあれば不採用、標本が 0 なら確かめられない", () => {
  const cellOf = (destinations, tablesRead = 4) => {
    const sampler = createEgressSampler({
      rootPid: 1,
      policy,
      sample: (pid, set) => {
        for (const d of destinations) set.add(d);
        return { tablesRead, socketCount: 1 };
      },
    });
    sampler.tick();
    return {
      ipc: { commandNames: [], commandCounts: { send_chat_message: 1 } },
      egress: sampler.snapshot(),
      buildProvenance: { head: "a".repeat(40), stableAfterCell: true },
    };
  };
  const value = { requestsSent: 1 };
  assert.equal(realCellStatus(cellOf(["tcp 198.51.100.7:443"]), value), "ok");
  assert.equal(realCellStatus(cellOf([]), value), "ok");
  assert.equal(
    realCellStatus(
      cellOf(["tcp 198.51.100.7:443", "tcp 203.0.113.5:443"]),
      value,
    ),
    "egress-detected",
  );
  assert.equal(realCellStatus(cellOf([], 0), value), "egress-unverified");
});

test("標本の観測（F3a の B1）：直近の tick の成否・時刻・socket の数を持ち、結果が無い・形が違うのは成功に数えない", () => {
  let clock = 1_000;
  const outcomes = [];
  const sampler = createEgressSampler({
    rootPid: 1,
    policy,
    now: () => clock,
    sample: () => outcomes.shift(),
  });
  // まだ tick していない：何も見ていない。
  assert.deepEqual(sampler.observation(), {
    violations: [],
    sampleCount: 0,
    lastTickOk: false,
    lastSocketCount: null,
    ageMs: null,
  });
  outcomes.push({ tablesRead: 4, socketCount: 7 });
  sampler.tick();
  clock = 1_400;
  assert.deepEqual(sampler.observation(), {
    violations: [],
    sampleCount: 1,
    lastTickOk: true,
    lastSocketCount: 7,
    ageMs: 400,
  });
  // 結果が無い（undefined）・tablesRead が整数でない・形が違うものは、成功に数えない。
  for (const bad of [
    undefined,
    null,
    {},
    { tablesRead: "4", socketCount: 1 },
  ]) {
    outcomes.push(bad);
    sampler.tick();
    assert.equal(sampler.observation().lastTickOk, false, JSON.stringify(bad));
  }
  assert.equal(sampler.snapshot().sampleCount, 1);
  assert.equal(sampler.snapshot().sampleFailures, 4);
  // 直近の tick が socket を 1 つも見ていない（成功でも 0）。cell 全体で見えた最大は snapshot に残る。
  outcomes.push({ tablesRead: 4, socketCount: 0 });
  sampler.tick();
  assert.equal(sampler.observation().lastSocketCount, 0);
  assert.equal(sampler.snapshot().socketCountMax, 7);
  // 例外は失敗。
  const thrown = createEgressSampler({
    rootPid: 1,
    policy,
    sample: () => {
      throw new Error("x");
    },
  });
  thrown.tick();
  assert.equal(thrown.observation().lastTickOk, false);
  assert.equal(thrown.observation().sampleCount, 0);
});

test("観測の評価（assessEgressObservation）：違反が無いだけでは通さない。標本・直近の tick・socket・古さのどれかが欠ければ止める", () => {
  const good = {
    violations: [],
    sampleCount: 3,
    lastTickOk: true,
    lastSocketCount: 5,
    ageMs: 10,
  };
  assert.equal(assessEgressObservation(good), null);
  for (const [override, code] of [
    [{ violations: ["tcp 203.0.113.5:443"] }, "EGRESS_NOT_ALLOWED"],
    [{ violations: undefined }, "EGRESS_UNDECIDABLE"],
    [{ sampleCount: 0 }, "EGRESS_UNOBSERVED"],
    [{ sampleCount: undefined }, "EGRESS_UNOBSERVED"],
    [{ lastTickOk: false }, "EGRESS_SAMPLE_FAILED"],
    [{ lastTickOk: undefined }, "EGRESS_SAMPLE_FAILED"],
    [{ lastSocketCount: 0 }, "EGRESS_NO_SOCKETS"],
    [{ lastSocketCount: null }, "EGRESS_NO_SOCKETS"],
    [{ ageMs: EGRESS_OBSERVATION_MAX_AGE_MS + 1 }, "EGRESS_STALE"],
    [{ ageMs: null }, "EGRESS_STALE"],
    [{ ageMs: -1 }, "EGRESS_STALE"],
  ])
    assert.equal(assessEgressObservation({ ...good, ...override }), code);
  assert.equal(assessEgressObservation(undefined), "EGRESS_UNDECIDABLE");
  assert.equal(assessEgressObservation("x"), "EGRESS_UNDECIDABLE");
  assert.equal(
    assessEgressObservation({ ...good, ageMs: EGRESS_OBSERVATION_MAX_AGE_MS }),
    null,
  );
});

test("loopback の判定は IP を解析する（前方一致で 0.127.x.x を loopback に数えない。F3a の m4）", () => {
  for (const ip of [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:0:0:0",
    "::1",
    "::",
    "0:0:0:0:0:ffff:7f00:1", // ::ffff:127.0.0.1
    "0:0:0:0:0:ffff:7fff:ffff",
    "0:0:0:0:0:ffff:0:0", // ::ffff:0.0.0.0
  ])
    assert.equal(isLoopbackOrAny(ip), true, ip);
  for (const ip of [
    "0:0:0:0:0:ffff:7f:1", // ::ffff:0.127.0.1（前方一致だと loopback に見える）
    "0:0:0:0:0:ffff:7:1",
    "0:0:0:0:0:ffff:c633:6407", // ::ffff:198.51.100.7
    "128.0.0.1",
    "126.255.255.255",
    "198.51.100.7",
    "2001:db8:abcd:0:0:0:0:1",
    "0:0:0:0:0:0:0:2",
    "not-an-ip",
    "",
  ])
    assert.equal(isLoopbackOrAny(ip), false, ip);
  // /proc/net の little endian の 16 進から、実際に宛先として数えるかまで（::ffff:0.127.0.1 は宛先になる）。
  const hexIp = (hex) => parseHexAddress(`${hex}:01BB`, true).ip;
  assert.equal(
    isLoopbackOrAny(hexIp("0000000000000000FFFF00000100007F")),
    true,
  ); // ::ffff:127.0.0.1
  assert.equal(
    isLoopbackOrAny(hexIp("0000000000000000FFFF000001007F00")),
    false,
  ); // ::ffff:0.127.0.1
  assert.equal(
    isLoopbackOrAny(hexIp("00000000000000000000000001000000")),
    true,
  ); // ::1
  assert.deepEqual(parseHexAddress("0100007F:01BB", false), {
    ip: "127.0.0.1",
    port: 443,
  });
});
