/**
 * 起動の順序の試験の main（K3/3 R12。診断用で製品を変えない）。
 * 製品の起動（electron/main/index.ts）の順序を模す: ready の後に default session の最初の接触
 * （applySessionPermissionPolicy に相当）が来て、NC-1（blackhole の listener、setProxy、closeAllConnections）が続く。
 * 辞書の要求（spellchecker）が setProxy の前に始まるか、始まった要求がどこへ出るかを見る。
 *
 * ORD_MODE:
 *   permission-first: default session を先に触り（setPermissionRequestHandler など）、ORD_PRE_DELAY ms 後に NC-1 を当てる
 *                     （ORD_PRE_DELAY=0 は K3/3 の以前の順序「applySessionPermissionPolicy の直後」）
 *   nc1-first:        NC-1 を default session の最初の接触にする（setProxy が最初の接触）。その後に permission 相当の接触
 *   protocol-first:   registerAppProtocolHandler に相当する protocol.handle を最初に呼び（Electron は内部で
 *                     session.defaultSession.protocol に委譲する＝default session の暗黙の接触）、ORD_PRE_DELAY ms 後に NC-1（K3/3 R13）
 *   nc1-then-protocol: NC-1 の後に protocol.handle と permission 相当の接触（K3/3 R13。製品の起動順序で NC-1 を最初にした形）
 *   product-nc1:      製品の NC-1 の module（K3/3。NC-1 の lane、S3）を `electron/main/index.ts` と同じ順序で呼ぶ。
 *                     pre-ready: registerAppProtocolScheme → appendResolverSwitch → registerSecurityHandlers → registerWebContentsPolicy。
 *                     ready の後: start()（listener → setProxy → closeAllConnections → 自己確認）→ applySessionPermissionPolicy →
 *                     installProductDownloadGuard → registerAppProtocolHandler → 窓（app://bundle）。いずれも製品の関数。
 *                     deps は製品の既定と同じ電子の実物で、default session の最初の接触・setProxy・closeAllConnections・
 *                     listener の起動の時刻を記録するための印を足すだけ（session のメソッドを包む）。
 *   product-none:     同じ順序で NC-1 だけを呼ばない対照（起動時間の前後の比較用）
 * ORD_NC1_DELAY: NC-1 の開始を遅らせる ms（setProxy の余裕の測定用）
 * ORD_USERDATA: userData。ORD_RULES=0 で host-resolver-rules を当てない。ORD_WAIT: 窓の作成後の待ち ms。
 * 時刻は Date.now()（net log の timeTickOffset と合わせて比べる）。
 */
const { app, session, BrowserWindow, protocol } = require("electron");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
// 製品の module（runner が esbuild で束ねる。product-* の mode だけが使う）
const { createRendererContainment } = require("../main/rendererContainmentStartup.ts");
const { startBlackholeListener } = require("../main/rendererContainmentListener.ts");
const { registerSecurityHandlers, applySessionPermissionPolicy } = require("../main/security.ts");
const { registerAppProtocolScheme, registerAppProtocolHandler, PROD_INDEX_URL } = require("../main/protocol.ts");
const { installProductDownloadGuard } = require("../main/downloadGuardElectron.ts");

const T = [];
const mark = (name, extra) => { T.push({ name, at: Date.now(), ...(extra ? { extra } : {}) }); console.log(`[ORD] ${Date.now()} ${name}${extra ? " " + JSON.stringify(extra) : ""}`); };
const ud = process.env.ORD_USERDATA;
app.setPath("userData", ud);
const RULES = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
if (process.env.ORD_RULES !== "0") app.commandLine.appendSwitch("host-resolver-rules", RULES);
const MODE = process.env.ORD_MODE ?? "nc1-first";
const PRODUCT = MODE === "product-nc1" || MODE === "product-none";
const productHits = [];
let productNc1 = null;
if (PRODUCT) {
  // 製品の `index.ts` の pre-ready と同じ順序。host-resolver-rules は製品の関数の値（このファイルの RULES は使わない）
  registerAppProtocolScheme();
  if (MODE === "product-nc1") {
    let touched = false;
    productNc1 = createRendererContainment({
      appendSwitch: (name, value) => { app.commandLine.appendSwitch(name, value); mark(`appendSwitch ${name} (before ready)`); },
      onWebContentsCreated: (listener) => { app.on("web-contents-created", (_e, contents) => { listener(contents); }); },
      onBeforeQuit: (listener) => { app.on("before-quit", listener); },
      quit: () => { app.quit(); },
      defer: (callback) => { setImmediate(callback); },
      getDefaultSession: () => {
        const ses = session.defaultSession;
        if (!touched) {
          touched = true;
          mark("defaultSession first touch");
          // 時刻の印だけを足す。呼出し自体は実物の session のメソッド
          const wrap = (name, begin, end) => {
            const original = ses[name].bind(ses);
            ses[name] = async (...args) => { if (begin) mark(begin); const result = await original(...args); mark(end); return result; };
          };
          wrap("setProxy", "setProxy start", "setProxy done");
          wrap("closeAllConnections", null, "closeAllConnections done");
        }
        return ses;
      },
      startListener: (options) => startBlackholeListener(options).then((listener) => {
        mark("listener up", { port: listener.port });
        listener.server.on("connection", () => { productHits.push({ at: Date.now(), bytes: 0 }); });
        return listener;
      }),
      reportFailure: (line) => { mark("failure", { line }); console.error(line); },
    });
    productNc1.appendResolverSwitch();
  }
  registerSecurityHandlers(app);
  mark("registerSecurityHandlers (before ready)");
  productNc1?.registerWebContentsPolicy();
  if (productNc1) mark("registerWebContentsPolicy (before ready)");
}
const PRE_DELAY = Number(process.env.ORD_PRE_DELAY ?? 0);
const WAIT = Number(process.env.ORD_WAIT ?? 9000);
const dictDir = path.join(ud, "Dictionaries");

