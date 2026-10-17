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
const RULES_FINAL = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1";
const RULES_MIN = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE *.gvt1.com, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com";
const CONN = { "Connection-Allowlist": "()" };

export const CANDIDATES = {
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
  "z1-final-harness": { cm: { dns: false, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverRules: "MAP *.probe.test 127.0.0.1, MAP *.gvt1.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2, EXCLUDE [::1], EXCLUDE ::1, EXCLUDE LANADDR, EXCLUDE localhost" }, args: [] },
  "z2-final-real": { cm: { dns: true, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL, resolveHostTests: ["grimodex-rule-sentinel.invalid", "example.org", "redirector.gvt1.com", "github.com", "release-assets.githubusercontent.com", "api.github.com"] }, args: [], realNetwork: true, dnsLog: true },
  "z3-min-rules-real": { cm: { dns: true, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_MIN }, args: [], realNetwork: true, dnsLog: true },
  "z4-rules+policy-only-real": { cm: { dns: true, gvt1: true, policy: POLICY, resolverSwitch: RULES_MIN }, args: [], realNetwork: true, dnsLog: true },
  "z5-rules-only-real": { cm: { dns: true, gvt1: true, resolverSwitch: RULES_MIN }, args: [], realNetwork: true, dnsLog: true },
  // ── OS 非依存の名前解決の観測（DoH の canary。LD_PRELOAD を使わない）──
  "o0-doh-baseline": { cm: { dns: true, doh: true }, args: [], realNetwork: true, doh: true },
  "o1-doh-nc1-al1": { cm: { dns: true, doh: true, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY }, args: [], realNetwork: true, doh: true },
  "o2-doh-final": { cm: { dns: true, doh: true, gvt1: true, target: "default", policy: POLICY, proxy: FINAL_PROXY, resolverSwitch: RULES_FINAL }, args: [], realNetwork: true, doh: true },
  "d1-dictionary-wild-socks+rules": { cm: { noProbes: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: "<-loopback>;https://*.gvt1.com:443" }, resolverSwitch: RULES_GVT1_ONLY }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "d2-dictionary-no-allow+rules": { cm: { noProbes: true, spellcheck: true, waitMs: 9000, target: "default", policy: POLICY, proxy: NC1_PROXY, resolverSwitch: RULES_NONE }, args: [], realNetwork: true, dnsLog: true, netLog: true },
  "k1-netservice-kill+rules": { cm: { dns: true, target: "default", policy: POLICY, proxy: { mode: "fixed_servers", proxyRules: "socks5://PROXYHOSTPORT", proxyBypassRules: AL1_BYPASS }, resolverSwitch: RULES, killNetworkService: true }, args: [], realNetwork: true, dnsLog: true },
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
      ...(cand.fakeHttpProxy ? ["--fake-http-proxy"] : []),
      ...(cand.dnsLog ? ["--dns-log", process.env.PROBE_DNSLOG_LIB ?? "/dev/shm/dnslog.so"] : []),
      ...Object.entries(cand.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      ...cand.args.flatMap((a) => ["--electron-arg", a]),
    ];
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env, timeout: 900000 });
    process.stdout.write(r.stdout ?? "");
    if (r.status !== 0) process.stdout.write(`FAILED ${id}: ${(r.stderr ?? "").slice(-600)}\n`);
  }
}
