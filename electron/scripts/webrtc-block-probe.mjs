/**
 * WebRTC の外向き通信を構造的に塞げるかの実機試験（NIR-1 Y-1 の続き。DA-1 の finding の対処候補）。
 *
 *   node electron/scripts/webrtc-block-probe.mjs --label <name> [--cm '<json>'] [--electron-arg <switch>]...
 *        [--proxy-mode listener|closed] [--out <file>] [--keep]
 *
 * 何をするか:
 * - loopback の複数の canary（127.0.0.1 の port p と別 port q、127.0.0.2、[::1]、LAN の IPv4。
 *   すべて TCP と UDP）と、blackhole の proxy の listener（接続と先頭の bytes を数える）と、
 *   Main 側の通信の確認用 HTTP server を立てる。
 * - `webrtc-block-probe-main.mjs` を Electron（`scripts/local-ci-xvfb.mjs` 経由の host namespace の Xvfb）で
 *   起動し、PROBE_CM の候補を適用して RTCPeerConnection の全 variant を試す。
 * - canary が受信した接続・datagram を、試験ごとの時間窓に帰属させる。canary への到達 = 「漏れ」、
 *   proxy の listener への到達 = 「proxy へ向けた」。
 * 起動の規則: WAYLAND_DISPLAY、XDG_SESSION_TYPE、DBUS_SESSION_BUS_ADDRESS、env の proxy を外す。
 * `unshare -n` は使わない。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import http2 from "node:http2";
import { execFileSync } from "node:child_process";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const TIMEOUT_MS = 900_000;

function parseArgs(argv) {
  const args = {
    label: "run",
    cm: {},
    electronArgs: [],
    proxyMode: "listener",
    out: "",
    keep: false,
    netLog: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--label") args.label = argv[++i];
    else if (a === "--cm") args.cm = JSON.parse(argv[++i]);
    else if (a === "--cm-file") args.cm = JSON.parse(fs.readFileSync(argv[++i], "utf8"));
    else if (a === "--electron-arg") args.electronArgs.push(argv[++i]);
    else if (a === "--proxy-mode") args.proxyMode = argv[++i];
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--keep") args.keep = true;
    else if (a === "--net-log") args.netLog = true;
    else if (a === "--real-network") args.realNetwork = true;
    else if (a === "--doh") args.doh = true;
    else if (a === "--fake-http-proxy") args.fakeHttpProxy = true;
    else if (a === "--fake-proxy-form") args.fakeProxyForm = argv[++i];
    else if (a === "--clear-desktop") args.clearDesktop = true;
    else if (a === "--dns-log") args.dnsLib = argv[++i];
    else if (a === "--env") { const [k, ...v] = argv[++i].split("="); (args.env ??= {})[k] = v.join("="); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** DoH の canary（OS 非依存の名前解決の観測）。Chromium の secure DNS をこの server に向け、QNAME を数える */