function touchPermissionPolicy() {
  // applySessionPermissionPolicy／installProductDownloadGuard に相当する default session の接触
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", () => {});
  mark("permission-policy applied (defaultSession touched)");
}

function touchProtocolHandle() {
  // registerAppProtocolHandler（protocol.ts の protocol.handle）に相当。製品の session.defaultSession の getter を通らない暗黙の接触
  protocol.handle("app", () => new Response("ok"));
  mark("protocol.handle applied (defaultSession touched implicitly)");
}

async function applyNc1() {
  // 余裕の測定用: NC-1 の開始を ORD_NC1_DELAY ms 遅らせる（遅い環境の模擬。製品の動作ではない）
  if (Number(process.env.ORD_NC1_DELAY ?? 0) > 0) await new Promise((r) => setTimeout(r, Number(process.env.ORD_NC1_DELAY)));
  const hits = [];
  const srv = net.createServer((s) => {
    hits.push({ at: Date.now(), bytes: 0 });
    const h = hits[hits.length - 1];
    s.on("error", () => {});
    s.on("data", (d) => { h.bytes += d.length; });
    setTimeout(() => s.destroy(), 4000);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  mark("listener up", { port });
  mark("setProxy start");
  const ses = session.defaultSession;
  await ses.setProxy({ mode: "fixed_servers", proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: "<-loopback>" });
  mark("setProxy done");
  await ses.closeAllConnections();
  mark("closeAllConnections done");
  app.on("web-contents-created", (_e, wc) => wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"));
  return { hits, port };
}

async function runProduct() {
  // `index.ts` の whenReady の後と同じ順序。initBackend は呼ばない（窓の前の NC-1 の完了だけを見る）
  let nc1Ok = true;
  if (productNc1) {
    mark("nc1 start begin");
    nc1Ok = await productNc1.start();
    mark("nc1 start done", { ok: nc1Ok });
    if (!nc1Ok) throw new Error("nc1 start failed");
  }
  applySessionPermissionPolicy();
  mark("applySessionPermissionPolicy done");
  installProductDownloadGuard();
  mark("installProductDownloadGuard done");
  const distDir = path.join(ud, "..", "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><html><head><meta charset=utf-8><title>Grimodex</title></head><body><p>ord</p></body></html>");
  registerAppProtocolHandler(distDir);
  mark("registerAppProtocolHandler done");
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  mark("BrowserWindow created");
  const watch = setInterval(() => { try { const f = fs.readdirSync(dictDir); if (f.length) mark("Dictionaries", f); } catch {} }, 250);
  await win.loadURL(PROD_INDEX_URL);
  mark("window loaded");
  await new Promise((r) => setTimeout(r, WAIT));
  clearInterval(watch);
  let dicts = [];
  try { dicts = fs.readdirSync(dictDir); } catch {}
  fs.writeFileSync(process.env.ORD_RESULT, JSON.stringify({
    mode: MODE, preDelay: PRE_DELAY, timeline: T, dictionaries: dicts,
    langs: session.defaultSession.getSpellCheckerLanguages(), spellcheckEnabled: session.defaultSession.isSpellCheckerEnabled(),
    blackholeHits: productHits, electron: process.versions.electron,
  }, null, 1));
  app.quit();
}

app.whenReady().then(async () => {
  mark("ready");
  if (PRODUCT) {
    try { await runProduct(); } catch (error) { console.error(String(error)); app.quit(); }
    return;
  }
  let nc1;
  if (MODE === "protocol-first") {
    touchProtocolHandle();
    if (PRE_DELAY > 0) await new Promise((r) => setTimeout(r, PRE_DELAY));
    nc1 = await applyNc1();
    touchPermissionPolicy();
  } else if (MODE === "nc1-then-protocol") {
    nc1 = await applyNc1();
    touchProtocolHandle();
    touchPermissionPolicy();
  } else if (MODE === "permission-first") {
    touchPermissionPolicy();
    if (PRE_DELAY > 0) await new Promise((r) => setTimeout(r, PRE_DELAY));
    nc1 = await applyNc1();
  } else {
    nc1 = await applyNc1();
    touchPermissionPolicy();
  }
  const watch = setInterval(() => { try { const f = fs.readdirSync(dictDir); if (f.length) mark("Dictionaries", f); } catch {} }, 250);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL("about:blank");
  mark("window loaded");
  await new Promise((r) => setTimeout(r, WAIT));
  clearInterval(watch);
  let dicts = [];
  try { dicts = fs.readdirSync(dictDir); } catch {}
  fs.writeFileSync(process.env.ORD_RESULT, JSON.stringify({
    mode: MODE, preDelay: PRE_DELAY, timeline: T, dictionaries: dicts,
    langs: session.defaultSession.getSpellCheckerLanguages(), spellcheckEnabled: session.defaultSession.isSpellCheckerEnabled(),
    blackholeHits: nc1.hits, electron: process.versions.electron,
  }, null, 1));
  app.quit();
});
