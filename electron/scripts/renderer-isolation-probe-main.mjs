/**
 * Y-1 の probe の main（K3/2「renderer の隔離とその固定」3。DA-1）。
 * `renderer-isolation-probe.mjs` が esbuild で束ねて Electron で起動する。診断用で、
 * 製品を変えない。本体の protocol.ts、security.ts、windows.ts（createMainWindow）、
 * downloadGuard.ts、profileDataGuard.ts をそのまま使い、restricted の gate と窓の title の
 * 固定を有効にした状態で、乗っ取られた renderer 相当の JS を実行する。
 *
 * NC-1（K3/3。NC-1 の lane、S4）: 製品の orchestrator（`createRendererContainment`）を `index.ts` と
 * 同じ順序で当てる（ready の前に appendResolverSwitch と registerWebContentsPolicy、ready の後で
 * default session の最初の接触として start()）。これで WebRTC の ICE server の finding（TURN の TCP／TLS
 * の接続と名前解決）が Main の network 層で塞がれる。対照（`PROBE_LEGACY=1`、DA-1 の前の挙動）には
 * 当てない（CSP のない realm の外向きが canary に届くことを示す対照なので）。launcher の
 * `--host-resolver-rules`（`*.probe.test` を canary へ写す）は NC-1 の switch が置き換えるので、
 * probe だけが持つ `prefixRules` の seam で同じ写しを製品の `buildHostResolverRules(prefixRules)` に渡す
 * （S3 の DR-NC1-24 と同じ面。製品の呼出しは引数なし）。
 *
 * 入力の env（launcher が設定）: PROBE_USER_DATA、PROBE_DIST、PROBE_RESULT、PROBE_PORT、
 * PROBE_NONCE、PROBE_RENDERER_SCRIPT、PROBE_COUNTERMEASURE（任意。Y-1 の対処の候補）。
 */
import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, protocol, session } from "electron";

import { installDownloadGuard } from "../main/downloadGuard.ts";
import { createProfileDataGuard } from "../main/profileDataGuard.ts";
import { buildHostResolverRules } from "../main/rendererContainment.ts";
import { startBlackholeListener } from "../main/rendererContainmentListener.ts";
import { createRendererContainment } from "../main/rendererContainmentStartup.ts";
import {
  createAppProtocolHandler,
  registerAppProtocolHandler,
  registerAppProtocolScheme,
} from "../main/protocol.ts";
import {
  applySessionPermissionPolicy,
  registerSecurityHandlers,
  setExternalEgressGate,
} from "../main/security.ts";
import {
  createMainWindow,
  getWindow,
  openPanelWindow,
  setWindowTitleLock,
} from "../main/windows.ts";

const env = process.env;
const userData = env.PROBE_USER_DATA;
const distRoot = env.PROBE_DIST;
const resultPath = env.PROBE_RESULT;
const port = Number(env.PROBE_PORT);
const nonce = env.PROBE_NONCE;
const countermeasure = env.PROBE_COUNTERMEASURE ?? "";
// 対照: DA-1 の前の挙動（HTML だけに CSP を付ける）で検査が検出できること。
const legacyControl = env.PROBE_LEGACY === "1";
for (const [name, value] of Object.entries({
  userData,
  distRoot,
  resultPath,
  nonce,
})) {
  if (!value) throw new Error(`probe env ${name} is required`);
}

app.setPath("userData", userData);
// デバッグ用の GPU 無効（網とは無関係。Xvfb に GPU がない）。
app.disableHardwareAcceleration();

registerAppProtocolScheme();
const PROBE_CANARY_PREFIX_RULES = ["MAP *.probe.test 127.0.0.1"];
const containment = legacyControl
  ? null
  : createRendererContainment({
      appendSwitch: (name, value) => {
        if (
          name !== "host-resolver-rules" ||
          value !== buildHostResolverRules()
        ) {
          throw new Error(
            "product host-resolver-rules switch differs from buildHostResolverRules()",
          );
        }
        app.commandLine.appendSwitch(
          name,
          buildHostResolverRules(PROBE_CANARY_PREFIX_RULES),
        );
      },
      onWebContentsCreated: (listener) => {
        app.on("web-contents-created", (_event, contents) => {
          listener(contents);
        });
      },
      onBeforeQuit: (listener) => {
        app.on("before-quit", listener);
      },
      quit: () => app.quit(),
      defer: (callback) => {
        setImmediate(callback);
      },
      getDefaultSession: () => session.defaultSession,
      startListener: (options) => startBlackholeListener(options),
      reportFailure: (line) => console.error(line),
    });
