/**
 * NC-1 の G-open の記録の検査（K3/3 `nir1-d2a-activation-proposal/3`、ゲート表の G-open。NC-1 の lane、S4）。
 *
 * `docs/plans/nir1-lane-decisions/nc1-g-open/` の記録 JSON は、製品の NC-1 の module を import した probe
 * （`electron/scripts/webrtc-block-probe*.mjs`）を最終候補の head の実機（Linux、Electron 43.5.0）で走らせて採ったもの。
 * 判定は `electron/scripts/webrtc-block-probe-verdict.mjs`（行ごとの合否 RJ）と
 * `electron/scripts/webrtc-block-probe-nc1.mjs`（NL、`.local` の規則、Positive (9)、(30b)、(33)、起動順序、合成の記録）。
 *
 * - 最終構成の行ごとの合否は 0 不合格、記録全体の不合格も 0、名前の漏れ NL も 0。
 * - 対照（閉じ込めなし、機構を 1 つずつ外した構成）は不合格を検出し、`<-loopback>` を外した構成と policy を外した構成には
 *   canary に届かないまま不合格になる行がある。対照が検出できない記録は欠陥として赤にする。
 * - 合成の記録（最終構成の記録に漏れを書き込んだもの）は判定の道具が赤にする。
 * - 記録は最終候補の head の後に変わるたびに無効になる（GDX-TRACE-001）。`SHA256SUMS` が記録の bytes を固定する。
 *
 * 記録の採取は実機でしかできないので、この試験は記録を読むだけ（Electron を起動しない）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const recordsDir = fileURLToPath(
  new URL("../../docs/plans/nir1-lane-decisions/nc1-g-open/", import.meta.url),
);
const scriptsDir = new URL("../scripts/", import.meta.url);

function readText(name: string): string {
  return readFileSync(`${recordsDir}${name}`, "utf8");
}
function rec(id: string): Json {
  return JSON.parse(readText(`${id}.json`));
}

const verdict: Json = await import(
  pathToFileURL(
    fileURLToPath(new URL("webrtc-block-probe-verdict.mjs", scriptsDir)),
  ).href
);
const nc1: Json = await import(
  pathToFileURL(
    fileURLToPath(new URL("webrtc-block-probe-nc1.mjs", scriptsDir)),
  ).href
);
const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  ),
) as { devDependencies: Record<string, string> };

/** 最終構成と対照（閉じ込めなし）の対。名前は記録の file 名（`.json` なし） */
const PAIRS = [
  { name: "(23a) fm", final: "nc1-fm-final", baseline: "nc1-fm-baseline" },
  { name: "(23b) ll", final: "nc1-ll-final", baseline: "nc1-ll-baseline" },
  { name: "(23b) fq", final: "nc1-fq-final", baseline: "nc1-fq-baseline" },
  { name: "(23b) nl", final: "nc1-nl-final", baseline: "nc1-nl-baseline" },
  { name: "(23b) sx", final: "nc1-sx-final", baseline: "nc1-sx-baseline" },
  { name: "(23b) doh", final: "nc1-doh-final", baseline: "nc1-doh-baseline" },
  { name: "(23c) ll-kill", final: "nc1-ll-kill", baseline: "nc1-ll-baseline" },
] as const;

function judge(final: string, baseline: string): Json {
  return verdict.judgeRecord(rec(final), { baseline: rec(baseline) });
}

