/**
 * 起動の順序の試験の runner（K3/3 R12。診断用で製品を変えない）。
 *
 *   node electron/scripts/webrtc-block-probe-order.mjs --mode <permission-first|nc1-first> --env <none|ip|localhost>
 *        [--pre-delay <ms>] [--nc1-delay <ms>] [--repeat <n>] [--tunnel] [--rules 0|1] --out <file>
 *
 * 環境: none = OS／環境の proxy なし。ip = http_proxy／https_proxy が http://127.0.0.1:<port>。
 *       localhost = http://localhost:<port>（どちらも CONNECT を記録する小さな proxy。既定は 502 を返し外へは出さない。
 *       --tunnel のときだけ CONNECT 先へ中継する＝実網の Google の辞書 URL へ GET が出る。Electron の通常の動作と同じ）。
 * 出力: 実行ごとの timeline、辞書の要求（net log の URL_REQUEST_START_JOB の gvt1.com）の開始時刻と行き先、
 *       env の proxy が受けた CONNECT、blackhole の listener への接続、Dictionaries/ の file。
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
  return acc;
}, []));
const mode = args.mode ?? "nc1-first";
const envKind = args.env ?? "none";
const preDelay = args["pre-delay"] ?? "0";
const repeat = Number(args.repeat ?? 1);
const tunnel = args.tunnel === true;
const rules = args.rules ?? "1";
const nc1Delay = args["nc1-delay"] ?? "0";
const outFile = args.out;

function parseNetLog(file) {
  let t;
  try { t = fs.readFileSync(file, "utf8"); } catch { return null; }
  let d;
  try { d = JSON.parse(t); } catch { const i = t.lastIndexOf("},{"); d = JSON.parse(t.slice(0, i + 1) + "]}"); }
  const names = Object.fromEntries(Object.entries(d.constants.logEventTypes).map(([k, v]) => [v, k]));
  const off = Number(d.constants.timeTickOffset);
  const abs = (e) => off + Number(e.time);
  const reqs = new Map();
  for (const e of d.events) {
    const p = e.params ?? {};
    if (names[e.type] === "URL_REQUEST_START_JOB" && e.phase === 1 && /gvt1\.com/.test(String(p.url ?? ""))) {
      if (!reqs.has(e.source.id)) reqs.set(e.source.id, { id: e.source.id, startAt: abs(e), url: String(p.url).replace(/\?.*$/, "").replace(/\/\/rr\d+---sn-[a-z0-9-]+\.gvt1\.com/, "//rrN---sn-X.gvt1.com"), proxyInfo: [], hostResolver: [], netError: null });
    }
  }
  // 辞書の要求に属する event（source id が同じ、または dependency で結びつく proxy 解決／host 解決）
  const dep = new Map();
  for (const e of d.events) {
    const p = e.params ?? {};
    if (p.source_dependency && reqs.has(p.source_dependency.id)) dep.set(e.source.id, p.source_dependency.id);
  }
  for (const e of d.events) {
    const owner = reqs.has(e.source.id) ? e.source.id : dep.get(e.source.id);
    if (owner == null) continue;
    const r = reqs.get(owner);
    const n = names[e.type];
    const p = e.params ?? {};
    if (n === "PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST" && p.proxy_info) r.proxyInfo.push(p.proxy_info);
    if (/^HOST_RESOLVER_MANAGER_(REQUEST|JOB)$/.test(n) && p.host) r.hostResolver.push(String(p.host));
    if (n === "URL_REQUEST_START_JOB" && e.phase === 2 && p.net_error) r.netError = p.net_error;
    if (n === "REQUEST_ALIVE" && e.phase === 2 && p.net_error) r.netError = p.net_error;
    if (p.net_error && /FAILED|HTTP_STREAM|TRANSACTION/.test(n)) r.netError ??= p.net_error;
  }
  return { requests: [...reqs.values()].map((r) => ({ ...r, proxyInfo: [...new Set(r.proxyInfo)], hostResolver: [...new Set(r.hostResolver)] })) };
}

async function once(i) {
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "grimodex-ord-"));
  const connects = [];
  const proxy = http.createServer((req, res) => { connects.push({ at: Date.now(), line: `${req.method} ${req.url}` }); res.statusCode = 502; res.end(); });
  proxy.on("connect", (req, sock) => {
    connects.push({ at: Date.now(), line: `CONNECT ${req.url}` });
    if (tunnel) {
      const [h, pt] = req.url.split(":");
      const up = net.connect(Number(pt), h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.pipe(sock); sock.pipe(up); });
      up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
    } else sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const pport = proxy.address().port;
  const env = { ...process.env };
  for (const k of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS", "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION", "XDG_SESSION_DESKTOP", "GDMSESSION", "GNOME_DESKTOP_SESSION_ID", "KDE_FULL_SESSION"]) delete env[k];
  env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  env.TMPDIR = work;
  env.ORD_USERDATA = path.join(work, "ud");
  env.ORD_RESULT = path.join(work, "result.json");
  env.ORD_MODE = mode;
  env.ORD_PRE_DELAY = preDelay;
  env.ORD_RULES = rules;
  env.ORD_NC1_DELAY = nc1Delay;
  if (envKind !== "none") {
    const host = envKind === "localhost" ? "localhost" : "127.0.0.1";
    env.http_proxy = env.https_proxy = `http://${host}:${pport}`;
  }
  const electronDir = path.join(root, "node_modules/electron");
  const bin = path.join(electronDir, "dist", fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim());
  const netlog = path.join(work, "netlog.json");
  const child = spawn(process.execPath, [path.join(root, "scripts/local-ci-xvfb.mjs"), bin, `--log-net-log=${netlog}`, "--net-log-capture-mode=Everything", path.join(here, "webrtc-block-probe-order-main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} }, 90000);
  await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  proxy.close();
  let result = null;
  try { result = JSON.parse(fs.readFileSync(env.ORD_RESULT, "utf8")); } catch { /* 結果なし */ }
  const nl = parseNetLog(netlog);
  const t = Object.fromEntries((result?.timeline ?? []).map((e) => [e.name, e.at]));
  const touchAt = t["permission-policy applied (defaultSession touched)"];
  const setProxyDone = t["setProxy done"];
  const row = {
    run: i, mode, env: envKind, preDelay: Number(preDelay), nc1Delay: Number(nc1Delay), tunnel, rules,
    timelineMsFromReady: Object.fromEntries((result?.timeline ?? []).map((e) => [e.name, e.at - t.ready])),
    dictionaryRequests: (nl?.requests ?? []).map((r) => ({
      url: r.url,
      startMsFromReady: r.startAt - t.ready,
      startBeforeSetProxyDone: setProxyDone != null ? r.startAt < setProxyDone : null,
      proxyInfo: r.proxyInfo, hostResolver: r.hostResolver, netError: r.netError,
    })),
    envProxyConnects: connects.map((c) => ({ msFromReady: c.at - t.ready, line: c.line })),
    blackholeHits: (result?.blackholeHits ?? []).length,
    dictionaries: result?.dictionaries ?? null,
    spellcheck: { enabled: result?.spellcheckEnabled, langs: result?.langs },
    electron: result?.electron,
    ok: result != null,
  };
  void touchAt;
  fs.rmSync(work, { recursive: true, force: true });
  return row;
}

const rows = [];
for (let i = 0; i < repeat; i += 1) rows.push(await once(i));
const outText = JSON.stringify({ args: { mode, env: envKind, preDelay, nc1Delay, repeat, tunnel, rules }, rows }, null, 2);
if (outFile) fs.writeFileSync(outFile, outText + "\n");
for (const r of rows) {
  console.log(`mode=${r.mode} env=${r.env} preDelay=${r.preDelay} #${r.run}: dict要求 ${r.dictionaryRequests.length} 件 ${JSON.stringify(r.dictionaryRequests.map((d) => ({ at: Math.round(d.startMsFromReady), beforeSetProxy: d.startBeforeSetProxyDone, proxy: d.proxyInfo, err: d.netError })))} envProxy:${JSON.stringify(r.envProxyConnects.map((c) => c.line))} blackhole:${r.blackholeHits} files:${JSON.stringify(r.dictionaries)}`);
}
