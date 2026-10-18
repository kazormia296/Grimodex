/**
 * `webrtc-block-probe-nc1.mjs`（NC-1 の G-open の記録を判定する道具）の単体試験。
 *   node --test electron/scripts/webrtc-block-probe-nc1.test.mjs
 * 実機を使わない。判定の述語が draft（K3/3）の定義どおりで、赤になるべき入力で赤になることを、
 * 小さい合成の記録と、測定の記録（`webrtc-closure-measurement/records/`。変更しない）で確かめる。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SYNTHETIC_EXPECT_MIN_FAIL,
  judgeChurn,
  CONTROL_CATEGORIES,
  NEARNAMES_EXPECTED,
  judgeControlCategories,
  judgeDevTools,
  judgeLocalRule,
  judgeNearNames,
  judgeNcPolicy,
  judgeNcSession,
  judgeNl,
  judgeNlPositiveControl,
  judgePositive9,
  judgeReloadRows,
  judgeStartupOrder,
  judgeUpdaterEnvProxy,
  synthesizeFqdnLeaks,
  synthesizeHintNotInBaseline,
  synthesizeLeaks,
} from "./webrtc-block-probe-nc1.mjs";
import { judgeRecord } from "./webrtc-block-probe-verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = path.resolve(here, "../../docs/plans/nir1-lane-decisions/webrtc-closure-measurement/records");
const load = (name) => JSON.parse(fs.readFileSync(path.join(records, name), "utf8"));
const verdictCli = path.join(here, "webrtc-block-probe-verdict.mjs");

const row = (id, extra = {}) => ({ id, outcome: "gathering:complete", leaked: 0, proxied: 0, ...extra });

// ── .local の規則 ───────────────────────────────────────────────────────

const mdnsRecord = (queries, joined = true) => ({
  mdns: { joined, nonceBearing: queries },
  rows: [row("local-name.dns-prefetch", { mdnsQueries: queries }), row("local-name.turn-udp", { mdnsQueries: 0 })],
});

test(".local の規則: ベースラインで問合せを観測できたとき、最終構成の 0 は合格", () => {
  const result = judgeLocalRule(mdnsRecord(0), mdnsRecord(3));
  assert.equal(result.status, "pass");
  assert.equal(result.baselineQueries, 3);
});

test(".local の規則: ベースラインで観測した問合せが最終構成に出れば不合格", () => {
  const result = judgeLocalRule(mdnsRecord(2), mdnsRecord(3));
  assert.equal(result.status, "fail");
});

test(".local の規則: ベースラインで問合せを観測できない環境、multicast に参加できない環境は未検証（合否に含めない）", () => {
  assert.equal(judgeLocalRule(mdnsRecord(0), mdnsRecord(0)).status, "unverified");
  const notJoined = judgeLocalRule(mdnsRecord(0), mdnsRecord(0, false));
  assert.equal(notJoined.status, "unverified");
  assert.match(notJoined.reason, /参加できない/);
});

test(".local の規則: 最終構成の記録に .local の行がなければ不合格（行を落として 0 に見せない）", () => {
  const final = { mdns: { joined: true, nonceBearing: 0 }, rows: [row("local-name.dns-prefetch", { mdnsQueries: 0 })] };
  assert.equal(judgeLocalRule(final, mdnsRecord(3)).status, "fail");
});

// ── 名前の漏れ NL ───────────────────────────────────────────────────────

test("NL: 許容集合の内側（RS-1 の 4 名、sentinel、127.0.0.1、net log の ~notfound、DoH の www.gstatic.com）は合格", () => {
  const result = judgeNl({
    dnsAll: ["github.com[rc0]", "release-assets.githubusercontent.com[rc0]", "GitHub.com."],
    dohAll: ["www.gstatic.com", "localhost"],
    netLog: { hostResolver: { requestHosts: { "127.0.0.1": 3, "~notfound": 4, localhost: 1 }, jobHosts: { "github.com": 1 }, nonceBearing: 0 } },
  });
  assert.equal(result.pass, true, JSON.stringify(result));
});

test("NL: 許容集合の外の名前、nonce を含む名前は 1 件でも不合格", () => {
  assert.equal(judgeNl({ dnsAll: ["example.org[rc0]"] }).pass, false);
  assert.equal(judgeNl({ dnsAll: ["stunname-<n>.probe.test."] }).pass, false);
  assert.equal(judgeNl({ dohAll: ["turnsname-<n>.probe.test"] }).pass, false);
  assert.equal(judgeNl({ netLog: { hostResolver: { requestHosts: { "evil.test": 1 }, jobHosts: {}, nonceBearing: 0 } } }).pass, false);
  assert.equal(judgeNl({ netLog: { hostResolver: { requestHosts: {}, jobHosts: {}, nonceBearing: 2 } } }).pass, false);
});

test("NL: ~notfound は net log に限る。getaddrinfo の記録に出れば不合格。www.gstatic.com は DoH に限る", () => {
  assert.equal(judgeNl({ dnsAll: ["~notfound"] }).pass, false);
  assert.equal(judgeNl({ dnsAll: ["www.gstatic.com"] }).pass, false);
  assert.equal(judgeNl({ netLog: { hostResolver: { requestHosts: { "www.gstatic.com": 1 }, jobHosts: {}, nonceBearing: 0 } } }).pass, false);
  assert.equal(judgeNl({ dohAll: ["~notfound"] }).pass, false);
});

test("NL: 観測していない channel は集合に入れず、件数を出す", () => {
  const result = judgeNl({ dnsAll: [] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.channels, { getaddrinfo: 0, doh: null, netLog: null });
});

test("NL: 実測の記録（nl-al0-final／al0-doh／fq-al0-final）は合格、閉じ込めなし（nl-baseline／o0-doh-baseline）は不合格", () => {
  for (const name of ["nl-al0-final.json", "al0-doh.json", "fq-al0-final.json"]) {
    const result = judgeNl(load(name));
    assert.equal(result.pass, true, `${name}: ${JSON.stringify(result.outside)}`);
  }
  assert.equal(judgeNl(load("nl-baseline.json")).pass, false);
  assert.equal(judgeNl(load("o0-doh-baseline.json")).pass, false);
});

test("NL の正の対照: 閉じ込めなしの記録は各カテゴリの名前が観測される。観測されなければ試験の欠陥", () => {
  const positive = judgeNlPositiveControl(load("fq-baseline.json"), "getaddrinfo");
  assert.equal(positive.ok, true, JSON.stringify(positive));
  const noFqdn = judgeNlPositiveControl(load("nl-baseline.json"), "getaddrinfo", { require: ["stun", "turn-udp", "turn-tcp", "turns", "dns-prefetch"] });
  assert.equal(noFqdn.ok, true, JSON.stringify(noFqdn));
  assert.equal(judgeNlPositiveControl(load("nl-baseline.json"), "netLog").ok, true);
  assert.equal(judgeNlPositiveControl(load("o0-doh-baseline.json"), "doh", { require: ["stun", "turn-udp", "turn-tcp", "turns"] }).ok, true);
  // 最終構成の記録を対照として渡すと、名前が観測されないので欠陥になる
  const defective = judgeNlPositiveControl(load("fq-al0-final.json"), "getaddrinfo");
  assert.equal(defective.ok, false);
  assert.ok(defective.missing.includes("stun"));
  assert.equal(judgeNlPositiveControl(load("nl-al0-final.json"), "netLog").ok, false);
});

// ── Positive (9) ────────────────────────────────────────────────────────

const positiveRecord = () => ({
  events: [
    "nc1 orchestrator start => true in 31.8 ms",
    "resolveProxy(https://turn.attacker.invalid:443/) => SOCKS5 127.0.0.1:40000",
    "resolveProxy(https://example.invalid:8443/) => SOCKS5 127.0.0.1:40000",
    "resolveProxy(http://127.0.0.1:1/) => SOCKS5 127.0.0.1:40000",
    'resolveHost(grimodex-rule-sentinel.invalid) => ["127.0.0.1"]',
    "resolveHost(1.1.1.1) => error:net::ERR_NAME_NOT_RESOLVED",
    "resolveHost(127.0.0.2) => error:net::ERR_NAME_NOT_RESOLVED",
  ],
  nc1: { failures: [], listenerPort: 40000 },
  totals: { ctlHits: 1 },
  rows: [
    row("control.same-origin-fetch", { outcome: "status:200" }),
    row("control.bundled-worker", { outcome: "worker-ok:x" }),
    row("main.node-fetch", { outcome: "200" }),
    row("main.node-fetch.loopback-socket", { outcome: "connected" }),
  ],
});

test("Positive (9): (i)(ii)(iii)(v) を満たす記録は合格", () => {
  const result = judgePositive9(positiveRecord());
  assert.equal(result.pass, true, JSON.stringify(result));
});

test("Positive (9): どれか 1 つを欠けば不合格になる（各項目が独立に効く）", () => {
  const mutations = {
    "(i) fetch": (r) => { r.rows[0].outcome = "status:404"; },
    "(i) worker": (r) => { r.rows[1].outcome = "worker-error"; },
    "(iii) node-fetch": (r) => { r.rows[2].outcome = "error:fetch failed"; },
    "(v) loopback socket": (r) => { r.rows[3].outcome = "error:ECONNREFUSED"; },
    "(v) ctlHits": (r) => { r.totals.ctlHits = 0; },
    "(ii) start": (r) => { r.events[0] = "nc1 orchestrator start => false in 5000 ms"; },
    "(ii) 固定コード": (r) => { r.nc1.failures = ["[grimodex-electron] NC-PROXY"]; },
    "(ii) sentinel": (r) => { r.events[4] = 'resolveHost(grimodex-rule-sentinel.invalid) => ["1.2.3.4"]'; },
    "(ii) IP literal": (r) => { r.events[5] = 'resolveHost(1.1.1.1) => ["1.1.1.1"]'; },
    "(ii) 127.0.0.2": (r) => { r.events[6] = 'resolveHost(127.0.0.2) => ["127.0.0.2"]'; },
    "(ii) resolveProxy": (r) => { r.events[1] = "resolveProxy(https://turn.attacker.invalid:443/) => DIRECT"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const record = positiveRecord();
    mutate(record);
    assert.equal(judgePositive9(record).pass, false, name);
  }
});

// ── (30b) ───────────────────────────────────────────────────────────────

const churnRecord = () => ({
  rows: [
    row("main.turn-tcp.churn", { outcome: "churn:1200", proxied: 900 }),
    row("main.turn-tcp.after-churn", { outcome: "gathering:complete", proxied: 2 }),
  ],
  nc1: { overLimit: 300, maxActive: 256, uncaught: [] },
  extra: { afterChurn: { evalResult: 2, crashed: false, destroyed: false } },
  exit: { code: 0, signal: null },
  totals: { canaryHits: 0 },
});

test("(30b): 上限超過の切断が続いても canary 0、窓が生きている記録は合格", () => {
  const result = judgeChurn(churnRecord());
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.exercised, true);
});

test("(30b): canary 到達、上限を叩けていない、256 超、未処理例外、窓の無応答、終了は不合格", () => {
  const mutations = {
    "canary 到達": (r) => { r.rows[0].leaked = 4; r.totals.canaryHits = 4; },
    "churn の後に canary 到達": (r) => { r.rows[1].leaked = 1; },
    "上限を叩けていない": (r) => { r.nc1.overLimit = 0; },
    "256 超": (r) => { r.nc1.maxActive = 257; },
    "未処理例外": (r) => { r.nc1.uncaught = ["Error: boom"]; },
    "窓の無応答": (r) => { r.extra.afterChurn.evalResult = "timeout"; },
    "窓の crash": (r) => { r.extra.afterChurn.crashed = true; },
    "listener への接続 0": (r) => { r.rows[0].proxied = 0; },
    "churn の後の接続が届かない": (r) => { r.rows[1].proxied = 0; },
    "Main が終了": (r) => { r.exit = { code: null, signal: "SIGSEGV" }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const record = churnRecord();
    mutate(record);
    assert.equal(judgeChurn(record).pass, false, name);
  }
});

// ── 再読込・遷移の後の localhost ────────────────────────────────────────

const reloadRecord = () => ({
  rows: ["reload", "nav"].flatMap((tag) => [
    row(`main.stun.${tag}-localhost`),
    row(`main.turn-udp.${tag}-localhost`, { outcome: "ice:new" }),
    row(`main.turn-tcp.${tag}-localhost`, { proxied: 1 }),
    row(`main.turns.${tag}-localhost`, { proxied: 1 }),
  ]),
});
const reloadBaseline = () => ({
  rows: ["reload", "nav"].flatMap((tag) => [row(`main.turn-tcp.${tag}-localhost`, { leaked: 4, outcome: "gathering:gathering" })]),
});

test("再読込・遷移の後の localhost: policy と proxy が持続する記録は合格", () => {
  assert.equal(judgeReloadRows(reloadRecord(), reloadBaseline()).pass, true);
});

test("再読込・遷移の後の localhost: 到達、proxy 宛 0、行の欠落、対照の不成立は不合格", () => {
  const leaked = reloadRecord();
  leaked.rows[2].leaked = 1;
  assert.equal(judgeReloadRows(leaked, reloadBaseline()).pass, false);
  const noProxy = reloadRecord();
  noProxy.rows[6].proxied = 0;
  assert.equal(judgeReloadRows(noProxy, reloadBaseline()).pass, false);
  const missing = reloadRecord();
  missing.rows.pop();
  assert.equal(judgeReloadRows(missing, reloadBaseline()).pass, false);
  const udpProgress = reloadRecord();
  udpProgress.rows[1].outcome = "gathering:gathering";
  assert.equal(judgeReloadRows(udpProgress, reloadBaseline()).pass, false);
  const brokenControl = reloadBaseline();
  brokenControl.rows[0].leaked = 0;
  assert.equal(judgeReloadRows(reloadRecord(), brokenControl).pass, false);
});

// ── (33) ────────────────────────────────────────────────────────────────

test("(33): 実測の w0〜w5（AL-1 の旧構成）の形を、同じ述語で判定できる（取り直した AL-0 の記録も同じ形）", () => {
  assert.equal(judgeUpdaterEnvProxy(load("w0-envproxy-localhost-baseline.json"), "baseline").pass, true);
  assert.equal(judgeUpdaterEnvProxy(load("w2-envproxy-localhost-final.json"), "localhost").pass, true);
  assert.equal(judgeUpdaterEnvProxy(load("w3-envproxy-127-final.json"), "127.0.0.1").pass, true);
  assert.equal(judgeUpdaterEnvProxy(load("w4-envproxy-lan-final.json"), "lan").pass, true);
  assert.equal(judgeUpdaterEnvProxy(load("w5-envproxy-hostname-final.json"), "hostname").pass, true);
});

test("(33): form と記録が食い違えば不合格（LAN／hostname の proxy に接続が届く、localhost の proxy に届かない）", () => {
  assert.equal(judgeUpdaterEnvProxy(load("w2-envproxy-localhost-final.json"), "lan").pass, false);
  assert.equal(judgeUpdaterEnvProxy(load("w4-envproxy-lan-final.json"), "localhost").pass, false);
  assert.equal(judgeUpdaterEnvProxy(load("w5-envproxy-hostname-final.json"), "127.0.0.1").pass, false);
  const leakedLan = load("w4-envproxy-lan-final.json");
  leakedLan.envProxyConnects = ["CONNECT github.com:443 HTTP/1.1"];
  assert.equal(judgeUpdaterEnvProxy(leakedLan, "lan").pass, false);
  assert.equal(judgeUpdaterEnvProxy(load("w2-envproxy-localhost-final.json"), "unknown").pass, false);
});

// ── 起動順序と辞書の要求 ────────────────────────────────────────────────

const orderRow = () => ({
  nc1Marks: {
    "appendSwitch host-resolver-rules (before ready)": -40,
    "registerSecurityHandlers (before ready)": -39,
    "registerWebContentsPolicy (before ready)": -38,
    "nc1 start begin": 3,
    "defaultSession first touch": 8,
    "setProxy start": 8,
    "setProxy done": 20,
    "closeAllConnections done": 21,
    "nc1 start done": 33,
    "applySessionPermissionPolicy done": 34,
    "installProductDownloadGuard done": 35,
    "registerAppProtocolHandler done": 36,
    "BrowserWindow created": 40,
    "window loaded": 90,
  },
  dictionaryRequests: [{ startBeforeSetProxyDone: false, proxyInfo: ["SOCKS5 127.0.0.1:39311"] }],
  envProxyConnects: [],
  dictionaries: [],
});

test("起動順序: 製品の index.ts と同じ順序で、辞書の要求が setProxy の完了後に blackhole へ向く記録は合格", () => {
  assert.equal(judgeStartupOrder({ rows: [orderRow(), orderRow()] }).pass, true);
});

test("起動順序: 順序の入替え、ready の後の appendSwitch、setProxy 前の辞書の要求、env の proxy への到達、辞書の取得は不合格", () => {
  const swap = (a, b) => (row2) => { const t = row2.nc1Marks[a]; row2.nc1Marks[a] = row2.nc1Marks[b]; row2.nc1Marks[b] = t; };
  const mutations = {
    "permission が setProxy より前": swap("applySessionPermissionPolicy done", "setProxy start"),
    "protocol.handle が NC-1 より前": swap("registerAppProtocolHandler done", "defaultSession first touch"),
    "窓が NC-1 の完了より前": swap("BrowserWindow created", "nc1 start done"),
    "appendSwitch が ready の後": (r) => { r.nc1Marks["appendSwitch host-resolver-rules (before ready)"] = 5; },
    "印の欠落": (r) => { delete r.nc1Marks["setProxy done"]; },
    "辞書の要求が setProxy の前": (r) => { r.dictionaryRequests[0].startBeforeSetProxyDone = true; },
    "辞書の要求が blackhole に向かない": (r) => { r.dictionaryRequests[0].proxyInfo = ["DIRECT"]; },
    "env の proxy に届いた": (r) => { r.envProxyConnects = [{ msFromReady: 50, line: "CONNECT redirector.gvt1.com:443" }]; },
    "辞書を取得": (r) => { r.dictionaries = ["en-US-10-1.bdic"]; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const record = orderRow();
    mutate(record);
    assert.equal(judgeStartupOrder({ rows: [record] }).pass, false, name);
  }
  assert.equal(judgeStartupOrder({ rows: [] }).pass, false);
});

// ── 実機の観測 ──────────────────────────────────────────────────────────

test("NC-SESSION: 固定コード、before-quit／will-quit、quit 1 回、終了コード 0、server への到達 0。対照は届く", () => {
  const record = {
    nc1: { failures: ["[grimodex-electron] NC-SESSION"], beforeQuit: true, willQuit: true, quitCalls: 1 },
    exit: { code: 0, signal: null },
    httpdHits: 0,
    extra: { ncSession: { loadOutcome: "error:ERR_FAILED" } },
  };
  assert.equal(judgeNcSession(record, { httpdHits: 1 }).pass, true);
  assert.equal(judgeNcSession(record, { httpdHits: 0 }).pass, false);
  for (const mutate of [
    (r) => { r.nc1.failures = []; },
    (r) => { r.nc1.willQuit = false; },
    (r) => { r.nc1.quitCalls = 2; },
    (r) => { r.exit = { code: null, signal: "SIGSEGV" }; },
    (r) => { r.httpdHits = 1; },
    (r) => { r.extra.ncSession.loadOutcome = "loaded"; },
  ]) {
    const mutated = JSON.parse(JSON.stringify(record));
    mutate(mutated);
    assert.equal(judgeNcSession(mutated, { httpdHits: 1 }).pass, false);
  }
});

test("NC-POLICY の注入: 破棄された窓で script が走らず canary 0。対照 ok は走って canary 0、none は走って UDP が canary に届く", () => {
  const record = {
    nc1: { failures: ["[grimodex-electron] NC-POLICY"], beforeQuit: true, willQuit: true },
    exit: { code: 0, signal: null },
    appRequests: [],
    totals: { canaryHits: 0, unattributed: 0 },
  };
  const ok = { appRequests: ["/page-ran.html", "/assets/ran.js", "/beacon-ran"], totals: { canaryHits: 0 } };
  const none = { appRequests: ["/page-ran.html", "/assets/ran.js", "/beacon-ran"], totals: { canaryHits: 4 } };
  assert.equal(judgeNcPolicy(record, { ok, none }).pass, true);
  assert.equal(judgeNcPolicy({ ...record, appRequests: ["/beacon-ran"] }, { ok, none }).pass, false);
  assert.equal(judgeNcPolicy({ ...record, totals: { canaryHits: 1, unattributed: 1 } }, { ok, none }).pass, false);
  assert.equal(judgeNcPolicy(record, { ok: { ...ok, appRequests: [] }, none }).pass, false);
  assert.equal(judgeNcPolicy(record, { ok, none: { ...none, totals: { canaryHits: 0 } } }).pass, false);
});

test("DevTools: default session で policy が当たり、NC-SESSION も終了も起こさない", () => {
  const record = {
    nc1: { failures: [], quitCalls: 0 },
    extra: {
      devtools: {
        devToolsOpened: true,
        snapshot: [
          { type: "remote", url: "devtools://devtools/bundled/devtools_app.html", isDefaultSession: true, policy: "disable_non_proxied_udp" },
          { type: "window", url: "app://bundle/index.html", isDefaultSession: true, policy: "disable_non_proxied_udp" },
        ],
      },
    },
  };
  assert.equal(judgeDevTools(record).pass, true);
  const other = JSON.parse(JSON.stringify(record));
  other.extra.devtools.snapshot[0].isDefaultSession = false;
  assert.equal(judgeDevTools(other).pass, false);
  const quit = JSON.parse(JSON.stringify(record));
  quit.nc1.quitCalls = 1;
  assert.equal(judgeDevTools(quit).pass, false);
  const noPolicy = JSON.parse(JSON.stringify(record));
  noPolicy.extra.devtools.snapshot[0].policy = "default";
  assert.equal(judgeDevTools(noPolicy).pass, false);
});

// ── 合成の記録が赤になる ────────────────────────────────────────────────

const runVerdict = (record, baseline, expectMinFail) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "wrtc-synthetic-"));
  try {
    const recordFile = path.join(dir, "record.json");
    const baselineFile = path.join(dir, "baseline.json");
    fs.writeFileSync(recordFile, JSON.stringify(record));
    fs.writeFileSync(baselineFile, JSON.stringify(baseline));
    const args = [verdictCli, recordFile, "--baseline", baselineFile, ...(expectMinFail ? ["--expect-min-fail", String(expectMinFail)] : [])];
    return spawnSync(process.execPath, args, { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("合成の記録（ll-synthetic-leaks の形）: 元の記録は合格、合成は行の不合格と記録全体の不合格で赤。--expect-min-fail で検出できる", () => {
  const base = load("ll-al0-final.json");
  const baseline = load("ll-baseline.json");
  assert.equal(judgeRecord(base, { baseline }).fail, 0);
  assert.equal(runVerdict(base, baseline).status, 0);
  const synthetic = synthesizeLeaks(base);
  assert.equal(base.totals.unattributed, 0, "元の記録を書き換えない");
  const judged = judgeRecord(synthetic, { baseline });
  assert.equal(judged.fail, 2);
  assert.equal(judged.recordFailures.length, 1);
  assert.equal(runVerdict(synthetic, baseline).status, 1);
  assert.equal(runVerdict(synthetic, baseline, SYNTHETIC_EXPECT_MIN_FAIL.leaks).status, 0);
  assert.equal(runVerdict(synthetic, baseline, SYNTHETIC_EXPECT_MIN_FAIL.leaks + 1).status, 1);
});

test("合成の記録（ll-synthetic-hint-not-in-baseline の形）: 対照の行列にない DNS だけの行は不合格", () => {
  const base = load("ll-al0-final.json");
  const baseline = load("ll-baseline.json");
  const synthetic = synthesizeHintNotInBaseline(base);
  assert.equal(synthetic.rows.length, base.rows.length + 1);
  assert.equal(judgeRecord(synthetic, { baseline }).fail, 1);
  assert.equal(runVerdict(synthetic, baseline).status, 1);
  assert.equal(runVerdict(synthetic, baseline, SYNTHETIC_EXPECT_MIN_FAIL.hintNotInBaseline).status, 0);
});

test("合成の記録（fq-synthetic-fqdn-leaks の形）: 不活性の FQDN の行の名前の漏れと canary 到達は不合格", () => {
  const base = load("fq-al0-final.json");
  const baseline = load("fq-baseline.json");
  assert.equal(judgeRecord(base, { baseline }).fail, 0);
  const synthetic = synthesizeFqdnLeaks(base);
  const judged = judgeRecord(synthetic, { baseline });
  assert.equal(judged.fail, 2);
  assert.equal(judged.recordFailures.length, 2);
  assert.equal(runVerdict(synthetic, baseline, SYNTHETIC_EXPECT_MIN_FAIL.fqdnLeaks).status, 0);
});

test("合成の記録の作成: 対象の行がない記録は作らず例外にする（行を落として赤を作らない）", () => {
  const withoutRows = { label: "x", totals: {}, rows: [row("control.same-origin-fetch")] };
  assert.throws(() => synthesizeLeaks(withoutRows), /Main 側の行か blob iframe の行がない/);
  assert.throws(() => synthesizeFqdnLeaks(withoutRows), /FQDN の行がない/);
});

test("合成の記録: 同じ形を新しい記録（nc1-g-open）から作るときの前提。実測の fm 系の記録は判定 78 行で合格する", () => {
  // (23a) の形（nc1-fm-*）の判定の前提を測定の記録で固定する: fm-final は合格、機構を外した構成は不合格
  const baseline = load("fm-baseline.json");
  assert.equal(judgeRecord(load("fm-final.json"), { baseline }).fail, 0);
  for (const name of ["fm-no-policy.json", "fm-no-proxy.json", "fm-no-neg-loopback.json"]) {
    assert.ok(judgeRecord(load(name), { baseline }).fail > 0, name);
  }
});

// ── 近い名前・特殊な literal（al0-nearnames の形）────────────────────────

const nearNamesRecord = () => ({
  events: [
    "nc1 orchestrator start => true in 30.0 ms",
    ...Object.entries(NEARNAMES_EXPECTED).map(([name, expected]) =>
      `resolveHost(${name}) => ${expected === "127.0.0.1" ? '["127.0.0.1"]' : "error:net::ERR_NAME_NOT_RESOLVED"}`),
  ],
  nc1: { failures: [] },
});

test("近い名前: EXCLUDE が部分一致・サブドメイン・末尾 dot に効かず、別形式の loopback が 127.0.0.1 になる記録は合格", () => {
  const out = judgeNearNames(nearNamesRecord());
  assert.deepEqual(out.failures, []);
  assert.equal(out.pass, true);
});

test("近い名前: 名前が解決された（glob 化の回帰）、loopback の正規化が崩れた、観測の欠落、start の失敗は不合格", () => {
  const mutate = (name, line) => {
    const record = nearNamesRecord();
    record.events = record.events.map((event) => (event.startsWith(`resolveHost(${name}) =>`) ? line : event));
    return record;
  };
  assert.equal(judgeNearNames(mutate("a.gvt1.com", 'resolveHost(a.gvt1.com) => ["1.2.3.4"]')).pass, false);
  assert.equal(judgeNearNames(mutate("a.b.github.com", 'resolveHost(a.b.github.com) => ["140.82.112.3"]')).pass, false);
  assert.equal(judgeNearNames(mutate("github.com.", 'resolveHost(github.com.) => ["140.82.112.3"]')).pass, false);
  assert.equal(judgeNearNames(mutate("0x7f.0.0.1", "resolveHost(0x7f.0.0.1) => error:net::ERR_NAME_NOT_RESOLVED")).pass, false);
  assert.equal(judgeNearNames(mutate("169.254.169.254", 'resolveHost(169.254.169.254) => ["169.254.169.254"]')).pass, false);
  const missing = nearNamesRecord();
  missing.events = missing.events.filter((event) => !event.startsWith("resolveHost(127.1) =>"));
  assert.match(judgeNearNames(missing).failures.join("|"), /127\.1: resolveHost の観測がない/);
  const noStart = nearNamesRecord();
  noStart.events = noStart.events.slice(1);
  assert.equal(judgeNearNames(noStart).pass, false);
  const failed = nearNamesRecord();
  failed.nc1.failures = ["[grimodex-electron] NC-SELF-RESOLVE"];
  assert.equal(judgeNearNames(failed).pass, false);
});

test("近い名前: 測定の記録 al0-nearnames（AL-0 の旧記録）の observed と同じ期待値を使っている", () => {
  const old = load("al0-nearnames.json");
  for (const [name, expected] of Object.entries(NEARNAMES_EXPECTED)) {
    if (name === "127.0.0.1" || name === "grimodex-rule-sentinel.invalid") continue;
    const line = old.events.find((event) => event.startsWith(`resolveHost(${name}) =>`));
    assert.ok(line, name);
    assert.equal(expected === "127.0.0.1" ? line.endsWith('["127.0.0.1"]') : line.includes(expected), true, line);
  }
});

// ── (29) 外した機構ごとの期待カテゴリ ───────────────────────────────────

const leakRow = (id, extra = {}) => ({ id, outcome: "gathering:gathering", leaked: 4, proxied: 0, ...extra });
const proxyDropRecord = () => ({
  rows: [
    leakRow("main.turn-tcp.sentinel"), leakRow("main.turns.sentinel"), leakRow("main.turns-tcp.sentinel"),
    leakRow("main.turn-tcp.lo4"), leakRow("main.remote-candidate-tcp.lo4", { outcome: "ice:checking" }),
    row("main.stun.lo4"), row("main.turn-udp.lo4"),
  ],
});

test("(29) proxy を外した構成: sentinel 名の TURN-TCP／TURNS／TURNS-TCP と loopback の TCP が漏れ、UDP は漏れない記録は合格", () => {
  const out = judgeControlCategories(proxyDropRecord(), "proxy");
  assert.deepEqual(out.failures, []);
  assert.equal(out.leakedIds.length, 5);
});

test("(29) proxy を外した構成: sentinel の行が 1 つでも漏れていない、UDP が漏れた記録は不合格（検出力の欠陥／表にないカテゴリ）", () => {
  const partial = proxyDropRecord();
  partial.rows = partial.rows.map((r) => (r.id === "main.turns-tcp.sentinel" ? { ...r, leaked: 0 } : r));
  assert.match(judgeControlCategories(partial, "proxy").failures.join("|"), /sentinel/);
  const udp = proxyDropRecord();
  udp.rows.push(leakRow("main.stun.name"));
  assert.match(judgeControlCategories(udp, "proxy").failures.join("|"), /tcp 以外/);
  const none = { rows: proxyDropRecord().rows.map((r) => ({ ...r, leaked: 0 })) };
  assert.equal(judgeControlCategories(none, "proxy").pass, false);
});

test("(29) policy を外した構成は UDP だけ、`<-loopback>` を外した構成は loopback の TCP だけで sentinel 名の TCP は漏れない", () => {
  const policy = { rows: [leakRow("main.stun.lo4"), leakRow("main.turn-udp.lo4"), leakRow("main.remote-candidate-udp.lo4"), leakRow("main.stun.name"), row("main.turn-tcp.sentinel", { proxied: 2 })] };
  assert.deepEqual(judgeControlCategories(policy, "policy", { extraRequired: ["main.stun.name"] }).failures, []);
  assert.equal(judgeControlCategories(policy, "policy", { extraRequired: ["main.turn-udp.name"] }).pass, false);
  const loop = { rows: [leakRow("main.turn-tcp.lo4"), leakRow("main.turn-tcp.localhost"), leakRow("main.remote-candidate-tcp.lo4"), row("main.turn-tcp.sentinel", { proxied: 2 })] };
  assert.deepEqual(judgeControlCategories(loop, "neg-loopback").failures, []);
  loop.rows.push(leakRow("main.turns.sentinel"));
  assert.match(judgeControlCategories(loop, "neg-loopback").failures.join("|"), /この機構のカテゴリではない/);
  assert.equal(judgeControlCategories({ rows: [] }, "unknown").pass, false);
  assert.deepEqual(Object.keys(CONTROL_CATEGORIES).sort(), ["neg-loopback", "policy", "proxy"]);
});