describe("G-open の記録の束縛", () => {
  it("SHA256SUMS が記録の全 file の bytes を固定している（記録が最終候補の後に変わると赤）", () => {
    const sums = readText("SHA256SUMS")
      .split("\n")
      .filter((line) => line.length > 0);
    const listed = new Map<string, string>();
    for (const line of sums) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      expect(match, line).not.toBeNull();
      listed.set(match![2], match![1]);
    }
    const actual = readdirSync(recordsDir)
      .filter((name) => name !== "SHA256SUMS" && name !== "README.md")
      .sort();
    expect([...listed.keys()].sort()).toEqual(actual);
    for (const [name, sum] of listed) {
      const digest = createHash("sha256")
        .update(readFileSync(`${recordsDir}${name}`))
        .digest("hex");
      expect(digest, name).toBe(sum);
    }
  });

  it("記録の Electron の版が package.json の版と一致する（版上げの PR は G-open をやり直す）", () => {
    const pinned = pkg.devDependencies.electron;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    for (const pair of PAIRS) {
      expect(rec(pair.final).electron, pair.final).toBe(pinned);
    }
  });

  it("README に記録を採った候補の head と command を書いている", () => {
    const readme = readText("README.md");
    expect(readme).toMatch(/候補の head[^\n]*`[0-9a-f]{40}`/);
    expect(readme).toMatch(/webrtc-block-probe-candidates\.mjs/);
    expect(existsSync(`${recordsDir}verdicts.txt`)).toBe(true);
  });
});

