import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import {
  OBSERVER_SCHEMA,
  PRODUCT_PROXY_BYPASS_RULES,
  harnessProxyConfig,
  installCp4Observer,
  staticOriginFromRendererUrl,
} from "./observer-core.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const RENDERER_URL = "http://127.0.0.1:43123/index.html";

test("DR-CP4-S1C1-2: the bypass origin is exactly the loopback static server", () => {
  assert.deepEqual(staticOriginFromRendererUrl(RENDERER_URL), {
    origin: "http://127.0.0.1:43123",
    port: 43123,
  });
  for (const bad of [
    "http://localhost:43123/index.html",
    "https://127.0.0.1:43123/index.html",
    "http://127.0.0.1/index.html",
    "http://127.0.0.1:80/",
    "http://user@127.0.0.1:43123/",
    "http://127.0.0.2:43123/",
    "http://[::1]:43123/",
    "app://bundle/index.html",
    "",
    undefined,
  ])
    assert.throws(
      () => staticOriginFromRendererUrl(bad),
      /CP4-OBS-ORIGIN/,
      String(bad),
    );
});

test("DR-CP4-S1C1-2: the harness extends only the product proxy config, by one origin", () => {
  const product = {
    mode: "fixed_servers",
    proxyRules: "socks5://127.0.0.1:41000",
    proxyBypassRules: PRODUCT_PROXY_BYPASS_RULES,
  };
  assert.deepEqual(harnessProxyConfig(product, "http://127.0.0.1:43123"), {
    ...product,
    proxyBypassRules: "<-loopback>;http://127.0.0.1:43123",
  });
  for (const config of [
    { ...product, proxyBypassRules: "<-loopback>;127.0.0.1" },
    { ...product, proxyBypassRules: "" },
    { ...product, mode: "direct" },
    { ...product, proxyRules: "socks5://10.0.0.1:1080" },
    { ...product, extra: 1 },
  ])
    assert.throws(
      () => harnessProxyConfig(config, "http://127.0.0.1:43123"),
      /CP4-OBS-PROXY-CONFIG/,
    );
  assert.throws(
    () => harnessProxyConfig(product, "http://127.0.0.1"),
    /not loopback/,
  );
  // The constant is the product's value (rendererContainment.ts).
  assert.match(
    readFileSync(
      path.join(ROOT, "electron/main/rendererContainment.ts"),
      "utf8",
    ),
    /const NEGATE_LOOPBACK_BYPASS = "<-loopback>";/,
  );
});