async function startDohCanary(work) {
  const key = path.join(work, "doh.key");
  const crt = path.join(work, "doh.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const queries = [];
  const parse = (buf) => {
    let i = 12; const labels = [];
    while (i < buf.length && buf[i] !== 0) { const l = buf[i]; labels.push(buf.subarray(i + 1, i + 1 + l).toString("latin1")); i += l + 1; }
    const qtype = buf.readUInt16BE(i + 1);
    return { name: labels.join("."), qtype, end: i + 5 };
  };
  const reply = (buf, end) => {
    const out = Buffer.from(buf.subarray(0, end));
    out[2] = 0x81; out[3] = 0x83; // QR, RD, RA, RCODE=3 (NXDOMAIN)
    out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
    return out;
  };
  const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt), allowHTTP1: true });
  server.on("request", (req, res) => {
    const finish = (buf) => {
      try {
        const q = parse(buf);
        queries.push({ at: Date.now(), name: q.name, qtype: q.qtype });
        res.writeHead(200, { "content-type": "application/dns-message" });
        res.end(reply(buf, q.end));
      } catch { res.writeHead(400); res.end(); }
    };
    if (req.method === "POST") {
      const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => finish(Buffer.concat(chunks)));
    } else {
      const dns = new URL(req.url, "https://x").searchParams.get("dns") ?? "";
      finish(Buffer.from(dns, "base64url"));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, queries, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

async function startCanary(label, addr, v6 = false) {
  const hits = [];
  const tcp = net.createServer((socket) => {
    const at = Date.now();
    hits.push({ label, proto: "tcp-connect", at, head: "" });
    socket.on("data", (d) =>
      hits.push({ label, proto: "tcp-data", at, head: d.toString("latin1").slice(0, 200) }),
    );
    socket.on("error", () => {});
    socket.setTimeout(3000, () => socket.destroy());
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(0, addr, resolve);
    });
    const port = tcp.address().port;
    const udp = dgram.createSocket(v6 ? "udp6" : "udp4");
    const ok = await new Promise((resolve) => {
      udp.once("error", () => resolve(false));
      udp.bind(port, addr, () => resolve(true));
    });
    if (ok) {
      udp.on("message", (m) =>
        hits.push({ label, proto: "udp", at: Date.now(), head: m.toString("latin1").slice(0, 100) }),
      );
      return {
        label,
        port,
        hits,
        close: async () => {
          await new Promise((r) => tcp.close(() => r()));
          await new Promise((r) => udp.close(() => r()));
        },
      };
    }
    udp.close();
    await new Promise((r) => tcp.close(() => r()));
  }
  throw new Error(`canary ${label}: no port`);
}

async function startProxyListener() {
  const hits = [];
  const server = net.createServer((socket) => {
    const at = Date.now();
    const entry = { at, head: "" };
    hits.push(entry);
    socket.on("data", (d) => {
      entry.head += d.toString("latin1").slice(0, 300);
    });
    socket.on("error", () => {});
    setTimeout(() => socket.destroy(), 4000);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function startHttp(pageHeader) {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/page.html")) {
      // Connection-Allowlist などの header つきで本物の http の文書を返す（custom scheme との比較用）
      const headers = { "Content-Type": "text/html" };
      if (pageHeader) headers["Connection-Allowlist"] = pageHeader;
      res.writeHead(200, headers);
      res.end("<!doctype html><title>Grimodex</title><p>page</p>");
      return;
    }
    hits.push({ at: Date.now(), host: req.headers.host });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function buildBundles(work) {
  const bundle = path.join(work, "bundle");
  const dist = path.join(work, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "*.node"],
    logLevel: "error",
  };
  const disableEntry = path.join(work, "preload-disable-entry.ts");
  fs.writeFileSync(
    disableEntry,
    `import { webFrame } from "electron";
webFrame.executeJavaScript("delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;");
import ${JSON.stringify(path.join(root, "electron", "preload", "index.ts"))};
`,
  );
  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [path.join(here, "webrtc-block-probe-main.mjs")],
      outfile: path.join(bundle, "main.cjs"),
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(root, "electron", "preload", "index.ts")],
      outfile: path.join(bundle, "preload.cjs"),
    }),
    esbuild.build({
      ...common,
      entryPoints: [disableEntry],
      outfile: path.join(bundle, "preload-disable.cjs"),
    }),
  ]);
  fs.writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ name: "probe", version: "0.0.1", main: "main.cjs" }));
  fs.writeFileSync(
    path.join(dist, "index.html"),
    "<!doctype html><html><head><meta charset=utf-8><title>Grimodex</title></head><body><p>probe</p></body></html>",
  );
  fs.writeFileSync(path.join(dist, "assets", "data.json"), "{}");
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "// no-op");
  fs.writeFileSync(path.join(dist, "assets", "probe-worker.js"), "self.onmessage = (e) => self.postMessage('worker-ok:' + e.data);");
  return { bundle, dist };
}

function electronBinary() {
  const electronDir = path.dirname(
    fileURLToPath(import.meta.resolve("electron/package.json")),
  );
  const rel = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
  return path.join(electronDir, "dist", rel);
}