containment?.appendResolverSwitch();
registerSecurityHandlers(app);
containment?.registerWebContentsPolicy();
if (countermeasure.includes("force-webrtc-policy-switch")) {
  app.commandLine.appendSwitch(
    "force-webrtc-ip-handling-policy",
    "disable_non_proxied_udp",
  );
}

const observed = {
  willNavigate: [],
  windowOpen: [],
  newWindow: 0,
  downloads: [],
  dialogs: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await app.whenReady();
  // NC-1: default session の最初の接触（listener → setProxy → closeAllConnections → 自己確認）
  if (containment && !(await containment.start())) {
    throw new Error("NC-1 start failed");
  }
  applySessionPermissionPolicy();
  // restricted の gate: openExternal を拒否する。窓の title を固定する。
  setExternalEgressGate(() => {
    throw new Error("D2A_EGRESS_DENIED: probe (restricted)");
  });
  let titleLocked = true;
  setWindowTitleLock(() => titleLocked);
  if (legacyControl || countermeasure.includes("csp-webrtc-block")) {
    const inner = createAppProtocolHandler(distRoot);
    protocol.handle("app", async (request) => {
      const response = await inner(request);
      const headers = new Headers(response.headers);
      if (legacyControl) {
        if (!(headers.get("content-type") ?? "").startsWith("text/html")) {
          headers.delete("content-security-policy");
        }
      } else {
        headers.set(
          "Content-Security-Policy",
          `${headers.get("Content-Security-Policy")}; webrtc 'block'`,
        );
      }
      return new Response(response.body, { status: response.status, headers });
    });
  } else {
    registerAppProtocolHandler(distRoot);
  }

  // Y-1 の対処の候補（env で有効化。製品に入れるかは別の判断）。
  if (countermeasure.includes("webrtc-disable-non-proxied-udp")) {
    app.on("web-contents-created", (_e, contents) => {
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    });
  }

  // Chromium の download: 本体の downloadGuard を、保存 dialog だけ差し替えて使う。
  const profileGuard = createProfileDataGuard(() => userData);
  const stateFile = path.join(userData, "profile-egress.json");
  fs.writeFileSync(stateFile, '{"genuine":true}');
  let nextDestination = stateFile;
  const notices = [];
  installDownloadGuard(session.defaultSession, {
    guard: profileGuard,
    tmpdir: () => app.getPath("temp"),
    pickSavePath: async (_wc, options) => {
      observed.dialogs.push({ suggestedName: options.suggestedName });
      return nextDestination;
    },
    notify: (notice) => notices.push(notice),
  });
  session.defaultSession.on("will-download", (_event, item) => {
    observed.downloads.push({
      filename: item.getFilename(),
      savePathSetSynchronously: item.getSavePath() !== "",
      savePathInsideUserData: item.getSavePath().startsWith(userData),
    });
  });

  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (_event, url) => {
      observed.willNavigate.push(
        new URL(url).host.replace(/-[0-9a-f]+\./, "-N."),
      );
    });
    contents.setWindowOpenHandler(({ url }) => {
      observed.windowOpen.push(
        new URL(url).host.replace(/-[0-9a-f]+\./, "-N."),
      );
      return { action: "deny" };
    });
  });
  app.on("browser-window-created", () => {
    observed.newWindow += 1;
  });

  const win = createMainWindow();
  await new Promise((resolve) =>
    win.webContents.once("did-finish-load", resolve),
  );
  const contents = win.webContents;
  const prefs = contents.getLastWebPreferences();
  const productTitle = win.getTitle();

  await contents.executeJavaScript(
    `globalThis.__probe = ${JSON.stringify({ port, nonce })}`,
  );
  const script = fs.readFileSync(env.PROBE_RENDERER_SCRIPT, "utf8");
  let rendererResults;
  try {
    rendererResults = await contents.executeJavaScript(script);
  } catch (error) {
    rendererResults = [{ id: "script", outcome: `error:${String(error)}` }];
  }
  const titleAfterLocked = win.getTitle();

  // 対照: 固定を外すと document.title が窓の title に反映される（検査が検出できること）。
  titleLocked = false;
  await contents.executeJavaScript(`document.title = "UNLOCKED-${nonce}"`);
  await sleep(300);
  const titleAfterUnlocked = win.getTitle();
  titleLocked = true;

  // grim:panel-open の title option（renderer が渡せる値）。固定中は生成時の窓の title に
  // 載らないこと。パネル窓は検査のあとで閉じる。
  const newWindowsBeforePanel = observed.newWindow;
  openPanelWindow("panel-probe", { title: `PANEL-${nonce}` });
  const panelWin = getWindow("panel-probe");
  const titlePanelOpenWhileLocked = panelWin ? panelWin.getTitle() : null;
  if (panelWin) panelWin.destroy();
  // 検査用に開いた窓は window.open の観測（新しい窓の数）に数えない。
  observed.newWindow = newWindowsBeforePanel;

  // Chromium の download（programmatic click。利用者の操作なし）。
  const downloadResults = [];
  for (const [id, filename, destination] of [
    ["download.attack-state-file", "profile-egress.json", stateFile],
    [
      "download.control-normal-destination",
      "export.txt",
      path.join(path.dirname(userData), "documents-out.txt"),
    ],
  ]) {
    nextDestination = destination;
    const before = fs.existsSync(stateFile)
      ? fs.readFileSync(stateFile, "utf8")
      : null;
    await contents.executeJavaScript(`(() => {
      const blob = new Blob(["DOWNLOADED-${nonce}"]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ${JSON.stringify(filename)};
      document.body.append(a);
      a.click();
    })()`);
    await sleep(1500);
    downloadResults.push({
      id,
      stateFileUnchanged:
        (fs.existsSync(stateFile)
          ? fs.readFileSync(stateFile, "utf8")
          : null) === before,
      destinationWritten:
        destination !== stateFile ? fs.existsSync(destination) : null,
    });
    if (destination !== stateFile && fs.existsSync(destination))
      fs.rmSync(destination);
  }

  const result = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    webPreferences: {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
      webSecurity: prefs.webSecurity,
    },
    countermeasure,
    legacyControl,
    rendererResults,
    title: {
      product: productTitle,
      afterRendererSetItWhileLocked: titleAfterLocked,
      afterRendererSetItWhileUnlocked: titleAfterUnlocked,
      panelOpenOptionWhileLocked: titlePanelOpenWhileLocked,
    },
    observed,
    downloadResults,
    downloadNotices: notices,
    picker: { outcome: "not-run", stateFileUnchanged: true },
    print: { outcome: "not-run" },
    windowCount: BrowserWindow.getAllWindows().length,
  };
  // 以降の picker と print は、OS の dialog で止まりうる。先に結果を書いておく。
  const flush = () =>
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  flush();

  // File System Access API の picker（利用者の操作がある前提 = userGesture）。
  result.picker.outcome = "hung";
  flush();
  try {
    result.picker.outcome = await Promise.race([
      contents.executeJavaScript(
        `(async () => { try { const h = await window.showSaveFilePicker({ suggestedName: "profile-egress.json" }); const w = await h.createWritable(); await w.write("X"); await w.close(); return "written"; } catch (e) { return "rejected:" + e.name; } })()`,
        true,
      ),
      sleep(4000).then(() => "pending-after-4s"),
    ]);
  } catch (error) {
    result.picker.outcome = `error:${String(error)}`;
  }
  result.picker.stateFileUnchanged =
    fs.readFileSync(stateFile, "utf8") === '{"genuine":true}';
  flush();

  // window.print()（利用者の操作がある前提）。Print to File の dialog が出るかを見る。
  result.print.outcome = "hung";
  flush();
  try {
    result.print.outcome = await Promise.race([
      contents
        .executeJavaScript(
          `(() => { window.print(); return "returned"; })()`,
          true,
        )
        .then((value) => value),
      sleep(4000).then(() => "pending-after-4s"),
    ]);
  } catch (error) {
    result.print.outcome = `error:${String(error)}`;
  }
  result.windowCount = BrowserWindow.getAllWindows().length;
  flush();

  await sleep(1500);
  app.exit(0);
}

main().catch((error) => {
  try {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ fatal: String(error?.stack ?? error) }),
    );
  } finally {
    app.exit(2);
  }
});
