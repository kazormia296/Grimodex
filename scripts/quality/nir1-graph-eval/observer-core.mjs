// CP-4 S1c-1: the NC-1 observer that runs in the Electron Main before the
// product main (TASK §15.1 D6 (a'); DR-CP4-S1C1-1〜3).
//
// The harness launches Electron in the dev-server form
// (`ELECTRON_RENDERER_URL`), for which the product's `index.ts` skips NC-1
// (MD-1: `shouldRegisterAppProtocol()` is false). This observer applies the
// same NC-1 parts in the product's order with the product's own orchestrator
// (`createRendererContainment`, real Electron deps):
//
//   before ready: appendResolverSwitch()  → registerWebContentsPolicy()
//                 → app.whenReady is gated → the product main is required
//   after ready:  start() (listener → setProxy, the first default-session
//                 touch → closeAllConnections → self-check (a)〜(c))
//                 → bypass read-back → spellchecker off → release the gate,
//                 so the product's whenReady continuation
//                 (applySessionPermissionPolicy, …) runs only afterwards.
//
// Differences from the product (disclosed in cp4-decisions.md):
// the bypass gains exactly the static server origin; the spellchecker is
// turned off; the switch and the policy handler are registered before the
// product's own pre-ready code. A failing start() prints the product's fixed
// code and quits like the product; a failing harness check prints a
// `CP4-OBS-*` code and quits. The product main never continues in either.
//
// This module takes every dependency as an argument (node:test drives it
// with fakes); `electron-observer.entry.mjs` wires the real ones.

import console from "node:console";
import { setImmediate } from "node:timers";
import { URL } from "node:url";

export const OBSERVER_SCHEMA = "nir1-cp4-observer/1";
export const OBSERVER_LINE_PREFIX = "[cp4-observer]";
export const OBSERVER_FAILURE_CODES = Object.freeze([
  "CP4-OBS-ORIGIN",
  "CP4-OBS-PROXY-CONFIG",
  "CP4-OBS-BYPASS",
  "CP4-OBS-SPELLCHECK",
  "CP4-OBS-INTERNAL",
]);
/** The product's `PROXY_BYPASS_RULES` the harness extends (and only this). */
export const PRODUCT_PROXY_BYPASS_RULES = "<-loopback>";

/**
 * The static server origin from `ELECTRON_RENDERER_URL`: exactly
 * `http://127.0.0.1:<port>` (no userinfo, no other host or scheme).
 */
export function staticOriginFromRendererUrl(rendererUrl) {
  let url;
  try {
    url = new URL(String(rendererUrl));
  } catch {
    throw new Error("CP4-OBS-ORIGIN: ELECTRON_RENDERER_URL is not a URL");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^http:\/\/127\.0\.0\.1:\d+\//u.test(String(rendererUrl))
  )
    throw new Error(
      "CP4-OBS-ORIGIN: the renderer must be the loopback static server http://127.0.0.1:<port>/",
    );
  return { origin: `http://127.0.0.1:${port}`, port };
}

/**
 * The product proxy config with exactly one more bypass rule: the static
 * server origin. Refuses anything that is not the product's shape.
 */
export function harnessProxyConfig(config, origin) {
  if (
    config?.mode !== "fixed_servers" ||
    typeof config.proxyRules !== "string" ||
    !/^socks5:\/\/127\.0\.0\.1:\d+$/u.test(config.proxyRules) ||
    config.proxyBypassRules !== PRODUCT_PROXY_BYPASS_RULES ||
    Object.keys(config).length !== 3
  )
    throw new Error(
      "CP4-OBS-PROXY-CONFIG: the product proxy config is not the NC-1 shape the harness extends",
    );
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin))
    throw new Error("CP4-OBS-PROXY-CONFIG: the bypass origin is not loopback");
  return {
    mode: config.mode,
    proxyRules: config.proxyRules,
    proxyBypassRules: `${config.proxyBypassRules};${origin}`,
  };
}

function codeOf(error) {
  const match = /^(CP4-OBS-[A-Z-]+)/u.exec(String(error?.message ?? ""));
  return match ? match[1] : "CP4-OBS-INTERNAL";
}

export function formatObserverFailure(code) {
  return `${OBSERVER_LINE_PREFIX} ${code}`;
}

/**
 * Installs the observer. Must be called before the product main is required;
 * it requires the product main itself (`requireProductMain`) after the
 * pre-ready steps. Returns the live record (exposed for `app.evaluate`).
 */
