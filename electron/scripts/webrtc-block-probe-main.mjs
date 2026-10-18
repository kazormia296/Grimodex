/**
 * WebRTC の外向き通信を塞ぐ候補の実機試験の main（NIR-1 Y-1 の続き）。診断用で製品を変えない。
 * `webrtc-block-probe.mjs` が esbuild で束ねて Electron で起動する。本体の protocol.ts と
 * security.ts の部品と同じ構成の窓（sandbox、contextIsolation、同梱 preload、app://bundle）を作り、
 * env の PROBE_CM（JSON）が指す候補を適用してから、乗っ取られた renderer 相当の JS を実行する。
 *
 * PROBE_CM の形（すべて任意）:
 *   target: "default" | "partition"   窓の session（partition は persist:probe-renderer）
 *   proxy: setProxy に渡す config（"PROXYHOSTPORT" は blackhole proxy の host:port に置換、
 *          pacScript の PROXYHOSTPORT と bypass の CANARYP（canary の port）も同様）。proxyTarget: "window" | "default" | "none"
 *   appSetProxy: app.setProxy に渡す config
 *   headers: app:// の全応答に足す header
 *   policy: webContents.setWebRTCIPHandlingPolicy の値
 *   udpRange: [min, max]
 *   disablePreload: true で preload の main world から RTCPeerConnection を消す
 *   webRequest: true で window の session に catch-all の webRequest を付けて観測
 *   spellcheck: true で spellchecker を有効にして辞書の取得を起こす
 *
 * NC-1（K3/3。NC-1 の lane、S3）の追記: 製品の NC-1 の module を import して適用する。
 *   nc1: 製品の閉じ込めの適用。{ drop?: string[], prefixRules?: string[], failPolicy?: bool }
 *        drop が空なら製品の orchestrator（`createRendererContainment`）を `index.ts` と同じ順序で当てる。
 *        drop に "policy" | "proxy" | "neg-loopback" | "rules" を入れると、機構を 1 つずつ外した制御の構成を
 *        製品が export する部品の組合せだけで作る（外した構成を作る入口はこの probe の main だけが持つ。
 *        製品には無効化の入口を置かない）。prefixRules は製品の buildHostResolverRules(prefixRules) に渡す
 *        （試験の名前の写し。製品の呼出しは引数なし）。"LANADDR" は LAN の IPv4 に置換する。
 *   reload: true で窓を再読込・遷移した後の localhost の TURN／STUN を足す（policy と proxy の持続）
 *   devtools: true で DevTools の webContents が default session か、NC-SESSION を起こさないかを観測する
 *   ncSession: true で default session でない窓を作り、NC-SESSION の終了の経路（SIGSEGV なし）を観測する
 *   pageRan: "ok" | "policy-fail" | "none" 窓に script つきの app:// ページを読ませ、NC-POLICY の注入
 *        （policy の適用の失敗）で何も走らないこと／対照で走ることを観測する
 *   uncaught は result.nc1.uncaught に記録する
 */
import fs from "node:fs";
import nodeNet from "node:net";
import path from "node:path";

import { app, BrowserWindow, net, protocol, session, webContents as allWebContents } from "electron";
import { autoUpdater } from "electron-updater";

import {
  APP_PROTOCOL_SCHEME,
  createAppProtocolHandler,
  PROD_INDEX_URL,
  registerAppProtocolScheme,
} from "../main/protocol.ts";
import {
  PROXY_BYPASS_RULES,
  WEBRTC_IP_HANDLING_POLICY,
  buildHostResolverRules,
  buildProxyConfig,
} from "../main/rendererContainment.ts";
import { startBlackholeListener } from "../main/rendererContainmentListener.ts";
import { createRendererContainment } from "../main/rendererContainmentStartup.ts";

const env = process.env;
const cm = JSON.parse(env.PROBE_CM || "{}");
const cfg = JSON.parse(env.PROBE_CFG);
const { userData, distRoot, resultPath, nonce } = cfg;

