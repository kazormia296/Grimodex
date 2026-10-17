/**
 * WebRTC の外向き通信を塞ぐ候補の定義と一括実行（`webrtc-block-probe.mjs` を候補ごとに起動する）。
 *   node electron/scripts/webrtc-block-probe-candidates.mjs <candidate-id>... [--out-dir <dir>]
 * 候補の cm／electron の switch は PROXYHOSTPORT を blackhole proxy の host:port に置換して使う。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
    fs.writeFileSync(cmFile, JSON.stringify(cand.cm));
    const args = [
      path.join(here, "webrtc-block-probe.mjs"), "--label", id, "--cm-file", cmFile,
      "--out", path.join(outDir, `${id}.json`),
      ...(cand.netLog ? ["--net-log"] : []),
      ...(cand.proxyMode ? ["--proxy-mode", cand.proxyMode] : []),
      ...(cand.realNetwork ? ["--real-network"] : []),
      ...cand.args.flatMap((a) => ["--electron-arg", a]),
    ];
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env, timeout: 280000 });
    process.stdout.write(r.stdout ?? "");
    if (r.status !== 0) process.stdout.write(`FAILED ${id}: ${(r.stderr ?? "").slice(-600)}\n`);
  }
}