function runElectron({ work, bundle, cfg, args }) {
  const env = { ...process.env };
  for (const key of [
    "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS",
    "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  ]) delete env[key];
  env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  // desktop 環境の変数があると Chromium は env の proxy でなく desktop の設定（GNOME の gsettings など）を読む。
  // env の proxy の影響を見る試験だけ、これらを外す
  if (args.clearDesktop) {
    for (const key of ["XDG_CURRENT_DESKTOP", "DESKTOP_SESSION", "XDG_SESSION_DESKTOP", "GDMSESSION", "GNOME_DESKTOP_SESSION_ID", "KDE_FULL_SESSION"]) delete env[key];
  }
  if (args.dnsLib) {
    env.LD_PRELOAD = args.dnsLib;
    env.PROBE_DNSLOG = path.join(work, "dns.log");
  }
  Object.assign(env, args.env ?? {});
  env.PROBE_CM = JSON.stringify(args.cm);
  env.PROBE_CFG = JSON.stringify(cfg);
  env.PROBE_RENDERER_SCRIPT = path.join(here, "webrtc-block-probe-renderer.js");
  const netLog = path.join(work, "netlog.json");
  const electronArgs = [
    ...args.electronArgs.map((a) =>
      a.replaceAll("PROXYHOSTPORT", `127.0.0.1:${cfg.ports.proxy}`),
    ),
    ...(args.realNetwork ? [] : [
      args.cm.resolverRules
        ? `--host-resolver-rules=${args.cm.resolverRules.replaceAll("LANADDR", cfg.lan)}`
        : `--host-resolver-rules=MAP *.probe.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2, EXCLUDE [::1], EXCLUDE ::1, EXCLUDE ${cfg.lan}, EXCLUDE localhost`,
    ]),
    ...(args.netLog ? [`--log-net-log=${netLog}`, "--net-log-capture-mode=Everything"] : []),
    path.join(bundle, "main.cjs"),
  ];
  const wrapper = path.join(root, "scripts", "local-ci-xvfb.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, electronBinary(), ...electronArgs], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    let timedOut = false;
    const killGroup = (s) => { try { process.kill(-child.pid, s); } catch {} };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000);
    }, TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killGroup("SIGKILL");
      resolve({ code, signal, output, timedOut, netLog });
    });
  });
}