app.setPath("userData", userData);
app.disableHardwareAcceleration();
registerAppProtocolScheme();
// 製品と同じ方法（app ready 前の commandLine.appendSwitch）で resolver rules を当てる試験
if (cm.resolverSwitch) app.commandLine.appendSwitch("host-resolver-rules", cm.resolverSwitch.replaceAll("LANADDR", cfg.lan));
if (cm.doh) app.commandLine.appendSwitch("ignore-certificate-errors");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const subst = (value) =>
  JSON.parse(
    JSON.stringify(value).replaceAll(
      "PROXYHOSTPORT",
      `127.0.0.1:${cfg.ports.proxy}`,
    ).replaceAll("CANARYP", String(cfg.ports.p)).replaceAll("FAKEHTTPPROXY", `${cfg.hostname}:${cfg.ports.fake}`),
  );

// ── NC-1（製品の module）の適用（K3/3。NC-1 の lane、S3）──────────────────────
// 製品の orchestrator は `index.ts` と同じ順序で当てる: ready の前に appendResolverSwitch と
// registerWebContentsPolicy、ready の後に start()（listener → setProxy → closeAllConnections → 自己確認）。
// 機構を 1 つずつ外した制御の構成は、製品が export する部品（buildHostResolverRules、buildProxyConfig、
// WEBRTC_IP_HANDLING_POLICY、startBlackholeListener）の組合せだけで、この probe の main が作る。
const nc1Spec = cm.nc1 ?? null;
const nc1Drop = new Set(nc1Spec?.drop ?? []);
const nc1Prefix = (nc1Spec?.prefixRules ?? []).map((r) => r.replaceAll("LANADDR", cfg.lan));
const nc1State = {
  config: nc1Spec ? { drop: [...nc1Drop], prefixRules: nc1Prefix, proxyBypassRules: PROXY_BYPASS_RULES, policy: WEBRTC_IP_HANDLING_POLICY } : null,
  startOk: null,
  startMs: null,
  listenerPort: null,
  listenerHits: [],
  overLimit: 0,
  maxActive: 0,
  failures: [],
  quitCalls: 0,
  beforeQuit: false,
  willQuit: false,
  uncaught: [],
  created: [],
};
// 製品の orchestrator を当てるのは、機構を外さず、prefixRules も足さない構成（(23b) の形、更新、実機の観測）。
// (23a) の形（名前を loopback へ写す prefix つき）は、prefix の `EXCLUDE 127.0.0.2` などが製品の自己確認 (b)
// （EXCLUDE していない IP literal の resolveHost が ERR_NAME_NOT_RESOLVED）と両立しないので、proxy と policy の層の
// 単独の合否を見るために、製品が export する部品（buildHostResolverRules(prefixRules)、buildProxyConfig、policy の値、
// startBlackholeListener）をこの probe の main が同じ順序で当てる（DR-NC1-23）
const usesOrchestrator = nc1Spec !== null && nc1Drop.size === 0 && nc1Prefix.length === 0;
let nc1 = null;
const wcLog = [];

/** 製品の listener に触れずに、接続の時刻と上限超過の切断を数える（'connection' の listener を足すだけ。bytes は読まない） */
function observeListener(options) {
  return startBlackholeListener(options).then((listener) => {
    nc1State.listenerPort = listener.port;
    listener.server.on("connection", (socket) => {
      nc1State.listenerHits.push(Date.now());
      // 製品の handler が先に走る。上限超過の接続はここで既に destroy されている
      if (socket.destroyed) nc1State.overLimit += 1;
      nc1State.maxActive = Math.max(nc1State.maxActive, listener.activeConnections());
    });
    return listener;
  });
}

/** NC-POLICY の注入: 実 webContents の `setWebRTCIPHandlingPolicy` だけを失敗させる代役（stop／close／session は実物） */
function withFailingPolicy(contents) {
  return {
    session: contents.session,
    setWebRTCIPHandlingPolicy: () => { throw new Error("injected policy failure"); },
    getWebRTCIPHandlingPolicy: () => contents.getWebRTCIPHandlingPolicy(),
    stop: () => contents.stop(),
    close: (options) => contents.close(options),
  };
}

