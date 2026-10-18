/**
 * NC-1 の設定の部品の単体試験（K3/3 の Positive (9)(vi) と Negative (31) の
 * 定数の部分。S1）。electron に依存しない純粋な部品なので、モックは要らない。
 * 起動の統合（FC-1、順序）の試験は S2 が同じ file に足す。
 */
import { describe, expect, it } from "vitest";

import {
  AL0_DIRECT_ALLOWLIST,
  LOOPBACK_ADDRESS,
  NC_RUNTIME_FAILURE_CODES,
  NC_STARTUP_FAILURE_CODES,
  PROXY_BYPASS_RULES,
  RESOLVER_SENTINEL_HOST,
  RS1_GITHUB_HOSTS,
  RS1_LOCALHOST,
  RS1_RESOLVABLE_NAMES,
  WEBRTC_IP_HANDLING_POLICY,
  buildHostResolverRules,
  buildProxyConfig,
} from "./rendererContainment.js";
import {
  LS1_MAX_CONCURRENT_CONNECTIONS,
  LS1_MAX_HOLD_MS,
} from "./rendererContainmentListener.js";

/** K3/3 の NC-1 の節 3 の規則の exact な文字列（順序を含む）。 */
const EXPECTED_HOST_RESOLVER_RULES =
  "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";

describe("RS-1 と sentinel の定数（(31)）", () => {
  it("RS-1 の GitHub の host は exact な 3 host", () => {
    expect([...RS1_GITHUB_HOSTS]).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
  });

  it("RS-1 の固定の 4 名は 3 host と localhost だけ", () => {
    expect(RS1_LOCALHOST).toBe("localhost");
    expect([...RS1_RESOLVABLE_NAMES]).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
      "localhost",
    ]);
  });

  it("sentinel と loopback address は固定", () => {
    expect(RESOLVER_SENTINEL_HOST).toBe("grimodex-rule-sentinel.invalid");
    expect(LOOPBACK_ADDRESS).toBe("127.0.0.1");
  });
});

describe("AL-0 と proxyBypassRules（(31)、Positive (9)(vi)）", () => {
  it("直接通信を許す先は 0 件", () => {
    expect(AL0_DIRECT_ALLOWLIST).toHaveLength(0);
  });

  it("proxyBypassRules は <-loopback> だけ", () => {
    expect(PROXY_BYPASS_RULES).toBe("<-loopback>");
  });

  it("proxy config は固定の SOCKS5 の blackhole と <-loopback> だけ", () => {
    expect(buildProxyConfig(54321)).toEqual({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:54321",
      proxyBypassRules: "<-loopback>",
    });
  });

  it.each([0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "port が範囲外（%s）なら proxy config を作らない",
    (port) => {
      expect(() => buildProxyConfig(port)).toThrow(RangeError);
    },
  );
});

describe("buildHostResolverRules（(31)、Positive (9)(vi)）", () => {
  it("引数なしの規則の文字列が順序を含めて exact", () => {
    expect(buildHostResolverRules()).toBe(EXPECTED_HOST_RESOLVER_RULES);
    expect(buildHostResolverRules([])).toBe(EXPECTED_HOST_RESOLVER_RULES);
  });

  it("規則は定数・sentinel・EXCLUDE 127.0.0.1・EXCLUDE localhost だけから組み立てられる", () => {
    const rules = buildHostResolverRules().split(", ");
    expect(rules).toEqual([
      `MAP ${RESOLVER_SENTINEL_HOST} ${LOOPBACK_ADDRESS}`,
      "MAP * ~NOTFOUND",
      ...RS1_GITHUB_HOSTS.map((host) => `EXCLUDE ${host}`),
      `EXCLUDE ${LOOPBACK_ADDRESS}`,
      `EXCLUDE ${RS1_LOCALHOST}`,
    ]);
    // localhost は 1 回だけ。許可先（gvt1 など）や wildcard の EXCLUDE を含まない。
    expect(rules.filter((rule) => rule === "EXCLUDE localhost")).toHaveLength(
      1,
    );
    expect(rules.filter((rule) => rule.startsWith("EXCLUDE "))).toHaveLength(5);
    expect(buildHostResolverRules()).not.toMatch(/gvt1|\*\./);
  });

  it("prefixRules は製品の規則の先頭に置いて 1 つの switch にする（試験の差し込み口）", () => {
    const rules = buildHostResolverRules([
      "MAP *.probe.test 127.0.0.1",
      "EXCLUDE 127.0.0.2",
    ]);
    expect(rules).toBe(
      `MAP *.probe.test 127.0.0.1, EXCLUDE 127.0.0.2, ${EXPECTED_HOST_RESOLVER_RULES}`,
    );
  });

  it("prefixRules を変更しても製品の規則は変わらない", () => {
    const prefix = ["MAP a.test 127.0.0.1"];
    buildHostResolverRules(prefix);
    prefix.push("MAP b.test 127.0.0.1");
    expect(buildHostResolverRules()).toBe(EXPECTED_HOST_RESOLVER_RULES);
  });
});

describe("policy の値と固定コード", () => {
  it("WebRTC の IP 取扱い policy は disable_non_proxied_udp", () => {
    expect(WEBRTC_IP_HANDLING_POLICY).toBe("disable_non_proxied_udp");
  });

  it("起動前の固定コードは 6 つ", () => {
    expect([...NC_STARTUP_FAILURE_CODES]).toEqual([
      "NC-LISTEN",
      "NC-PROXY",
      "NC-CLOSE",
      "NC-SELF-RESOLVE",
      "NC-SELF-PROXY",
      "NC-TIMEOUT",
    ]);
  });

  it("実行中の固定コードは 3 つ", () => {
    expect([...NC_RUNTIME_FAILURE_CODES]).toEqual([
      "NC-POLICY",
      "NC-SESSION",
      "NC-LISTENER-LOST",
    ]);
  });

  it("固定コードは重ならず、NC- の列挙値だけ（値を含まない）", () => {
    const all = [...NC_STARTUP_FAILURE_CODES, ...NC_RUNTIME_FAILURE_CODES];
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) expect(code).toMatch(/^NC-[A-Z]+(-[A-Z]+)?$/);
  });
});

describe("LS-1 の上界の定数（(31)）", () => {
  it("同時の接続数は 256 以下、保持は 5 秒以下（これを超える値は赤。exact には固定しない）", () => {
    expect(LS1_MAX_CONCURRENT_CONNECTIONS).toBeGreaterThan(0);
    expect(LS1_MAX_CONCURRENT_CONNECTIONS).toBeLessThanOrEqual(256);
    expect(LS1_MAX_HOLD_MS).toBeGreaterThan(0);
    expect(LS1_MAX_HOLD_MS).toBeLessThanOrEqual(5000);
  });
});