function netLogAlerts(netLogPath) {
  if (!fs.existsSync(netLogPath)) return null;
  let text = fs.readFileSync(netLogPath, "utf8");
  let log;
  try { log = JSON.parse(text); } catch { log = JSON.parse(text.replace(/,\s*$/, "") + "]}"); }
  const typeNames = Object.fromEntries(
    Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]),
  );
  const alerts = [];
  const urls = new Set();
  const proxyInfos = new Set();
  const gvt1 = new Set();
  for (const e of log.events ?? []) {
    const name = typeNames[e.type];
    if (name === "PAC_JAVASCRIPT_ALERT") alerts.push(e.params?.message);
    if (name === "URL_REQUEST_START_JOB" || name === "URL_REQUEST_REDIRECTED") {
      const u = e.params?.url ?? e.params?.location;
      if (u && !/probe\.test|^app:|^data:|^blob:/.test(u)) urls.add(String(u).split("?")[0].slice(0, 140));
    }
    if (name === "PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST" && e.params?.proxy_info) proxyInfos.add(e.params.proxy_info);
    const j = JSON.stringify(e.params ?? {});
    const m = j.match(/[a-z0-9.-]*gvt[12]\.com[^"\\]*/g);
    if (m) for (const x of m) gvt1.add(`${name}:${x}`.slice(0, 160));
  }
  return { alerts: [...new Set(alerts)], gvt: [...gvt1].slice(0, 20), urls: [...urls].slice(0, 30), proxyInfos: [...proxyInfos].slice(0, 10) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nonce = randomBytes(3).toString("hex");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "grimodex-wrtc-"));
  const lan = lanAddress();
  const canaries = [
    await startCanary("p-127.0.0.1", "127.0.0.1"),
    await startCanary("q-127.0.0.1-other", "127.0.0.1"),
    await startCanary("r-127.0.0.2", "127.0.0.2"),
    await startCanary("s-[::1]", "::1", true),
    ...(lan ? [await startCanary("t-lan", lan)] : []),
  ];
  const proxy = await startProxyListener();
  const doh = args.doh ? await startDohCanary(work) : null;
  let fakeHttp = null;
  if (args.fakeHttpProxy || args.fakeProxyForm) {
    // proxy の host の形（localhost／127.0.0.1／LAN の literal／hostname）ごとに、env の proxy を模す listener を立てる
    // 名前指定の http proxy（OS／環境の proxy が名前の利用者を模す）。CONNECT 行を記録して 502 を返す
    const hits = [];
    const server = net.createServer((socket) => {
      socket.once("data", (d) => { hits.push(d.toString("latin1").split("\r\n")[0].slice(0, 120)); socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); });
      socket.on("error", () => {});
    });
    const form = args.fakeProxyForm ?? "hostname";
    const bindAddr = form === "lan" ? lan : form === "hostname" ? "127.0.1.1" : "127.0.0.1";
    await new Promise((resolve) => server.listen(0, bindAddr, resolve));
    fakeHttp = { port: server.address().port, hits, close: () => new Promise((r) => server.close(() => r())) };
    const hostPart = form === "localhost" ? "localhost" : form === "127.0.0.1" ? "127.0.0.1" : form === "lan" ? lan : os.hostname();
    args.env = { ...(args.env ?? {}), https_proxy: `http://${hostPart}:${fakeHttp.port}`, http_proxy: `http://${hostPart}:${fakeHttp.port}` };
  }
  const httpd = await startHttp(args.cm.pageHeader);
  let proxyPort = proxy.port;
  if (args.proxyMode === "closed") {
    // 閉じた port（listener なし）を proxy として使う
    const tmp = net.createServer();
    await new Promise((r) => tmp.listen(0, "127.0.0.1", r));
    proxyPort = tmp.address().port;
    await new Promise((r) => tmp.close(() => r()));
  }
  const cfg = {
    userData: path.join(work, "userData"),
    distRoot: path.join(work, "dist"),
    resultPath: path.join(work, "result.json"),
    nonce,
    hostname: os.hostname(),
    lan: lan ?? "192.0.2.1",
    ports: {
      p: canaries[0].port, q: canaries[1].port, r: canaries[2].port,
      s: canaries[3].port, t: canaries[4]?.port ?? 1, proxy: proxyPort, http: httpd.port, doh: doh?.port ?? 0, fake: fakeHttp?.port ?? 0,
    },
  };
  fs.mkdirSync(cfg.userData, { recursive: true });
  try {
    const { bundle } = await buildBundles(work);
    const run = await runElectron({ work, bundle, cfg, args });
    if (!fs.existsSync(cfg.resultPath)) {
      console.error(run.output.slice(-3000));
      throw new Error(`no result (code=${run.code}, signal=${run.signal}, timedOut=${run.timedOut})`);
    }
    const result = JSON.parse(fs.readFileSync(cfg.resultPath, "utf8"));
    if (result.fatal) throw new Error(`main failed: ${result.fatal}`);
    const all = [...result.rendererResults, ...result.mainSide].filter((r) => r.startedAt);
    const rows = [];
    const owned = new Set();
    for (const r of all) {
      const direct = canaries.flatMap((c) => c.hits)
        .filter((h) => h.at >= r.startedAt && h.at <= r.endedAt);
      const prox = proxy.hits.filter((h) => h.at >= r.startedAt && h.at <= r.endedAt);
      const hh = httpd.hits.filter((h) => h.at >= r.startedAt && h.at <= r.endedAt);
      direct.forEach((h) => owned.add(h));
      const byLabel = {};
      for (const h of direct) {
        const k = `${h.label}:${h.proto}`;
        byLabel[k] = (byLabel[k] ?? 0) + 1;
      }
      rows.push({
        id: r.id,
        outcome: r.outcome,
        leaked: direct.length,
        leakDetail: byLabel,
        proxied: prox.length,
        proxyHeads: prox.map((p) => p.head.replace(/[^\x20-\x7e]/g, ".").slice(0, 120)).slice(0, 2),
        httpHits: hh.length,
      });
    }
    const dnsLogPath = path.join(work, "dns.log");
    const dnsEvents = args.dnsLib && fs.existsSync(dnsLogPath)
      ? fs.readFileSync(dnsLogPath, "utf8").split("\n").filter(Boolean).map((l) => {
          const [at, pid, name, service, rc] = l.split("\t");
          return { at: Number(at), pid, name: name.split(nonce).join("<n>"), rc: Number(rc) };
        })
      : null;
    if (doh) {
      for (const row of rows) {
        const r = all.find((x) => x.id === row.id);
        row.dohNames = [...new Set(doh.queries.filter((q) => q.at >= r.startedAt - 50 && q.at <= r.endedAt + 50).map((q) => `${q.name.split(nonce).join("<n>")}/${q.qtype}`))];
      }
    }
    if (dnsEvents) {
      for (const row of rows) {
        const r = all.find((x) => x.id === row.id);
        const names = dnsEvents.filter((e) => e.at >= r.startedAt - 50 && e.at <= r.endedAt + 50);
        row.dnsNames = [...new Set(names.map((e) => `${e.name}${e.rc === 0 ? "[rc0]" : ""}`))];
      }
    }
    const unattributed = canaries.flatMap((c) => c.hits).filter((h) => !owned.has(h));
    const out = {
      label: args.label,
      electron: result.electron,
      cm: args.cm,
      electronArgs: args.electronArgs,
      proxyMode: args.proxyMode,
      events: result.events,
      webPreferences: result.webPreferences,
      totals: {
        leakedProbes: rows.filter((r) => r.leaked > 0 && r.id.startsWith("main.") === false || (r.leaked > 0)).length,
        probes: rows.length,
        canaryHits: canaries.flatMap((c) => c.hits).length,
        unattributed: unattributed.length,
        proxyHits: proxy.hits.length,
      },
      rows,
      webRequestSeen: result.webRequestSeen,
      dohAll: doh ? [...new Set(doh.queries.map((q) => q.name.split(nonce).join("<n>")))] : null,
      dohQueryCount: doh ? doh.queries.length : null,
      envProxyConnects: fakeHttp ? fakeHttp.hits : null,
      dictionaries: result.dictionaries ?? [],
      netLog: args.netLog ? netLogAlerts(run.netLog) : null,
      dnsAll: dnsEvents ? [...new Set(dnsEvents.map((e) => `${e.name}${e.rc === 0 ? "[rc0]" : ""}`))] : null,
      dnsRowCount: dnsEvents ? rows.filter((r) => (r.dnsNames ?? []).some((n) => n.includes("<n>") || /example\.org|gvt1|github/.test(n))).length : null,
      timedOut: run.timedOut,
      runStdoutTail: run.output.slice(-400),
    };
    const text = JSON.stringify(out, null, 2).split(nonce).join("<n>");
    if (args.out) fs.writeFileSync(args.out, text + "\n");
    // 要約
    console.log(`== ${args.label} (electron ${result.electron}) ${result.events.join("; ")}`);
    for (const r of rows) {
      const tag = r.leaked > 0 ? "LEAK " : r.proxied > 0 ? "proxy" : r.httpHits > 0 ? "http " : "none ";
      if (r.dohNames?.length) console.log(`      doh: ${JSON.stringify(r.dohNames).slice(0, 220)}`);
      if (r.dnsNames?.length) console.log(`      dns: ${JSON.stringify(r.dnsNames).slice(0, 220)}`);
      console.log(
        `${tag} ${r.id.padEnd(34)} ${JSON.stringify(r.leakDetail)}${r.proxied ? ` proxied=${r.proxied} ${JSON.stringify(r.proxyHeads[0] ?? "")}` : ""}${r.httpHits ? ` httpHits=${r.httpHits}` : ""} -> ${r.outcome.slice(0, 60)}`,
      );
    }
    console.log(`unattributed canary hits: ${unattributed.length} ${JSON.stringify(unattributed.map((h) => `${h.label}:${h.proto}`))}`);
    console.log(`proxy listener heads (all): ${JSON.stringify(proxy.hits.map((h) => h.head.replace(/[^\x20-\x7e]/g, ".").split("..")[0].slice(0, 70)).filter((h) => !/probe\.test|blocked\.invalid/.test(h)).slice(0, 12))}`);
    if (out.netLog) console.log(`netlog urls: ${JSON.stringify(out.netLog.urls)} proxyInfos: ${JSON.stringify(out.netLog.proxyInfos)}`);
    if (out.netLog) console.log(`netlog PAC alerts: ${JSON.stringify(out.netLog.alerts.map((a) => String(a).replace(new RegExp(nonce, "g"), "<n>")).slice(0, 60))}\ngvt: ${JSON.stringify(out.netLog.gvt)}`);
    if (result.webRequestSeen) console.log(`webRequest saw: ${JSON.stringify(result.webRequestSeen)}`);
    if (args.keep) console.log(`work dir kept: ${work}`);
  } finally {
    await Promise.all([...canaries.map((c) => c.close()), proxy.close(), ...(doh ? [doh.close()] : []), httpd.close(), ...(fakeHttp ? [fakeHttp.close()] : [])]);
    if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