if (nc1Spec) {
  process.on("uncaughtException", (error) => {
    nc1State.uncaught.push(String(error?.stack ?? error).slice(0, 300));
  });
  app.on("before-quit", () => { nc1State.beforeQuit = true; });
  app.on("will-quit", () => {
    nc1State.willQuit = true;
    // 製品の NC-1 の経路でアプリが終了する試験（NC-SESSION、NC-POLICY の注入）は、終了の途中で結果を書く
    if (cm.ncSession || nc1Spec.failPolicy) writeResultOnQuit();
  });
  if (usesOrchestrator) {
    // 製品の orchestrator。deps は試験が差し込む面で、既定の依存（電子の実物）と同じものを置く。
    // appendSwitch だけは製品の値を確かめたうえで prefixRules を足した同じ関数の値に置き換える
    nc1 = createRendererContainment({
      appendSwitch: (name, value) => {
        if (name !== "host-resolver-rules" || value !== buildHostResolverRules()) {
          throw new Error("product host-resolver-rules switch differs from buildHostResolverRules()");
        }
        app.commandLine.appendSwitch(name, buildHostResolverRules(nc1Prefix));
      },
      onWebContentsCreated: (listener) => {
        app.on("web-contents-created", (_event, contents) => {
          listener(nc1Spec.failPolicy ? withFailingPolicy(contents) : contents);
        });
      },
      onBeforeQuit: (listener) => { app.on("before-quit", listener); },
      quit: () => { nc1State.quitCalls += 1; app.quit(); },
      defer: (callback) => { setImmediate(callback); },
      getDefaultSession: () => session.defaultSession,
      startListener: observeListener,
      reportFailure: (line) => { nc1State.failures.push(line); console.error(line); },
    });
    nc1.appendResolverSwitch();
    nc1.registerWebContentsPolicy();
  } else {
    // 制御の構成（機構を 1 つ外す）。製品の orchestrator は使わない
    if (!nc1Drop.has("rules")) {
      app.commandLine.appendSwitch("host-resolver-rules", buildHostResolverRules(nc1Prefix));
    } else if (nc1Prefix.length > 0) {
      app.commandLine.appendSwitch("host-resolver-rules", nc1Prefix.join(", "));
    }
    if (!nc1Drop.has("policy")) {
      app.on("web-contents-created", (_event, contents) => {
        contents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
      });
    }
  }
}

async function startNc1Control() {
  const listener = await observeListener({});
  if (!nc1Drop.has("proxy")) {
    const base = buildProxyConfig(listener.port);
    // `<-loopback>` を外す: proxyBypassRules を書かず、暗黙の loopback bypass を残す（ll-al0-no-neg-loopback と同じ形）
    const config = nc1Drop.has("neg-loopback") ? { mode: base.mode, proxyRules: base.proxyRules } : base;
    await session.defaultSession.setProxy(config);
    await session.defaultSession.closeAllConnections();
  }
  return true;
}

function writeResultOnQuit() {
  // NC-SESSION の試験: アプリが NC-1 の経路で終了するので、終了の途中で結果を書く
  try {
    fs.writeFileSync(resultPath, JSON.stringify({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      cm,
      events: ncEvents,
      webPreferences: {},
      rendererResults: [],
      mainSide: [],
      nc1: nc1Report(),
      extra,
      appRequests: globalThis.__appRequests ?? [],
      dictionaries: [],
    }, null, 2));
  } catch { /* 書けなければ runner が no result で失敗にする */ }
}

const ncEvents = [];
const extra = {};
function nc1Report() {
  return nc1Spec ? { ...nc1State, listenerHits: nc1State.listenerHits, wc: wcLog } : null;
}

