// 実測定の cell の宛先の判定（F2 の R3）。
//
// 乾いた実行は、loopback 以外の宛先が 1 つでもあれば cell を不採用にする（run-measure-b.mjs の dryCellStatus）。
// 実測定は Anthropic へ送るので、同じ基準を「許可リスト以外」に適用する：宛先が許可リスト（loopback と、人が明示した
// Anthropic の範囲）に入らなければ cell を不採用にし、以後の送信を止める。
//
// - 許可リストは明示の入力（--egress-allow <CIDR,...>）で、未指定なら本測定を始めない。この道具は Anthropic の IP 範囲を
//   持たない（記憶から書かない。実際の宛先は試走の記録で確かめ、人が渡す）。
// - 許可は tcp の 443 だけ。名前解決の resolver が loopback でなければ --egress-resolver で明示する（既定は不採用）。
// - 広すぎる範囲（IPv4 は /16 より広い、IPv6 は /32 より広い）と、私的・loopback・link-local の範囲は許可リストに入れない。
// 標本は 250 ms ごと（launcher-common.mjs）で、それより短い接続は見えない（open）。
import assert from "node:assert/strict";

const V4_MIN_PREFIX = 16;
const V6_MIN_PREFIX = 32;

function parseV4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.reduce((acc, n) => (acc << 8n) | BigInt(n), 0n);
}

/** IPv6（"::" の省略を含む。zone id は不可）を 128 bit の BigInt に。 */
function parseV6(text) {
  if (!/^[0-9a-fA-F:.]+$/u.test(text) || !text.includes(":")) return null;
  let head = text;
  let tail = "";
  const gap = text.indexOf("::");
  if (gap >= 0) {
    if (text.indexOf("::", gap + 1) >= 0) return null;
    head = text.slice(0, gap);
    tail = text.slice(gap + 2);
  }
  const split = (part) => (part === "" ? [] : part.split(":"));
  const toWords = (groups) => {
    const out = [];
    for (const [i, group] of groups.entries()) {
      if (group.includes(".")) {
        if (i !== groups.length - 1) return null;
        const v4 = parseV4(group);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
        out.push(Number.parseInt(group, 16));
      }
    }
    return out;
  };
  const headWords = toWords(split(head));
  const tailWords = toWords(split(tail));
  if (!headWords || !tailWords) return null;
  const missing = 8 - headWords.length - tailWords.length;
  if (gap >= 0 ? missing < 1 : missing !== 0) return null;
  const words = [
    ...headWords,
    ...Array(gap >= 0 ? missing : 0).fill(0),
    ...tailWords,
  ];
  return words.reduce((acc, w) => (acc << 16n) | BigInt(w), 0n);
}

/** { family, value, bits } か null。IPv4-mapped IPv6（::ffff:a.b.c.d）は IPv4 に直す。 */
export function parseIp(text) {
  const t = String(text).trim();
  const v4 = parseV4(t);
  if (v4 !== null) return { family: 4, value: v4, bits: 32 };
  const v6 = parseV6(t);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn)
    return { family: 4, value: v6 & 0xffffffffn, bits: 32 };
  return { family: 6, value: v6, bits: 128 };
}

export function parseCidr(text) {
  const [addr, prefixText, ...rest] = String(text).trim().split("/");
  if (
    rest.length > 0 ||
    prefixText === undefined ||
    !/^\d{1,3}$/u.test(prefixText)
  )
    return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  // IPv4-mapped の表記の CIDR は扱わない（混乱のもと）。
  if (ip.family === 4 && addr.includes(":")) return null;
  const prefix = Number(prefixText);
  if (prefix > ip.bits) return null;
  const hostBits = BigInt(ip.bits - prefix);
  const mask = ((1n << BigInt(ip.bits)) - 1n) ^ ((1n << hostBits) - 1n);
  return {
    family: ip.family,
    prefix,
    bits: ip.bits,
    base: ip.value & mask,
    mask,
  };
}

export function cidrContains(cidr, ip) {
  return ip.family === cidr.family && (ip.value & cidr.mask) === cidr.base;
}

/** 許可リストに入れてはならない範囲（私的・loopback・link-local・未指定・CGNAT）。 */
const FORBIDDEN_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map(parseCidr);

function overlaps(a, b) {
  return (
    a.family === b.family &&
    ((a.base & b.mask) === b.base || (b.base & a.mask) === a.base)
  );
}

/**
 * 許可リストを作る。allowCidrs が空・不正・広すぎる・私的な範囲なら止める（fail-closed）。
 * resolverIps は名前解決の resolver（loopback でない場合だけ。port 53 に限って許す）。
 */
export function buildEgressPolicy({ allowCidrs, resolverIps = [] }) {
  assert.ok(
    Array.isArray(allowCidrs) && allowCidrs.length > 0,
    "[precheck] EGRESS_ALLOWLIST_REQUIRED a real run needs --egress-allow with the Anthropic API ranges",
  );
  const cidrs = allowCidrs.map((text) => {
    const cidr = parseCidr(text);
    assert.ok(
      cidr,
      "[precheck] EGRESS_ALLOWLIST_INVALID an allow entry is not a CIDR",
    );
    assert.ok(
      cidr.prefix >= (cidr.family === 4 ? V4_MIN_PREFIX : V6_MIN_PREFIX),
      "[precheck] EGRESS_ALLOWLIST_TOO_WIDE an allow entry is wider than the limit",
    );
    assert.ok(
      !FORBIDDEN_RANGES.some((range) => overlaps(cidr, range)),
      "[precheck] EGRESS_ALLOWLIST_PRIVATE an allow entry overlaps a private, loopback or link-local range",
    );
    return cidr;
  });
  const resolvers = resolverIps.map((text) => {
    const ip = parseIp(text);
    assert.ok(
      ip,
      "[precheck] EGRESS_RESOLVER_INVALID a resolver is not an IP address",
    );
    return ip;
  });
  return {
    cidrs,
    resolvers,
    describe: {
      allowCidrCount: cidrs.length,
      resolverCount: resolvers.length,
      allowCidrs: allowCidrs.map((t) => String(t).trim()),
      resolvers: resolverIps.map((t) => String(t).trim()),
    },
  };
}

