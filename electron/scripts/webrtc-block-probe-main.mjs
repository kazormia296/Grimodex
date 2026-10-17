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
 */
import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, net, protocol, session } from "electron";

import {
  APP_PROTOCOL_SCHEME,
  createAppProtocolHandler,
  PROD_INDEX_URL,
  registerAppProtocolScheme,
} from "../main/protocol.ts";

const env = process.env;
const cm = JSON.parse(env.PROBE_CM || "{}");
const cfg = JSON.parse(env.PROBE_CFG);
const { userData, distRoot, resultPath, nonce } = cfg;

app.setPath("userData", userData);
app.disableHardwareAcceleration();
registerAppProtocolScheme();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const subst = (value) =>
  JSON.parse(
    JSON.stringify(value).replaceAll(
      "PROXYHOSTPORT",
      `127.0.0.1:${cfg.ports.proxy}`,
    ).replaceAll("CANARYP", String(cfg.ports.p)),
  );

async function main() {
  await app.whenReady();
  const events = [];

  const ses =
    cm.target === "partition"
      ? session.fromPartition("persist:probe-renderer")
      : session.defaultSession;

  if (cm.appSetProxy) {
    await app.setProxy(subst(cm.appSetProxy));
    events.push("app.setProxy applied");
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

  // app:// の handler（本体の createAppProtocolHandler に header を足すだけ）
  const inner = createAppProtocolHandler(distRoot);
  ses.protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
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

  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (cm.policy) contents.setWebRTCIPHandlingPolicy(cm.policy);
    if (cm.udpRange) {
      contents.setWebRTCUDPPortRange({ min: cm.udpRange[0], max: cm.udpRange[1] });
    }
  });

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
  await win.loadURL(
    cm.loadUrl === "http-page"
      ? `http://127.0.0.1:${cfg.ports.http}/page.html`
      : PROD_INDEX_URL,
  );
  const contents = win.webContents;
  const prefs = contents.getLastWebPreferences();

  await contents.executeJavaScript(
    `globalThis.__probe = ${JSON.stringify({ nonce, ports: cfg.ports, lan: cfg.lan, quick: !!cm.quick })}`,
  );
  const script = fs.readFileSync(env.PROBE_RENDERER_SCRIPT, "utf8");
  let rendererResults;
  if (cm.noProbes) rendererResults = [];
  else try {
    rendererResults = await contents.executeJavaScript(script);
  } catch (error) {
    rendererResults = [{ id: "script", outcome: `error:${String(error)}` }];
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
  // utility process 経由の net（app.setProxy が効く対象）
  await tryMain("main.net-fetch.no-session-utility", async () =>
    (await net.fetch(ctlUrl("utilfetch"), { bypassCustomProtocolHandlers: true })).status);

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