/** Fake Electron app/session and a fake product orchestrator with the product's order. */
function harness({
  startOk = true,
  readBack = {},
  spellcheck = false,
  productTouchesSession = true,
} = {}) {
  const events = [];
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const listeners = {};
  const session = {
    proxyCalls: [],
    async setProxy(config) {
      events.push("session.setProxy");
      this.proxyCalls.push(config);
    },
    async resolveProxy(url) {
      if (readBack[url] !== undefined) return readBack[url];
      return url.startsWith("http://127.0.0.1:43123/")
        ? "DIRECT"
        : "SOCKS5 127.0.0.1:41000";
    },
    spell: true,
    setSpellCheckerEnabled(value) {
      events.push(`spellchecker ${value}`);
      this.spell = spellcheck ? true : value;
    },
    isSpellCheckerEnabled() {
      return this.spell;
    },
  };
  const app = {
    commandLine: {
      appendSwitch: (name) => events.push(`appendSwitch ${name}`),
    },
    on: (name, listener) => {
      listeners[name] = listener;
      events.push(`on ${name}`);
    },
    quit: () => events.push("quit"),
    whenReady: () => ready,
  };
  const nc1 = {
    expectedBlackholeProxyString: (port) => `SOCKS5 127.0.0.1:${port}`,
    startBlackholeListener: async () => ({ port: 41000 }),
    createRendererContainment(deps) {
      return {
        appendResolverSwitch: () =>
          deps.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND"),
        registerWebContentsPolicy: () => {
          deps.onBeforeQuit(() => {});
          deps.onWebContentsCreated(() => {});
        },
        async start() {
          const listener = await deps.startListener({});
          const ses = deps.getDefaultSession();
          await ses.setProxy({
            mode: "fixed_servers",
            proxyRules: `socks5://127.0.0.1:${listener.port}`,
            proxyBypassRules: "<-loopback>",
          });
          if (!startOk) {
            deps.reportFailure("[grimodex-electron] NC-SELF-PROXY: ...");
            deps.quit();
          }
          return startOk;
        },
      };
    },
  };
  const lines = [];
  const record = installCp4Observer({
    app,
    getDefaultSession: () => session,
    nc1,
    rendererUrl: RENDERER_URL,
    requireProductMain: () => {
      events.push("product main");
      // The product's index.ts: whenReady().then(applySessionPermissionPolicy …)
      app.whenReady().then(() => {
        events.push("product whenReady continuation");
        if (productTouchesSession) events.push("product touches session");
      });
    },
    reportFailure: (line) => lines.push(line),
    defer: (callback) => callback(),
  });
  return { events, record, session, lines, ready: () => readyResolve({}) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("DR-CP4-S1C1-1: the product order — switch and policy before the product main, NC-1 before the product continues", async () => {
  const h = harness();
  assert.deepEqual(h.events, [
    "appendSwitch host-resolver-rules",
    "on before-quit",
    "on web-contents-created",
    "product main",
  ]);
  h.ready();
  await settle();
  await settle();
  const setProxy = h.events.indexOf("session.setProxy");
  const product = h.events.indexOf("product whenReady continuation");
  assert.ok(setProxy >= 0 && product > setProxy, h.events.join(" > "));
  assert.ok(h.events.indexOf("spellchecker false") < product);
  assert.equal(h.record.schema, OBSERVER_SCHEMA);
  assert.equal(h.record.startOk, true);
  assert.equal(h.record.released, true);
  assert.equal(h.record.k63Nc1Launch, false);
  assert.equal(h.record.rendererUrlPresent, true);
  assert.deepEqual(h.session.proxyCalls, [
    {
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:41000",
      proxyBypassRules: "<-loopback>;http://127.0.0.1:43123",
    },
  ]);
  assert.equal(h.record.spellcheckerEnabledAfter, false);
  assert.equal(h.record.readBack.staticOrigin, "DIRECT");
  assert.deepEqual(
    h.record.marks.map((row) => row.name),
    [
      "appendSwitch host-resolver-rules",
      "registerWebContentsPolicy",
      "product main require",
      "product main required",
      "ready",
      "listener up",
      "defaultSession first touch",
      "setProxy start",
      "setProxy done",
      "nc1 start done",
      "released",
    ],
  );
  assert.deepEqual(h.lines, []);
});

test("a failing NC-1 start never lets the product continue", async () => {
  const h = harness({ startOk: false });
  h.ready();
  await settle();
  await settle();
  assert.ok(!h.events.includes("product whenReady continuation"));
  assert.ok(h.events.includes("quit"));
  assert.equal(h.record.released, false);
  assert.match(h.lines.join(), /NC-SELF-PROXY/);
});

test("DR-CP4-S1C1-2/3: a wrong bypass read-back or a live spellchecker stops before the product", async () => {
  for (const [options, code] of [
    [
      { readBack: { "http://127.0.0.1:43123/": "SOCKS5 127.0.0.1:41000" } },
      "CP4-OBS-BYPASS",
    ],
    [{ readBack: { "http://127.0.0.1:43124/": "DIRECT" } }, "CP4-OBS-BYPASS"],
    [{ readBack: { "http://127.0.0.1:1/": "DIRECT" } }, "CP4-OBS-BYPASS"],
    [{ readBack: { "https://example.invalid/": "DIRECT" } }, "CP4-OBS-BYPASS"],
    [{ spellcheck: true }, "CP4-OBS-SPELLCHECK"],
  ]) {
    const h = harness(options);
    h.ready();
    await settle();
    await settle();
    assert.ok(!h.events.includes("product whenReady continuation"), code);
    assert.deepEqual(h.lines, [`[cp4-observer] ${code}`]);
    assert.ok(h.events.includes("quit"));
  }
});

test("the observer refuses a renderer URL that is not the static server before anything runs", () => {
  const refused = [];
  assert.throws(
    () =>
      installCp4Observer({
        app: { commandLine: { appendSwitch: () => refused.push("switch") } },
        getDefaultSession: () => ({}),
        nc1: { createRendererContainment: () => refused.push("containment") },
        rendererUrl: "http://example.com:5173/",
        requireProductMain: () => refused.push("product main"),
      }),
    /CP4-OBS-ORIGIN/,
  );
  assert.deepEqual(refused, []);
});

test("the entry wires the product NC-1 modules, not copies", () => {
  const entry = readFileSync(
    path.join(
      ROOT,
      "scripts/quality/nir1-graph-eval/electron-observer.entry.mjs",
    ),
    "utf8",
  );
  for (const module of [
    "electron/main/rendererContainmentStartup.ts",
    "electron/main/rendererContainmentListener.ts",
    "electron/main/rendererContainment.ts",
  ])
    assert.ok(entry.includes(`../../../${module}`), module);
  assert.ok(!/buildHostResolverRules\(|buildProxyConfig\(/u.test(entry));
  const core = readFileSync(
    path.join(ROOT, "scripts/quality/nir1-graph-eval/observer-core.mjs"),
    "utf8",
  );
  // The core never builds its own rules or proxy string.
  assert.ok(
    !/MAP \*|EXCLUDE |socks5:\/\/127\.0\.0\.1:\$\{/u.test(
      core.replace(/^\s*(\/\/|\*).*$/gmu, ""),
    ),
  );
});
