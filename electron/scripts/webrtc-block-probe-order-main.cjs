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
 * ORD_NC1_DELAY: NC-1 の開始を遅らせる ms（setProxy の余裕の測定用）
 * ORD_USERDATA: userData。ORD_RULES=0 で host-resolver-rules を当てない。ORD_WAIT: 窓の作成後の待ち ms。
 * 時刻は Date.now()（net log の timeTickOffset と合わせて比べる）。
 */
const { app, session, BrowserWindow } = require("electron");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const T = [];
const mark = (name, extra) => { T.push({ name, at: Date.now(), ...(extra ? { extra } : {}) }); console.log(`[ORD] ${Date.now()} ${name}${extra ? " " + JSON.stringify(extra) : ""}`); };
const ud = process.env.ORD_USERDATA;
app.setPath("userData", ud);
const RULES = "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost";
if (process.env.ORD_RULES !== "0") app.commandLine.appendSwitch("host-resolver-rules", RULES);
const MODE = process.env.ORD_MODE ?? "nc1-first";
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

app.whenReady().then(async () => {
  mark("ready");
  let nc1;
  if (MODE === "permission-first") {
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
