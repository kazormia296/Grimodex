/**
 * WebRTC の外向き通信を塞ぐ候補の定義と一括実行（`webrtc-block-probe.mjs` を候補ごとに起動する）。
 *   node electron/scripts/webrtc-block-probe-candidates.mjs <candidate-id>... [--out-dir <dir>]
 * 候補の cm／electron の switch は PROXYHOSTPORT を blackhole proxy の host:port に置換して使う。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** allowlist の PAC。alert は net log に残る。blackhole 以外へ出すのは allowed-*.probe.test と辞書 host だけ。 */
const PAC = `function FindProxyForURL(url, host) {
  alert("PAC|" + url + "|" + host);
  if (shExpMatch(host, "allowed-*.probe.test")) return "DIRECT";
  if (host === "redirector.gvt1.com") return "DIRECT";
  return "PROXY PROXYHOSTPORT";
}`;
const pacUrl = (script) =>
  `data:application/x-ns-proxy-autoconfig;charset=utf-8,${encodeURIComponent(script)}`;
const PAC_ALL_BLACKHOLE = `function FindProxyForURL(url, host) { alert("PAC|" + url + "|" + host); return "PROXY PROXYHOSTPORT"; }`;
const POLICY = "disable_non_proxied_udp";
const AL1_BYPASS = "<-loopback>;https://redirector.gvt1.com:443;https://*.gvt1.com:443";
const RULES = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE redirector.gvt1.com, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const NC1_PROXY = { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: AL1_BYPASS };
const RULES_NO_GITHUB = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE redirector.gvt1.com, EXCLUDE *.gvt1.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const RULES_NO_ASSET = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE redirector.gvt1.com, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const RULES_GVT1_ONLY = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE *.gvt1.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const RULES_NONE = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const FINAL_PROXY = { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://*.gvt1.com:443" };
// K3/3 の最終構成の rules（localhost の EXCLUDE を含む。localhost 名の local proxy を使う利用者の更新のため）
const RULES_FINAL = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
// K3/3 の初稿の構成（localhost の EXCLUDE なし）。w1 の再現用
const RULES_FINAL_NO_LOCALHOST = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1";
// 製品の関数 buildHostResolverRules(prefixRules) の試験用の組立て: 試験の prefix（名前の写しと literal の EXCLUDE）を先頭に置き、
// 製品の規則を後ろに足して 1 つの switch にする（appendSwitch は command line の値を置き換えるため、1 回で当てる）
// K3/3 R16: WebRTC は FQDN の remote candidate と STUN／TURN-UDP の名前を末尾 dot つき（rcu-N.probe.test.）で事前解決する。
// 末尾 dot なしの MAP だけでは一致せず、名前が MAP * ~NOTFOUND で拒否されて FQDN の経路が不活性に見えた（R15 までの誤り）。dot つきも写す
const HARNESS_PREFIX = "MAP *.probe.test 127.0.0.1, MAP *.probe.test. 127.0.0.1, EXCLUDE 127.0.0.2, EXCLUDE ::1, EXCLUDE [::1], EXCLUDE LANADDR, ";
const RULES_MIN = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com";
const CONN = { "Connection-Allowlist": "()" };
// K3/3（第 6 版）の推奨 AL-0: renderer の Chromium の通信に許可先を置かない（bypass は <-loopback> だけ。rules に gvt1 を含めない）
const RULES_AL0 = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const AL0_PROXY = { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" };
// K3/3（第 6 版）の代替 AL-3: exact host の redirector.gvt1.com:443 だけを許可する
const RULES_AL3 = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE redirector.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const AL3_PROXY = { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://redirector.gvt1.com:443" };
// 自己確認の入力（FC-1）。IP literal の resolveHost は、規則（MAP * ~NOTFOUND）が欠けると解決されるので、規則の部分欠落の検出に使う
const SELFCHECK_HOSTS = ["grimodex-rule-sentinel.invalid", "example.org", "redirector.gvt1.com", "github.com", "release-assets.githubusercontent.com", "api.github.com", "localhost", "127.0.0.1", "127.0.0.2", "1.1.1.1"];

// ── NC-1（K3/3。NC-1 の lane、S3）: 製品の NC-1 の module を import した試験 main での G-open の構成 ──
// `nc1` は probe の main が製品の module を適用する指定。drop が空なら製品の orchestrator を index.ts と同じ順序で当てる。
// drop に policy／proxy／neg-loopback／rules を入れた構成は、機構を 1 つ外した制御の構成（probe の main だけが持つ）。
// prefixRules は製品の buildHostResolverRules(prefixRules) に渡す試験専用の差し込み口（名前の写し。製品の呼出しは引数なし）。
// 閉じ込めなしの対照は同じ行列の `*-baseline`（cm に nc1 を書かない）。行列は対照と最終で同じにする（RJ は対照にない行を不合格にする）。
const NC1_PREFIX_RULES = HARNESS_PREFIX.split(", ").filter((rule) => rule.length > 0);
// (23a) の形: 名前を末尾 dot つきも含めて canary に写す。(30b) の churn と再読込・遷移の localhost の行を足す
const NC1_ROWS_FM = { gvt1: true, localhostRows: true, fqdn: true, reload: true, churn: true };
// (23b) の形: 実 DNS。link-local、`.local`（UDP 5353 の観測）、再読込・遷移の localhost の行を足す
const NC1_ROWS_LL = { dns: true, gvt1: true, localhostRows: true, linklocal: true, local: true, reload: true };
const NC1_ROWS_FQ = { dns: true, gvt1: true, localhostRows: true, linklocal: true, fqdn: true };
const NC1_ROWS_NL = { dns: true, gvt1: true, localhostRows: true, rs1: true };
const NC1_ROWS_SX = { dns: true, secx: true, localhostRows: true };
// (33): 更新（electron-updater 方式）と env の proxy。noProbes の行列なし
const NC1_UPDATER = { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, resolveHostTests: ["github.com", "localhost"] };
const nc1Final = (rows, extra = {}) => ({ cm: { ...rows, nc1: {}, resolveHostTests: SELFCHECK_HOSTS, ...extra.cm }, args: [], realNetwork: true, dnsLog: true, ...extra.cand });
const NC1_DEFS = {
  // ── (23a): 名前の写し（prefix）を当てた proxy と policy の層の単独の合否 ──
  "nc1-fm-baseline": { cm: { ...NC1_ROWS_FM }, args: [], dnsLog: true },
  "nc1-fm-final": { cm: { ...NC1_ROWS_FM, nc1: { prefixRules: NC1_PREFIX_RULES } }, args: [], realNetwork: true, dnsLog: true },
  // (29): 機構を 1 つずつ外した (23a) の形
  "nc1-fm-no-policy": { cm: { ...NC1_ROWS_FM, nc1: { drop: ["policy"], prefixRules: NC1_PREFIX_RULES } }, args: [], realNetwork: true, dnsLog: true },
  "nc1-fm-no-proxy": { cm: { ...NC1_ROWS_FM, nc1: { drop: ["proxy"], prefixRules: NC1_PREFIX_RULES } }, args: [], realNetwork: true, dnsLog: true },
  "nc1-fm-no-neg-loopback": { cm: { ...NC1_ROWS_FM, nc1: { drop: ["neg-loopback"], prefixRules: NC1_PREFIX_RULES } }, args: [], realNetwork: true, dnsLog: true },
  // ── (23b): 実 DNS の rules（prefix なし）。ll／fq／nl／sx の 4 つの形 ──
  "nc1-ll-baseline": { cm: { ...NC1_ROWS_LL }, args: [], realNetwork: true, dnsLog: true, mdns: true },
  "nc1-ll-final": { ...nc1Final(NC1_ROWS_LL), mdns: true },
  "nc1-fq-baseline": { cm: { ...NC1_ROWS_FQ }, args: [], realNetwork: true, dnsLog: true },
  "nc1-fq-final": nc1Final(NC1_ROWS_FQ),
  "nc1-nl-baseline": { cm: { ...NC1_ROWS_NL }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "nc1-nl-final": { ...nc1Final(NC1_ROWS_NL), netLog: true },
  "nc1-sx-baseline": { cm: { ...NC1_ROWS_SX }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "nc1-sx-final": { ...nc1Final(NC1_ROWS_SX), netLog: true },
  // ── (32): DoH の canary による名前の観測（getaddrinfo を使わない。nl の行列、net log つき）──
  "nc1-doh-baseline": { cm: { ...NC1_ROWS_NL, doh: true }, args: [], realNetwork: true, doh: true, netLog: true },
  "nc1-doh-final": { ...nc1Final(NC1_ROWS_NL, { cm: { doh: true } }), doh: true, dnsLog: false, netLog: true },
  // ── (23c): (23b) の途中で network service を SIGKILL して再起動させた後 ──
  "nc1-ll-kill": { ...nc1Final(NC1_ROWS_LL, { cm: { killNetworkService: true } }), mdns: true },
  // ── (29): 機構を 1 つずつ外した (23b) の形（<-loopback> と policy は link-local の行で「canary 0 のまま不合格」を示す。rules は名前の観測で示す）──
  "nc1-ll-no-neg-loopback": { cm: { ...NC1_ROWS_LL, nc1: { drop: ["neg-loopback"] }, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, mdns: true },
  "nc1-ll-no-policy": { cm: { ...NC1_ROWS_LL, nc1: { drop: ["policy"] }, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, mdns: true },
  "nc1-nl-no-rules": { cm: { ...NC1_ROWS_NL, nc1: { drop: ["rules"] } }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  // ── (33): 更新と OS／env の proxy（AL-0 の構成で取り直す）。w0 は閉じ込めなしの対照 ──
  "nc1-w0-envproxy-localhost-baseline": { cm: { ...NC1_UPDATER }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "localhost" },
  "nc1-w2-envproxy-localhost-final": { cm: { ...NC1_UPDATER, nc1: {} }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "localhost" },
  "nc1-w3-envproxy-127-final": { cm: { ...NC1_UPDATER, nc1: {} }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "127.0.0.1" },
  "nc1-w4-envproxy-lan-final": { cm: { ...NC1_UPDATER, nc1: {} }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "lan" },
  "nc1-w5-envproxy-hostname-final": { cm: { ...NC1_UPDATER, nc1: {} }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "hostname" },
  // 外部網に依存する更新の確認と asset の取得（合否にせず、結果と日時を記録する）
  "nc1-upd-baseline": { cm: { noProbes: true, realUpdater: true, realRedirect: "https://github.com/electron/electron/releases/download/v43.5.0/SHASUMS256.txt" }, args: [], realNetwork: true, dnsLog: true },
  "nc1-upd-final": { cm: { noProbes: true, realUpdater: true, realRedirect: "https://github.com/electron/electron/releases/download/v43.5.0/SHASUMS256.txt", nc1: {} }, args: [], realNetwork: true, dnsLog: true },
  // ── 実機の観測（DR-NC1-9／18 の引き継ぎ）──
  // DevTools の webContents は default session か（NC-SESSION を誤って起こさないか）
  "nc1-devtools": { cm: { noProbes: true, devtools: true, nc1: {} }, args: [], realNetwork: true },
  // NC-SESSION: default session でない窓。製品は何も読み込ませず破棄し、graceful な終了に入る（SIGSEGV しない）。none は閉じ込めなしの対照（server に届く）
  "nc1-session-fail": { cm: { noProbes: true, ncSession: true, nc1: {} }, args: [], realNetwork: true },
  "nc1-session-none": { cm: { noProbes: true, ncSession: true }, args: [], realNetwork: true },
  // NC-POLICY の注入（実 webContents の policy の適用を失敗させる）。ok は policy が当たって script が走る正の対照、none は閉じ込めなし（script が走り UDP が canary に届く）
  "nc1-policy-fail": { cm: { noProbes: true, pageRan: true, nc1: { failPolicy: true } }, args: [], realNetwork: true },
  "nc1-policy-ok": { cm: { noProbes: true, pageRan: true, nc1: {} }, args: [], realNetwork: true },
  "nc1-policy-none": { cm: { noProbes: true, pageRan: true }, args: [], realNetwork: true },
};

export const CANDIDATES = {
  ...NC1_DEFS,
  baseline: { cm: {}, args: [] },
  // (a) default session の PAC
  "a1-default-pac": { cm: { target: "default", proxy: { mode: "pac_script", pacScript: pacUrl(PAC) } }, args: [], netLog: true },
  "a1c-default-pac-closed-proxy": { cm: { target: "default", proxy: { mode: "pac_script", pacScript: pacUrl(PAC) } }, args: [], proxyMode: "closed", netLog: true },
  "a2-default-pac+policy": { cm: { target: "default", policy: POLICY, proxy: { mode: "pac_script", pacScript: pacUrl(PAC) } }, args: [], netLog: true },
  // (b) renderer 窓専用の partition
  "b1-partition-fixed": { cm: { target: "partition", proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT" } }, args: [] },
  "b2-partition-pac": { cm: { target: "partition", proxy: { mode: "pac_script", pacScript: pacUrl(PAC) } }, args: [], netLog: true },
  "b3-partition-pac+policy": { cm: { target: "partition", policy: POLICY, proxy: { mode: "pac_script", pacScript: pacUrl(PAC) } }, args: [], netLog: true },
  "b4-partition-fixed-http+policy": { cm: { target: "partition", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "http://PROXYHOSTPORT", proxyBypassRules: "" } }, args: [] },
  // (c) fixed_servers と bypass list
  "c1-fixed-bypass-local": { cm: { target: "default", proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "localhost,127.0.0.1,<local>" } }, args: [] },
  "c2-fixed-default-bypass": { cm: { target: "default", proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT" } }, args: [] },
  "c3-fixed-neg-loopback": { cm: { target: "default", proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [] },
  "c4-fixed-neg-loopback+allowed": { cm: { target: "default", proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;allowed-*.probe.test;redirector.gvt1.com" } }, args: [] },
  "c5-fixed-neg-loopback+policy": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [] },
  // (d) コマンドラインの switch
  "d1-cmdline-proxy": { cm: {}, args: ["--proxy-server=socks5://PROXYHOSTPORT"] },
  "d2-cmdline-proxy+bypass": { cm: {}, args: ["--proxy-server=socks5://PROXYHOSTPORT", "--proxy-bypass-list=<-loopback>;allowed-*.probe.test;redirector.gvt1.com"] },
  "d3-cmdline-proxy-bypass-local": { cm: {}, args: ["--proxy-server=socks5://PROXYHOSTPORT", "--proxy-bypass-list=localhost;127.0.0.1;<local>"] },
  "d4-cmdline-proxy+policy": { cm: { policy: POLICY }, args: ["--proxy-server=socks5://PROXYHOSTPORT", "--proxy-bypass-list=<-loopback>"] },
  // (e) preload の main world 無効化
  "e1-preload-disable": { cm: { disablePreload: true }, args: [] },
  // (f) そのほか
  "f1-connection-allowlist-header": { cm: { headers: CONN }, args: ["--enable-features=ConnectionAllowlists"] },
  "f1b-connection-allowlist-header-nofeature": { cm: { headers: CONN }, args: [] },
  "f2-policy-only": { cm: { policy: POLICY }, args: [] },
  "f3-udp-range": { cm: { udpRange: [1, 1] }, args: [] },
  "f4-resolver-block": { cm: {}, args: [], extraResolver: true },
  "f5-webrequest": { cm: { webRequest: true }, args: [] },
  "f6-enforce-ip-permission": { cm: {}, args: ["--enforce-webrtc-ip-permission-check", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] },
  "g1-c5-netlog": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" }, waitMs: 5000 }, args: [], netLog: true },
  "g2-c5-closed-proxy": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [], proxyMode: "closed" },
  "g3-c5-http-proxy": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "http://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [] },
  "g4-port-scoped-https": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://allowed-*.probe.test:CANARYP" } }, args: [] },
  "g5-port-scoped-http": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;http://allowed-*.probe.test:CANARYP" } }, args: [] },
  "g6-port-scoped-noscheme": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;allowed-*.probe.test:CANARYP" } }, args: [] },
  "b5-partition-fixed-neg-loopback+policy": { cm: { target: "partition", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" }, waitMs: 5000 }, args: [], netLog: true },
  "f4a-resolver-only": { cm: { resolverRules: "MAP *.probe.test 127.0.0.1, MAP * ~NOTFOUND" }, args: [] },
  "f4b-resolver+policy": { cm: { resolverRules: "MAP *.probe.test 127.0.0.1, MAP * ~NOTFOUND", policy: POLICY }, args: [] },
  "f8-conn-allowlist-http-page": { cm: { loadUrl: "http-page", pageHeader: "()" }, args: ["--enable-features=ConnectionAllowlists"] },
  "f8b-http-page-no-header": { cm: { loadUrl: "http-page" }, args: ["--enable-features=ConnectionAllowlists"] },
  "f8c-conn-allowlist-blink-feature": { cm: { loadUrl: "http-page", pageHeader: '("https://nonexistent.invalid:1")', quick: true }, args: ["--enable-blink-features=ConnectionAllowlists", "--enable-features=ConnectionAllowlists"] },
  "r4-real-dictionary-wildcard": { cm: { target: "default", noProbes: true, waitMs: 8000, policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "http://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://redirector.gvt1.com:443;https://*.gvt1.com:443" } }, args: [], netLog: true, realNetwork: true },
  "h1-final-c5": { cm: { target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [] },
  "h2-proxy-only": { cm: { target: "default", proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [] },
  "h3-policy-only": { cm: { policy: POLICY }, args: [] },
  "h0-baseline": { cm: {}, args: [] },
  "r5-real-dictionary-none": { cm: { target: "default", noProbes: true, waitMs: 8000, policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "http://PROXYHOSTPORT", proxyBypassRules: "<-loopback>" } }, args: [], netLog: true, realNetwork: true },
  "r3-real-dictionary-allowed": { cm: { target: "default", noProbes: true, waitMs: 8000, policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "http://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://redirector.gvt1.com:443" } }, args: [], netLog: true, realNetwork: true },
  // ── DNS の経路の試験（実ネットワーク＋名前解決の記録層。PROBE_DNSLOG_LIB に .so） ──
  "n0-dns-baseline": { cm: { dns: true }, args: [], realNetwork: true, dnsLog: true },
  "n1-nc1-al1-dns": { cm: { dns: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: AL1_BYPASS } }, args: [], realNetwork: true, dnsLog: true },
  "n2-nc1-al1+rules": { cm: { dns: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: AL1_BYPASS }, resolverSwitch: RULES, resolveHostTests: ["grimodex-rule-sentinel.invalid", "example.org", "redirector.gvt1.com"] }, args: [], realNetwork: true, dnsLog: true },
  // ── updater／辞書／環境 proxy／network service 再起動（DNS の閉じ込めの影響の試験）──
  "u1-updater-baseline": { cm: { noProbes: true, realUpdater: true }, args: [], realNetwork: true, dnsLog: true },
  "u2-updater-nc1+rules": { cm: { noProbes: true, realUpdater: true, target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES }, args: [], realNetwork: true, dnsLog: true },
  "u3-updater-nc1+rules-no-github": { cm: { noProbes: true, realUpdater: true, target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES_NO_GITHUB }, args: [], realNetwork: true, dnsLog: true },
  "u4-updater-envproxy-baseline": { cm: { noProbes: true, realUpdater: true, updaterSessionProxy: { mode: "fixed_servers", proxyRules: "http://FAKEHTTPPROXY" } }, args: [], realNetwork: true, dnsLog: true, fakeHttpProxy: true },
  "u5-updater-envproxy-nc1+rules": { cm: { noProbes: true, realUpdater: true, updaterSessionProxy: { mode: "fixed_servers", proxyRules: "http://FAKEHTTPPROXY" }, target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES }, args: [], realNetwork: true, dnsLog: true, fakeHttpProxy: true },
  "u6-updater-envproxy-nc1+rules-excl": { cm: { noProbes: true, realUpdater: true, updaterSessionProxy: { mode: "fixed_servers", proxyRules: "http://FAKEHTTPPROXY" }, target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES + ", EXCLUDE HOSTNAME" }, args: [], realNetwork: true, dnsLog: true, fakeHttpProxy: true },
  "v1-asset-baseline": { cm: { noProbes: true, realRedirect: "https://github.com/electron/electron/releases/download/v43.5.0/SHASUMS256.txt" }, args: [], realNetwork: true, dnsLog: true },
  "v2-asset-nc1+rules": { cm: { noProbes: true, realRedirect: "https://github.com/electron/electron/releases/download/v43.5.0/SHASUMS256.txt", target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES }, args: [], realNetwork: true, dnsLog: true },
  "v3-asset-nc1+rules-no-asset-hosts": { cm: { noProbes: true, realRedirect: "https://github.com/electron/electron/releases/download/v43.5.0/SHASUMS256.txt", target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES_NO_ASSET }, args: [], realNetwork: true, dnsLog: true },
  // ── 最終構成の記録（AL-1 は *.gvt1.com:443 の 1 件、RULES は閉じた集合）──
  // localhost の行を加えた行列のベースライン（閉じ込めなし）。localhost 名の TCP が canary に届くことの正の対照
  "z0-baseline-localhost": { cm: { localhostRows: true, gvt1: true }, args: [] },
  // 試験の差し込み口（K3/3 の buildHostResolverRules(prefixRules)）の根拠。
  // x1: command line の host-resolver-rules と main の appendSwitch が同じ switch を置き換えること（試験 main が別に規則を渡す構成は成立しない）
  "x1-cli-rules-replaced": { cm: { noProbes: true, resolverSwitch: RULES_FINAL, resolveHostTests: ["foo.probe.test", "grimodex-rule-sentinel.invalid", "localhost", "github.com"] }, args: [] },
  // x2: prefix を 1 つの switch に合成すると、名前の写し（試験用）と製品の規則が同時に効くこと
  "x2-prefix-composed": { cm: { noProbes: true, resolverSwitch: HARNESS_PREFIX + RULES_FINAL, resolveHostTests: ["foo.probe.test", "grimodex-rule-sentinel.invalid", "localhost", "github.com", "example.org", "127.0.0.2"] }, args: [], realNetwork: true },
  // 機構を 1 つずつ外した最終構成（Negative (29) の期待値の根拠）
  "z8-final-no-neg-loopback": { cm: { dns: false, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "https://*.gvt1.com:443" }, resolverSwitch: HARNESS_PREFIX + RULES_FINAL }, args: [], realNetwork: true },
  "z9-final-no-policy": { cm: { dns: false, gvt1: true, localhostRows: true, target: "default", proxy: FINAL_PROXY, resolverSwitch: HARNESS_PREFIX + RULES_FINAL }, args: [], realNetwork: true },
  "z10-final-no-rules": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: FINAL_PROXY }, args: [], realNetwork: true, dnsLog: true },
  "z11-final-no-proxy": { cm: { dns: false, gvt1: true, localhostRows: true, policy: POLICY, resolverSwitch: HARNESS_PREFIX + RULES_FINAL }, args: [], realNetwork: true },
  // z2 と同じ行列（DNS の行、gvt1、localhost を含む）のベースライン（閉じ込めなし、実 DNS、名前解決の記録層）
  "z12-baseline-real-dns": { cm: { dns: true, gvt1: true, localhostRows: true }, args: [], realNetwork: true, dnsLog: true },
  "z1-final-harness": { cm: { dns: false, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: HARNESS_PREFIX + RULES_FINAL }, args: [], realNetwork: true },
  "z2-final-real": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, resolveHostTests: ["grimodex-rule-sentinel.invalid", "example.org", "redirector.gvt1.com", "github.com", "release-assets.githubusercontent.com", "api.github.com"] }, args: [], realNetwork: true, dnsLog: true },
  "z3-min-rules-real": { cm: { dns: true, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_MIN }, args: [], realNetwork: true, dnsLog: true },
  "z4-rules+policy-only-real": { cm: { dns: true, gvt1: true, policy: POLICY, resolverSwitch: RULES_MIN }, args: [], realNetwork: true, dnsLog: true },
  "z5-rules-only-real": { cm: { dns: true, gvt1: true, resolverSwitch: RULES_MIN }, args: [], realNetwork: true, dnsLog: true },
  // ── OS 非依存の名前解決の観測（DoH の canary。LD_PRELOAD を使わない）──
  "o0-doh-baseline": { cm: { dns: true, doh: true }, args: [], realNetwork: true, doh: true },
  "o1-doh-nc1-al1": { cm: { dns: true, doh: true, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY }, args: [], realNetwork: true, doh: true },
  "o2-doh-final": { cm: { dns: true, doh: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL }, args: [], realNetwork: true, doh: true },
  "d1-dictionary-wild-socks+rules": { cm: { noProbes: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://*.gvt1.com:443" }, resolverSwitch: RULES_GVT1_ONLY }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "d2-dictionary-no-allow+rules": { cm: { noProbes: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES_NONE }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "k1-netservice-kill+rules": { cm: { dns: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: AL1_BYPASS }, resolverSwitch: RULES, killNetworkService: true }, args: [], realNetwork: true, dnsLog: true },
  // K3/3 の最終構成（AL-1 1 件、RULES_FINAL）で network service を SIGKILL
  "k2-netservice-kill-final": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, killNetworkService: true }, args: [], realNetwork: true, dnsLog: true },
  // ── K3/3（第 6 版）: 推奨 AL-0 と代替 AL-3 の記録（行列は z2 と同じ 111 行。resolveHost の入力に IP literal を含む）──
  "al0-final-real": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true },
  "al3-final-real": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: AL3_PROXY, resolverSwitch: RULES_AL3, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true },
  // 辞書の取得（spellchecker を有効にして起こす）。AL-0 は取得できず、AL-3 は redirector までで redirect 先が止まる見込み
  // ── K3/3 R8: net log の host resolver のイベントの host の形（拒否された名前は ~NOTFOUND に書き換わる）と RS-1 の行 ──
  // 閉じ込めなし（正の対照）と AL-0 の最終構成。行列は al0-final-real と同じ 111 行に RS-1 の行（rs1）を足す
  "nl-baseline": { cm: { dns: true, gvt1: true, localhostRows: true, rs1: true }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "nl-al0-final": { cm: { dns: true, gvt1: true, localhostRows: true, rs1: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  // 行列なし（renderer の試行なし）の AL-0。起動と辞書の要求だけで net log に出る host
  "nl-al0-idle": { cm: { noProbes: true, spellcheck: true, waitMs: 6000, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "al0-dict": { cm: { noProbes: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "al3-dict": { cm: { noProbes: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: AL3_PROXY, resolverSwitch: RULES_AL3, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  // 更新（確認と asset の redirect）が AL-0 でも通ること
  "al0-updater": { cm: { noProbes: true, realUpdater: true, realRedirect: "https://github.com/electron/electron/releases/download/v43.5.0/SHASUMS256.txt", target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0 }, args: [], realNetwork: true, dnsLog: true },
  // 自己確認の負例: sentinel の MAP だけ（MAP * ~NOTFOUND と EXCLUDE が欠落）。sentinel と proxy の解決は最終構成と同じになり、IP literal と名前は解決される
  "al0-selfcheck-sentinel-only": { cm: { noProbes: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: "MAP grimodex-rule-sentinel.invalid 127.0.0.1", resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true },
  // network service の SIGKILL 後の持続、閉じた proxy port（listener なし）でも fail-closed か
  "al0-netservice-kill": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, killNetworkService: true }, args: [], realNetwork: true, dnsLog: true },
  "al0-closed-proxy": { cm: { dns: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0 }, args: [], proxyMode: "closed", realNetwork: true, dnsLog: true },
  // 近い名前・特殊な literal の解決（rules の glob と literal の扱いを固定する行）
  "al0-nearnames": { cm: { noProbes: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: ["gvt1.com", "xgvt1.com", "a.gvt1.com", "a.b.github.com", "github.com.", "github.com.evil.test", "evil.release-assets.githubusercontent.com", "api.github.com", "x.localhost", "localhost.", "foo.local", "127.1", "0x7f.0.0.1", "2130706433", "127.0.0.1.", "[::1]", "169.254.169.254"] }, args: [], realNetwork: true },
  // OS 非依存の名前解決の観測（DoH の canary）。AL-0 の最終構成
  "al0-doh": { cm: { dns: true, doh: true, gvt1: true, localhostRows: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0 }, args: [], realNetwork: true, doh: true },
  // 自己確認の正例（最終構成。AL-0）
  "al0-selfcheck-final": { cm: { noProbes: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true },
  // ── 環境変数の proxy（desktop 環境の変数を外すと Chromium は env を読む）と更新・辞書への影響 ──
  // localhost 名・127.0.0.1・LAN の literal・hostname の proxy を、baseline／初稿の最終構成／最終構成で比べる
  "w0-envproxy-localhost-baseline": { cm: { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, resolveHostTests: ["github.com", "localhost"] }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "localhost" },
  "w1-envproxy-localhost-final-nolocalhost": { cm: { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL_NO_LOCALHOST, resolveHostTests: ["github.com", "localhost"] }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "localhost" },
  "w2-envproxy-localhost-final": { cm: { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, resolveHostTests: ["github.com", "localhost"] }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "localhost" },
  "w3-envproxy-127-final": { cm: { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, resolveHostTests: ["github.com", "localhost"] }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "127.0.0.1" },
  "w4-envproxy-lan-final": { cm: { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, resolveHostTests: ["github.com", "localhost"] }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "lan" },
  "w5-envproxy-hostname-final": { cm: { noProbes: true, realUpdater: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, resolveHostTests: ["github.com", "localhost"] }, args: [], realNetwork: true, dnsLog: true, clearDesktop: true, fakeProxyForm: "hostname" },
  // ── K3/3 R12: 行ごとの合否の根拠。link-local の行（canary を置けない宛先）を足した AL-0 の最終構成と、機構を 1 つずつ外した対照 ──
  "ll-al0-final": { cm: { dns: true, gvt1: true, localhostRows: true, linklocal: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true },
  "ll-al0-no-neg-loopback": { cm: { dns: true, gvt1: true, localhostRows: true, linklocal: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT" }, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true },
  "ll-al0-no-policy": { cm: { dns: true, gvt1: true, localhostRows: true, linklocal: true, target: "default", proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true },
  "ll-baseline": { cm: { dns: true, gvt1: true, localhostRows: true, linklocal: true }, args: [], realNetwork: true, dnsLog: true },
  // ── K3/3 R15: FQDN の remote candidate の行（非 mDNS の FQDN。接続を試みない行）を足した再走 ──
  "fq-baseline": { cm: { dns: true, gvt1: true, localhostRows: true, linklocal: true, fqdn: true }, args: [], realNetwork: true, dnsLog: true },
  // fq-baseline-mapped は R16 で取り下げた（名前の写しが末尾 dot つきの名前に一致せず FQDN が解決されなかった）。fm-baseline が後継
  "fq-al0-final": { cm: { dns: true, gvt1: true, localhostRows: true, linklocal: true, fqdn: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true },
  // ── K3/3 R16: 名前を 127.0.0.1 へ写す構成（末尾 dot つきも写す）で、FQDN の remote candidate と名前の UDP を活性にした対照と、機構を 1 つずつ外した構成 ──
  // fm-baseline は閉じ込めなし（非 real-network。既定の rules が MAP を持つ）。fm-final は proxy＋policy＋AL-0 の rules を、名前の写しを prefix にして 1 つの switch にした形（(23a)）
  "fm-baseline": { cm: { gvt1: true, localhostRows: true, fqdn: true }, args: [], dnsLog: true },
  "fm-final": { cm: { gvt1: true, localhostRows: true, fqdn: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: HARNESS_PREFIX + RULES_AL0 }, args: [], realNetwork: true, dnsLog: true },
  "fm-no-policy": { cm: { gvt1: true, localhostRows: true, fqdn: true, target: "default", proxy: AL0_PROXY, resolverSwitch: HARNESS_PREFIX + RULES_AL0 }, args: [], realNetwork: true, dnsLog: true },
  "fm-no-proxy": { cm: { gvt1: true, localhostRows: true, fqdn: true, policy: POLICY, resolverSwitch: HARNESS_PREFIX + RULES_AL0 }, args: [], realNetwork: true, dnsLog: true },
  "fm-no-neg-loopback": { cm: { gvt1: true, localhostRows: true, fqdn: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT" }, resolverSwitch: HARNESS_PREFIX + RULES_AL0 }, args: [], realNetwork: true, dnsLog: true },
  // 独立のレビューの追加行（大文字小文字、数値形式の literal、pool／relay、複数 URL、setConfiguration、WebTransport）。secx を足した 2 構成
  "sx-baseline": { cm: { dns: true, secx: true, localhostRows: true }, args: [], realNetwork: true, dnsLog: true },
  "sx-al0-final": { cm: { dns: true, secx: true, localhostRows: true, target: "default", policy: POLICY, proxy: AL0_PROXY, resolverSwitch: RULES_AL0, resolveHostTests: SELFCHECK_HOSTS }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "f7-app-setproxy": { cm: { appSetProxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT" } }, args: [] },
};

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}` && argv.length > 0) {
  let outDir = process.env.TMPDIR || "/tmp";
  const ids = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir") outDir = argv[++i];
    else ids.push(argv[i]);
  }
  for (const id of ids) {
    const cand = CANDIDATES[id];
    if (!cand) throw new Error(`unknown candidate ${id}`);
    const cmFile = path.join(outDir, `${id}.cm.json`);
    fs.writeFileSync(cmFile, JSON.stringify(cand.cm).replaceAll("HOSTNAME", os.hostname()));
    const args = [
      path.join(here, "webrtc-block-probe.mjs"), "--label", id, "--cm-file", cmFile,
      "--out", path.join(outDir, `${id}.json`),
      ...(cand.netLog ? ["--net-log"] : []),
      ...(cand.proxyMode ? ["--proxy-mode", cand.proxyMode] : []),
      ...(cand.realNetwork ? ["--real-network"] : []),
      ...(cand.doh ? ["--doh"] : []),
      ...(cand.mdns ? ["--mdns"] : []),
      ...(cand.fakeHttpProxy ? ["--fake-http-proxy"] : []),
      ...(cand.fakeProxyForm ? ["--fake-proxy-form", cand.fakeProxyForm] : []),
      ...(cand.clearDesktop ? ["--clear-desktop"] : []),
      ...(cand.dnsLog ? ["--dns-log", process.env.PROBE_DNSLOG_LIB ?? "/dev/shm/dnslog.so"] : []),
      ...Object.entries(cand.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      ...cand.args.flatMap((a) => ["--electron-arg", a]),
    ];
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env, timeout: 900000 });
    process.stdout.write(r.stdout ?? "");
    if (r.status !== 0) process.stdout.write(`FAILED ${id}: ${(r.stderr ?? "").slice(-600)}\n`);
  }
}