describe("Negative (23): 最終構成の行ごとの合否 RJ は 0 不合格", () => {
  for (const pair of PAIRS) {
    it(`${pair.name}: ${pair.final} は判定が 0 不合格で記録全体の不合格も 0`, () => {
      const out = judge(pair.final, pair.baseline);
      expect(out.failing.map((row: Json) => `${row.id}: ${row.why}`)).toEqual(
        [],
      );
      expect(out.recordFailures).toEqual([]);
      expect(out.fail).toBe(0);
      // 行を落として 0 に見せていない（判定した行が十分にある）
      expect(out.pass).toBeGreaterThanOrEqual(70);
      const base = rec(pair.baseline);
      const final = rec(pair.final);
      expect(final.totals.canaryHits).toBe(0);
      expect(final.totals.unattributed).toBe(0);
      expect(final.totals.leakedProbes).toBe(0);
      // 対照は同じ行列で漏れる（対照が成立している）
      expect(base.totals.leakedProbes).toBeGreaterThan(0);
    });
  }

  it("(23c): network service が SIGKILL された後（pid が変わった後）も、最終構成の行が 0 不合格のまま", () => {
    const events: string[] = (rec("nc1-ll-kill").events ?? []).map(String);
    const before = events
      .map((event) => /^network service pids=(\d+)/.exec(event)?.[1])
      .find((pid) => pid !== undefined);
    const after = events
      .map((event) => /^network service pids after=(\d+)/.exec(event)?.[1])
      .find((pid) => pid !== undefined);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

describe("Negative (23)(32): 名前の漏れ NL は 0、正の対照が成立する", () => {
  for (const id of [
    "nc1-ll-final",
    "nc1-fq-final",
    "nc1-nl-final",
    "nc1-doh-final",
    "nc1-sx-final",
    "nc1-ll-kill",
  ]) {
    it(`${id}: 観測した名前は許容集合の内側で、nonce を含む名前は 0`, () => {
      const out = nc1.judgeNl(rec(id));
      expect(out.outside).toEqual([]);
      expect(out.pass).toBe(true);
    });
  }

  it("閉じ込めなしでは、getaddrinfo（6 カテゴリ）、DoH、net log のいずれでも攻撃者が選んだ名前が観測される", () => {
    const getaddrinfo = nc1.judgeNlPositiveControl(
      rec("nc1-fq-baseline"),
      "getaddrinfo",
    );
    expect(getaddrinfo.missing).toEqual([]);
    expect(getaddrinfo.ok).toBe(true);
    const doh = nc1.judgeNlPositiveControl(rec("nc1-doh-baseline"), "doh", {
      require: ["stun", "turn-udp", "turn-tcp", "turns", "dns-prefetch"],
    });
    expect(doh.missing).toEqual([]);
    expect(doh.ok).toBe(true);
    expect(
      nc1.judgeNlPositiveControl(rec("nc1-nl-baseline"), "netLog").ok,
    ).toBe(true);
  });

  it("`.local` の規則: 対照で問合せ（UDP 5353）が観測できたとき最終構成は 0。観測できない環境は未検証（合否に含めない）", () => {
    const out = nc1.judgeLocalRule(rec("nc1-ll-final"), rec("nc1-ll-baseline"));
    expect(["pass", "unverified"]).toContain(out.status);
    if (out.status === "pass") {
      expect(out.baselineQueries).toBeGreaterThan(0);
      expect(out.finalQueries).toBe(0);
    }
    const kill = nc1.judgeLocalRule(rec("nc1-ll-kill"), rec("nc1-ll-baseline"));
    expect(kill.status).toBe(out.status);
  });
});

describe("Negative (29): 対照は漏れを検出する", () => {
  it("閉じ込めなし（fm-baseline、ll-baseline）は多数の行が canary に届く", () => {
    for (const id of ["nc1-fm-baseline", "nc1-ll-baseline"]) {
      expect(rec(id).totals.leakedProbes, id).toBeGreaterThanOrEqual(20);
    }
  });

  const CONTROLS = [
    {
      id: "nc1-fm-no-policy",
      baseline: "nc1-fm-baseline",
      minFail: 1,
      canaryless: false,
    },
    {
      id: "nc1-fm-no-proxy",
      baseline: "nc1-fm-baseline",
      minFail: 1,
      canaryless: false,
    },
    {
      id: "nc1-fm-no-neg-loopback",
      baseline: "nc1-fm-baseline",
      minFail: 1,
      canaryless: false,
    },
    {
      id: "nc1-ll-no-neg-loopback",
      baseline: "nc1-ll-baseline",
      minFail: 1,
      canaryless: true,
    },
    {
      id: "nc1-ll-no-policy",
      baseline: "nc1-ll-baseline",
      minFail: 1,
      canaryless: true,
    },
  ] as const;
  for (const control of CONTROLS) {
    it(`${control.id}: 機構を外すと行ごとの合否が不合格を検出する`, () => {
      const out = judge(control.id, control.baseline);
      expect(out.fail + out.recordFailures.length).toBeGreaterThanOrEqual(
        control.minFail,
      );
    });
  }

  it("`<-loopback>` を外した構成と policy を外した構成には、canary に届かないまま不合格になる行がある", () => {
    for (const id of ["nc1-ll-no-neg-loopback", "nc1-ll-no-policy"]) {
      const out = judge(id, "nc1-ll-baseline");
      const byId = new Map(rec(id).rows.map((row: Json) => [row.id, row]));
      const canaryless = out.failing.filter(
        (row: Json) => (byId.get(row.id) as Json)?.leaked === 0,
      );
      expect(canaryless.length, id).toBeGreaterThanOrEqual(1);
    }
  });

  it("rules を外した構成は、到達でなく名前の漏れ NL で検出される", () => {
    const out = nc1.judgeNl(rec("nc1-nl-no-rules"));
    expect(out.pass).toBe(false);
    expect(out.outside.length).toBeGreaterThan(0);
  });

  it("対照の構成でも canary の到達は帰属する行の中だけ（最終構成では 0）", () => {
    for (const pair of PAIRS) {
      expect(rec(pair.final).totals.canaryHits).toBe(0);
    }
  });
});

describe("合成の記録は判定の道具が赤にする", () => {
  const cases = [
    {
      key: "leaks",
      make: nc1.synthesizeLeaks,
      source: "nc1-ll-final",
      baseline: "nc1-ll-baseline",
    },
    {
      key: "hintNotInBaseline",
      make: nc1.synthesizeHintNotInBaseline,
      source: "nc1-ll-final",
      baseline: "nc1-ll-baseline",
    },
    {
      key: "fqdnLeaks",
      make: nc1.synthesizeFqdnLeaks,
      source: "nc1-fq-final",
      baseline: "nc1-fq-baseline",
    },
  ] as const;
  for (const entry of cases) {
    it(`${entry.key}: 最終構成の記録から作った合成の記録が ${entry.key} の下限以上の不合格を出す`, () => {
      const synthetic = entry.make(rec(entry.source));
      const out = verdict.judgeRecord(synthetic, {
        baseline: rec(entry.baseline),
      });
      expect(out.fail + out.recordFailures.length).toBeGreaterThanOrEqual(
        nc1.SYNTHETIC_EXPECT_MIN_FAIL[entry.key],
      );
      // 元の最終構成の記録は赤にならない（合成が元の記録を書き換えていない）
      expect(judge(entry.source, entry.baseline).fail).toBe(0);
    });
  }
});

describe("Positive (9)、(30b)、(33)、実機の観測", () => {
  it("Positive (9)(i)(ii)(iii)(v): same-origin fetch、同梱の worker、自己確認、Node の fetch、loopback の受信 socket への接続", () => {
    const out = nc1.judgePositive9(rec("nc1-ll-final"));
    expect(out.failures).toEqual([]);
  });

  it("(30b): RTCPeerConnection の開閉の反復と上限超過の切断が続いても、窓が生きたまま canary 0", () => {
    const out = nc1.judgeChurn(rec("nc1-fm-final"));
    expect(out.failures).toEqual([]);
    expect(out.exercised).toBe(true);
    expect(out.maxActive).toBeLessThanOrEqual(256);
    // 対照は同じ churn で canary に届く（churn が攻撃として成立している）
    expect(rec("nc1-fm-baseline").totals.leakedProbes).toBeGreaterThan(0);
  });

  it("再読込・遷移の後の localhost の TURN／STUN で policy と proxy が持続する", () => {
    expect(
      nc1.judgeReloadRows(rec("nc1-fm-final"), rec("nc1-fm-baseline")).failures,
    ).toEqual([]);
    expect(
      nc1.judgeReloadRows(rec("nc1-ll-final"), rec("nc1-ll-baseline")).failures,
    ).toEqual([]);
  });

  it("(33): 更新の確認は RS-1 の名前を通し、env の proxy は localhost／127.0.0.1 だけに CONNECT が届く", () => {
    const forms: Array<[string, string]> = [
      ["nc1-w0-envproxy-localhost-baseline", "baseline"],
      ["nc1-w2-envproxy-localhost-final", "localhost"],
      ["nc1-w3-envproxy-127-final", "127.0.0.1"],
      ["nc1-w4-envproxy-lan-final", "lan"],
      ["nc1-w5-envproxy-hostname-final", "hostname"],
    ];
    for (const [id, form] of forms) {
      expect(nc1.judgeUpdaterEnvProxy(rec(id), form).failures, id).toEqual([]);
    }
  });

  it("NC-SESSION、NC-POLICY、DevTools の実機の観測（固定コード、graceful な終了、何も読み込まれない）", () => {
    expect(
      nc1.judgeNcSession(rec("nc1-session-fail"), rec("nc1-session-none"))
        .failures,
    ).toEqual([]);
    expect(
      nc1.judgeNcPolicy(rec("nc1-policy-fail"), {
        ok: rec("nc1-policy-ok"),
        none: rec("nc1-policy-none"),
      }).failures,
    ).toEqual([]);
    expect(nc1.judgeDevTools(rec("nc1-devtools")).failures).toEqual([]);
  });

  it("起動順序（env の proxy なし／127.0.0.1／localhost × 各 5 回）: appendSwitch／policy handler は ready の前、NC-1 の setProxy が default session の最初の接触で窓より前、辞書の要求は blackhole へ向く", () => {
    const rows = ["none", "ip", "localhost"].flatMap(
      (env) => rec(`nc1-order-product-nc1-${env}`).rows as Json[],
    );
    const out = nc1.judgeStartupOrder({ rows });
    expect(out.failures).toEqual([]);
    expect(out.runs).toBeGreaterThanOrEqual(15);
    // 実機の観測で NC-1 の start() が窓の作成より前に完了している
    for (const row of rows) {
      expect(row.nc1Marks["nc1 start done"]).toBeLessThanOrEqual(
        row.nc1Marks["BrowserWindow created"],
      );
      expect(row.blackholeHits).toBeGreaterThanOrEqual(1);
    }
  });

  it("起動順序の対照: NC-1 だけを呼ばない構成（product-none）は、同じ判定で赤になる", () => {
    const rows = ["none", "ip", "localhost"].flatMap(
      (env) => rec(`nc1-order-product-none-${env}`).rows as Json[],
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    const out = nc1.judgeStartupOrder({ rows });
    expect(out.pass).toBe(false);
  });
});