/** "--egress-allow a,b" の値を配列に。空の項は除く。 */
export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** sampleEgress の宛先（"tcp ip:port"）を判定する："anthropic"（許可リストの tcp 443）／"resolver"（明示した resolver の 53）／"disallowed"。 */
export function classifyDestination(destination, policy) {
  // policy なし（A・乾いた実行）は、loopback 以外の宛先をすべて許可しない側に数える。
  if (!policy) return "disallowed";
  const m = /^(tcp|udp) (.+):(\d{1,5})$/u.exec(String(destination));
  if (!m) return "disallowed";
  const ip = parseIp(m[2]);
  const port = Number(m[3]);
  if (!ip) return "disallowed";
  if (
    m[1] === "tcp" &&
    port === 443 &&
    policy.cidrs.some((c) => cidrContains(c, ip))
  )
    return "anthropic";
  if (
    port === 53 &&
    policy.resolvers.some((r) => r.family === ip.family && r.value === ip.value)
  )
    return "resolver";
  return "disallowed";
}

/**
 * 標本の採取と判定（runCell が setInterval で tick する）。sample は run-inventory.mjs の sampleEgress
 * （destinations に足し、{ tablesRead, socketCount } を返す）。採取が成り立ったのは tablesRead が 1 以上の整数のときだけで、
 * 例外・tablesRead 0・結果が無い・形が違うは sampleFailures に数える（成功の数 sampleCount には入れない。F3a の B1）。
 * 送信の直前の判定（observation）は、直近の tick の成否・時刻・見えた socket の数も見る（判定できなければ止める）。
 */
export function createEgressSampler({
  rootPid,
  policy = null,
  sample,
  now = () => Date.now(),
}) {
  const destinations = new Set();
  const classes = new Map();
  let sampleCount = 0;
  let sampleFailures = 0;
  let lastTickOk = false;
  let lastTickAtMs = null;
  let lastSocketCount = null;
  let socketCountMax = 0;
  let lastTcpSocketCount = null;
  let tcpSocketCountMax = 0;
  const judgeNew = () => {
    for (const destination of destinations)
      if (!classes.has(destination))
        classes.set(destination, classifyDestination(destination, policy));
  };
  const violations = () =>
    [...classes]
      .filter(([, cls]) => cls === "disallowed")
      .map(([destination]) => destination)
      .sort();
  return {
    tick() {
      lastTickAtMs = now();
      lastSocketCount = null;
      lastTcpSocketCount = null;
      lastTickOk = false;
      try {
        const result = sample(rootPid, destinations);
        const read =
          result !== null &&
          typeof result === "object" &&
          Number.isInteger(result.tablesRead) &&
          result.tablesRead >= 1;
        if (Number.isInteger(result?.socketCount) && result.socketCount >= 0) {
          lastSocketCount = result.socketCount;
          socketCountMax = Math.max(socketCountMax, result.socketCount);
        }
        // TCP の socket の数（unix socket を含まない。F5 の m-c）。
        if (
          Number.isInteger(result?.tcpSocketCount) &&
          result.tcpSocketCount >= 0
        ) {
          lastTcpSocketCount = result.tcpSocketCount;
          tcpSocketCountMax = Math.max(
            tcpSocketCountMax,
            result.tcpSocketCount,
          );
        }
        if (read) {
          sampleCount++;
          lastTickOk = true;
        } else sampleFailures++;
      } catch {
        sampleFailures++;
      }
      judgeNew();
    },
    /** 許可リスト以外の宛先（sort 済み）。1 件でもあれば cell は不採用で、以後の送信を止める。 */
    violations,
    /**
     * 送信の直前の観測：許可リスト以外の宛先に加え、観測が成り立っている証拠（成功した標本の数・直近の tick の成否・
     * 直近の tick で見えた socket の数・直近の tick からの経過 ms）。evaluateSendPreconditions が、どれかが欠ければ止める。
     */
    observation() {
      return {
        violations: violations(),
        sampleCount,
        lastTickOk,
        lastSocketCount,
        lastTcpSocketCount,
        ageMs: lastTickAtMs === null ? null : Math.max(0, now() - lastTickAtMs),
      };
    },
    snapshot() {
      return {
        sampleCount,
        sampleFailures,
        socketCountMax,
        tcpSocketCountMax,
        nonLoopbackDestinationCount: destinations.size,
        nonLoopbackDestinations: [...destinations].sort(),
        anthropicDestinationCount: [...classes.values()].filter(
          (c) => c === "anthropic",
        ).length,
        resolverDestinationCount: [...classes.values()].filter(
          (c) => c === "resolver",
        ).length,
        disallowedDestinations: violations(),
        policy: policy?.describe ?? null,
        policyApplied: policy !== null && policy !== undefined,
      };
    },
  };
}