export function installCp4Observer({
  app,
  getDefaultSession,
  nc1,
  rendererUrl,
  requireProductMain,
  reportFailure = (line) => console.error(line),
  now = Date.now,
  defer = (callback) => setImmediate(callback),
}) {
  const record = {
    schema: OBSERVER_SCHEMA,
    rendererUrlPresent: typeof rendererUrl === "string" && rendererUrl !== "",
    // K6/3 calls only a launch without ELECTRON_RENDERER_URL "NC-1 を当てた起動".
    k63Nc1Launch: false,
    staticOrigin: null,
    hostResolverRules: null,
    proxyConfig: null,
    blackholePort: null,
    marks: [],
    webContentsCreated: 0,
    startOk: null,
    readBack: null,
    spellcheckerEnabledAfter: null,
    released: false,
    failures: [],
  };
  const mark = (name) => record.marks.push({ name, at: now() });
  const fail = (code) => {
    const line = formatObserverFailure(code);
    record.failures.push(line);
    reportFailure(line);
    app.quit();
  };

  const { origin, port: staticPort } = staticOriginFromRendererUrl(rendererUrl);
  record.staticOrigin = origin;

  let patched = false;
  const deps = {
    appendSwitch: (name, value) => {
      if (name === "host-resolver-rules") record.hostResolverRules = value;
      app.commandLine.appendSwitch(name, value);
      mark(`appendSwitch ${name}`);
    },
    onWebContentsCreated: (listener) => {
      app.on("web-contents-created", (_event, contents) => {
        record.webContentsCreated += 1;
        listener(contents);
      });
    },
    onBeforeQuit: (listener) => {
      app.on("before-quit", listener);
    },
    quit: () => app.quit(),
    defer,
    getDefaultSession: () => {
      const session = getDefaultSession();
      if (!patched) {
        patched = true;
        mark("defaultSession first touch");
        // Wrap the real session's setProxy once (the policy handler compares
        // the session object, so the session itself is never replaced).
        const original = session.setProxy.bind(session);
        session.setProxy = async (config) => {
          session.setProxy = original;
          const extended = harnessProxyConfig(config, origin);
          record.proxyConfig = extended;
          mark("setProxy start");
          await original(extended);
          mark("setProxy done");
        };
      }
      return session;
    },
    startListener: (options) =>
      nc1.startBlackholeListener(options).then((listener) => {
        record.blackholePort = listener.port;
        mark("listener up");
        return listener;
      }),
    reportFailure: (line) => {
      record.failures.push(line);
      reportFailure(line);
    },
  };
  const containment = nc1.createRendererContainment(deps);

  // Gate the product's whenReady continuation on the containment.
  const upstreamWhenReady = app.whenReady.bind(app);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.whenReady = () => gate;

  containment.appendResolverSwitch();
  containment.registerWebContentsPolicy();
  mark("registerWebContentsPolicy");

  upstreamWhenReady()
    .then(async (event) => {
      mark("ready");
      const ok = await containment.start();
      record.startOk = ok;
      mark("nc1 start done");
      if (!ok) return; // the product's code is printed and app.quit() runs
      const session = getDefaultSession();
      const blackhole = nc1.expectedBlackholeProxyString(record.blackholePort);
      const otherPort = staticPort === 65535 ? staticPort - 1 : staticPort + 1;
      const readBack = {
        staticOrigin: await session.resolveProxy(`${origin}/`),
        otherLoopbackPort: await session.resolveProxy(
          `http://127.0.0.1:${otherPort}/`,
        ),
        loopbackPort1: await session.resolveProxy("http://127.0.0.1:1/"),
        external: await session.resolveProxy("https://example.invalid/"),
        expectedBlackhole: blackhole,
      };
      record.readBack = readBack;
      if (
        readBack.staticOrigin !== "DIRECT" ||
        readBack.otherLoopbackPort !== blackhole ||
        readBack.loopbackPort1 !== blackhole ||
        readBack.external !== blackhole
      )
        throw new Error("CP4-OBS-BYPASS");
      session.setSpellCheckerEnabled(false);
      record.spellcheckerEnabledAfter = session.isSpellCheckerEnabled();
      if (record.spellcheckerEnabledAfter !== false)
        throw new Error("CP4-OBS-SPELLCHECK");
      mark("released");
      record.released = true;
      release(event);
    })
    .catch((error) => fail(codeOf(error)));

  mark("product main require");
  requireProductMain();
  mark("product main required");
  return record;
}