async function main() {
  await app.whenReady();
  const events = ncEvents;
  if (cm.doh) {
    app.configureHostResolver({ enableBuiltInResolver: true, secureDnsMode: "secure", secureDnsServers: [`https://127.0.0.1:${cfg.ports.doh}/dns-query`] });
    events.push("secure DNS -> DoH canary");
  }
  if (nc1Spec) {
    // 起動手順 (2)〜(4)。default session の最初の接触は NC-1 の setProxy（この前に session.defaultSession に触れない）
    const t0 = performance.now();
    const ok = nc1 ? await nc1.start() : await startNc1Control();
    nc1State.startOk = ok;
    nc1State.startMs = Math.round((performance.now() - t0) * 10) / 10;
    events.push(`nc1 ${nc1 ? "orchestrator" : `parts(drop:${[...nc1Drop].join("+") || "none"})`} start => ${ok} in ${nc1State.startMs} ms`);
    if (!ok) throw new Error(`nc1 start failed: ${nc1State.failures.join(" | ")}`);
  }

  const ses =
    cm.target === "partition"
      ? session.fromPartition("persist:probe-renderer")
      : session.defaultSession;

  if (cm.appSetProxy) {
    await app.setProxy(subst(cm.appSetProxy));
    events.push("app.setProxy applied");
  }
  if (cm.updaterSessionProxy) {
    // OS／環境の proxy（名前指定）が electron-updater の session に効く利用者の模擬
    await session.fromPartition("electron-updater", { cache: false }).setProxy(subst(cm.updaterSessionProxy));
    events.push("updater session proxy set (simulated OS proxy)");
  }
  if (cm.proxy) {
    const target = cm.proxyTarget ?? "window";
    const targetSession = target === "default" ? session.defaultSession : ses;
    if (target !== "none") {
      await targetSession.setProxy(subst(cm.proxy));
      await targetSession.closeAllConnections();
      events.push(`setProxy applied to ${target}`);
    }
  }

  if (cm.resolveHostTests) {
    for (const u of ["https://turn.attacker.invalid:443/", "https://redirector.gvt1.com/edgedl/chrome/dict/x", "https://example.invalid:8443/", "http://127.0.0.1:1/", "https://169.254.169.254/", "https://[fe80::1]/"]) {
      try { events.push(`resolveProxy(${u}) => ${await ses.resolveProxy(u)}`); } catch (e) { events.push(`resolveProxy(${u}) error ${e.message}`); }
    }
    for (const u of ["https://github.com/", "https://redirector.gvt1.com/edgedl/chrome/dict/x"]) {
      try { events.push(`updaterSession.resolveProxy(${u}) => ${await session.fromPartition("electron-updater", { cache: false }).resolveProxy(u)}`); } catch (e) { events.push(`updaterSession.resolveProxy(${u}) error ${e.message}`); }
    }
    for (const h of cm.resolveHostTests) {
      let out;
      try {
        const r = await Promise.race([ses.resolveHost(h), sleep(5000).then(() => "timeout")]);
        out = typeof r === "string" ? r : JSON.stringify(r.endpoints?.map((e) => e.address) ?? r);
      } catch (error) {
        out = `error:${String(error?.message ?? error).slice(0, 80)}`;
      }
      events.push(`resolveHost(${h}) => ${out}`);
    }
  }

  if (cm.killNetworkService) {
    // network service を SIGKILL して再起動させ、proxy と resolver rules が維持されるか見る
    const metrics = app.getAppMetrics().filter((m) => m.name === "Network Service" || (m.type === "Utility" && /network/i.test(m.serviceName ?? "")));
    events.push(`network service pids=${metrics.map((m) => m.pid).join(",")}`);
    for (const m of metrics) { try { process.kill(m.pid, "SIGKILL"); } catch (e) { events.push(`kill failed ${e.message}`); } }
    await sleep(3000);
    const after = app.getAppMetrics().filter((m) => m.name === "Network Service" || (m.type === "Utility" && /network/i.test(m.serviceName ?? "")));
    events.push(`network service pids after=${after.map((m) => m.pid).join(",")}`);
  }

  // app:// の handler（本体の createAppProtocolHandler に header を足すだけ）
  const inner = createAppProtocolHandler(distRoot);
  const appRequests = [];
  globalThis.__appRequests = appRequests;
  ses.protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    try { appRequests.push(new URL(request.url).pathname); } catch { /* 無視 */ }
    const response = await inner(request);
    if (!cm.headers) return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cm.headers)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  });
  // 本体の permission handler と同じ形（全部拒否。TURN は permission を要さない）
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  if (cm.webRequest) {
    const seen = [];
    ses.webRequest.onBeforeRequest({ urls: ["*://*/*", "<all_urls>"] }, (d, cb) => {
      seen.push(d.url.replace(nonce, "<n>"));
      cb({});
    });
    globalThis.__webRequestSeen = seen;
  }
  if (cm.spellcheck) {
    ses.setSpellCheckerEnabled(true);
    ses.setSpellCheckerLanguages(["en-US"]);
  }

  const snapshotWebContents = () => allWebContents.getAllWebContents().map((c) => {
    let policy = "n/a";
    try { policy = c.getWebRTCIPHandlingPolicy(); } catch { /* 無視 */ }
    return {
      id: c.id,
      type: c.getType(),
      url: String(c.getURL()).slice(0, 80),
      isDefaultSession: c.session === session.defaultSession,
      policy,
    };
  });
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (cm.devtools || cm.ncSession) {
      wcLog.push({ at: Date.now(), type: contents.getType(), isDefaultSession: contents.session === session.defaultSession });
    }
    if (cm.policy) {
      contents.setWebRTCIPHandlingPolicy(cm.policy);
      // 読み戻し（FC-1 の NC-POLICY の判定に使えるか）
      events.push(`policy readback => ${contents.getWebRTCIPHandlingPolicy?.() ?? "n/a"}`);
    }
    if (cm.udpRange) {
      contents.setWebRTCUDPPortRange({ min: cm.udpRange[0], max: cm.udpRange[1] });
    }
  });

  if (cm.ncSession) {
    // NC-SESSION の実機の観測: default session でない窓。製品は何も読み込ませず破棄し、graceful な終了に入る。
    // 読み込む URL は partition の session では DIRECT になる http の server（到達すれば破棄が遅かったことになる）
    const w2 = new BrowserWindow({
      show: false,
      webPreferences: { partition: "persist:nc-session-test", sandbox: true, contextIsolation: true },
    });
    let startedLoading = 0;
    w2.webContents.on("did-start-loading", () => { startedLoading += 1; });
    let loadOutcome;
    try {
      await w2.loadURL(`http://127.0.0.1:${cfg.ports.http}/ctl-ncsession`);
      loadOutcome = "loaded";
    } catch (error) {
      loadOutcome = `error:${String(error?.code ?? error?.message ?? error).slice(0, 60)}`;
    }
    events.push(`ncSession window loadURL => ${loadOutcome} (did-start-loading x${startedLoading})`);
    extra.ncSession = { loadOutcome, startedLoading };
    await sleep(2500);
    events.push("app still running 2500 ms after the non-default-session window");
  }
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(
        __dirname,
        cm.disablePreload ? "preload-disable.cjs" : "preload.cjs",
      ),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      ...(cm.target === "partition" ? { partition: "persist:probe-renderer" } : {}),
    },
  });
  try {
    await win.loadURL(
      cm.loadUrl === "http-page"
        ? `http://127.0.0.1:${cfg.ports.http}/page.html`
        : cm.pageRan
          ? `${PROD_INDEX_URL.replace("index.html", "page-ran.html")}`
          : PROD_INDEX_URL,
    );
    extra.loadOutcome = "loaded";
  } catch (error) {
    // NC-POLICY の注入では、窓が破棄されて ERR_FAILED になる
    extra.loadOutcome = `error:${String(error?.code ?? error?.message ?? error).slice(0, 60)}`;
    events.push(`window loadURL => ${extra.loadOutcome}`);
    if (!cm.pageRan) throw error;
    await sleep(2500);
    events.push("app still running 2500 ms after the discarded window");
  }
  const contents = win.webContents;
  const prefs = contents.getLastWebPreferences();

  const probeArgs = (persist = "") => `globalThis.__probe = ${JSON.stringify({ nonce, ports: cfg.ports, lan: cfg.lan, quick: !!cm.quick, dns: !!cm.dns, gvt1: !!cm.gvt1, localhost: !!cm.localhostRows, rs1: !!cm.rs1, linklocal: !!cm.linklocal, fqdn: !!cm.fqdn, secx: !!cm.secx, local: !!cm.local, churn: !!cm.churn, persist })}`;
  const script = fs.readFileSync(env.PROBE_RENDERER_SCRIPT, "utf8");
  const runRenderer = async (persist = "") => {
    try {
      await contents.executeJavaScript(probeArgs(persist));
      return await contents.executeJavaScript(script);
    } catch (error) {
      return [{ id: "script", outcome: `error:${String(error)}` }];
    }
  };
  let rendererResults;
  if (cm.noProbes) {
    rendererResults = [];
    if (cm.pageRan) await sleep(3000); // 窓に読ませたページの script が走る時間
  } else {
    rendererResults = await runRenderer();
  }
  // 再読込・遷移の後の localhost の TURN／STUN（policy と proxy の持続。K3/3 の DA-1 が足す行）
  if (cm.reload && !cm.noProbes) {
    await new Promise((resolve) => { contents.once("did-finish-load", resolve); contents.reload(); });
    rendererResults.push(...await runRenderer("reload"));
    await contents.loadURL(`${PROD_INDEX_URL}?nav=1`);
    rendererResults.push(...await runRenderer("nav"));
  }
  // (30b) churn の後も窓が生きている（Main が終了せず、窓が応答する）
  if (cm.churn && !cm.noProbes) {
    let alive;
    try { alive = await Promise.race([contents.executeJavaScript("1 + 1"), sleep(3000).then(() => "timeout")]); } catch (error) { alive = `error:${String(error).slice(0, 60)}`; }
    extra.afterChurn = { evalResult: alive, crashed: contents.isCrashed(), destroyed: contents.isDestroyed() };
    events.push(`after churn: window eval => ${alive}, crashed=${contents.isCrashed()}`);
  }
  // DevTools の webContents（DR-NC1-9）: 非 packaged で開く DevTools が default session か、NC-SESSION を起こさないか
  if (cm.devtools) {
    contents.openDevTools({ mode: "detach" });
    await sleep(3500);
    extra.devtools = { snapshot: snapshotWebContents(), devToolsOpened: contents.isDevToolsOpened() };
    events.push(`devtools opened=${contents.isDevToolsOpened()}, webContents=${extra.devtools.snapshot.length}`);
  }

  // ── Main 側の通信が候補の影響を受けるか ───────────────────────────────
  const mainSide = [];
  const tryMain = async (id, fn) => {
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await Promise.race([fn(), sleep(4000).then(() => "timeout")]);
    } catch (error) {
      outcome = `error:${String(error?.message ?? error).slice(0, 100)}`;
    }
    await sleep(300);
    mainSide.push({ id, outcome: String(outcome), startedAt, endedAt: Date.now() });
  };
  const ctlUrl = (k) => `http://${k}-${nonce}.probe.test:${cfg.ports.http}/ctl`;
  // 窓の session での net.fetch（renderer の通信と同じ proxy の影響下か）
  await tryMain("main.net-fetch.window-session", async () =>
    (await ses.fetch(ctlUrl("winsess"))).status);
  await tryMain("main.net-fetch.default-session", async () =>
    (await net.fetch(ctlUrl("defsess"))).status);
  // electron-updater と同じ作り方: net.request + session.fromPartition("electron-updater")
  const updaterSession = session.fromPartition("electron-updater", { cache: false });
  await tryMain("main.updater-style-net-request", () =>
    new Promise((resolve, reject) => {
      const req = net.request({ url: ctlUrl("updater"), session: updaterSession });
      req.on("response", (res) => resolve(`status:${res.statusCode}`));
      req.on("error", (e) => reject(e));
      req.end();
    }));
  // Node の fetch（mozkeyInstaller などが使う globalThis.fetch）
  await tryMain("main.node-fetch", async () => (await fetch(`http://127.0.0.1:${cfg.ports.http}/ctl-node`)).status);
  // Positive (9)(v): NC-1 を当てた試験 main から、loopback の受信 socket への Main（Node）の接続が通る（Chromium の blackhole の影響を受けない）
  await tryMain("main.node-fetch.loopback-socket", () =>
    new Promise((resolve, reject) => {
      const socket = nodeNet.connect({ host: "127.0.0.1", port: cfg.ports.ctl }, () => { socket.end(); resolve("connected"); });
      socket.on("error", reject);
    }));
  // utility process 経由の net（app.setProxy が効く対象）
  await tryMain("main.net-fetch.no-session-utility", async () =>
    (await net.fetch(ctlUrl("utilfetch"), { bypassCustomProtocolHandlers: true })).status);

  if (cm.realRedirect) {
    // electron-updater と同じ session（partition electron-updater）で、公開 release の asset を取り、redirect 先の host を見る
    const updaterSession2 = session.fromPartition("electron-updater", { cache: false });
    const startedAt = Date.now();
    const outcome = await new Promise((resolve) => {
      const hosts = [];
      const req = net.request({ url: cm.realRedirect, session: updaterSession2, redirect: "manual" });
      const follow = (r) => {
        r.on("redirect", (_code, _method, redirectUrl) => {
          try { hosts.push(new URL(redirectUrl).host); } catch {}
          r.followRedirect();
        });
      };
      follow(req);
      req.on("response", (res) => { res.on("data", () => {}); res.on("end", () => resolve(`status:${res.statusCode} hops:${hosts.join(">")}`)); res.on("error", () => resolve("res-error")); });
      req.on("error", (e) => resolve(`error:${String(e.message).slice(0, 80)} hops:${hosts.join(">")}`));
      setTimeout(() => resolve(`timeout hops:${hosts.join(">")}`), 25000);
      req.end();
    });
    mainSide.push({ id: "main.updater-session-github-asset", outcome, startedAt, endedAt: Date.now() });
  }
  if (cm.realUpdater) {
    // 本物の electron-updater で更新の確認（download はしない）。partition electron-updater の net.request が使われる
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;
    autoUpdater.setFeedURL({ provider: "github", owner: "kazormia296", repo: "GrimodexReleases" });
    const startedAt = Date.now();
    let outcome;
    try {
      const r = await Promise.race([autoUpdater.checkForUpdates(), sleep(25000).then(() => "timeout")]);
      outcome = typeof r === "string" ? r : `ok:${r?.updateInfo?.version ?? "no-info"}`;
    } catch (error) {
      outcome = `error:${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`;
    }
    mainSide.push({ id: "main.real-electron-updater-check", outcome, startedAt, endedAt: Date.now() });
  }
  if (cm.spellcheck || cm.waitMs) await sleep(cm.waitMs ?? 4000);
  const result = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    cm,
    events,
    webPreferences: {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      partition: cm.target === "partition" ? "persist:probe-renderer" : "default",
    },
    rendererResults,
    mainSide,
    webRequestSeen: globalThis.__webRequestSeen ?? null,
    nc1: nc1Report(),
    extra,
    appRequests,
    dictionaries: (() => {
      try {
        const out = [];
        for (const d of ["Dictionaries"]) for (const f of fs.readdirSync(path.join(userData, d))) out.push(`${d}/${f}`);
        return out;
      } catch { return []; }
    })(),
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  await sleep(500);
  app.exit(0);
}

main().catch((error) => {
  try {
    fs.writeFileSync(resultPath, JSON.stringify({ fatal: String(error?.stack ?? error) }));
  } finally {
    app.exit(2);
  }
});

void protocol;
