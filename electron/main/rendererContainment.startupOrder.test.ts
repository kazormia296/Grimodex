/**
 * 製品の `index.ts` の起動順序の試験（K3/3 の Negative (30a) の「適用失敗と起動の順序」）。
 *
 * module 単体の順序ではなく、製品の `index.ts` を electron とその依存をモックして実際に
 * 通し、呼出し順を 1 つの記録で観測する。固定する順序（draft の「起動手順 (0)〜(6)」）:
 * (i) `appendSwitch` は ready の前、(ii) policy の handler の登録は最初の webContents の
 * 作成より前、(iii) `setProxy` と `closeAllConnections` の完了は最初の窓の作成より前、
 * (iv) NC-1 の完了（自己確認まで）は `initBackend` の最初の呼出しより前、(v) default
 * session の接触（`session.defaultSession` の getter と `protocol.*` の暗黙の接触）の最初が
 * NC-1 の `setProxy` で、`applySessionPermissionPolicy`／`installProductDownloadGuard`／
 * `registerAppProtocolHandler` はその後。
 *
 * 対照: 窓の作成・`initBackend`・既存の接触のいずれかを NC-1 の前へ動かした `index.ts`
 * （source を書き換えた写し）と、記録の並べ替えが、この試験を赤にする。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PORT = 41234;

const h = vi.hoisted(() => {
  type Mode = {
    isPackaged: boolean;
    failListen: boolean;
    setProxy: "ok" | "reject" | "hang";
    closeAll: "ok" | "reject";
    literalResolves: boolean;
    proxyAnswer: string;
    contents: "ok" | "policy-throws" | "policy-mismatch" | "foreign-session";
  };
  const state = {
    log: [] as string[],
    errors: [] as unknown[][],
    mode: {} as Mode,
    app: undefined as unknown as EventEmitter & Record<string, unknown>,
    defaultSession: undefined as unknown as Record<string, unknown>,
    resolveReady: (() => undefined) as () => void,
    onClosed: undefined as undefined | (() => void),
    dialogCalls: 0,
  };
  const defaultMode = (): Mode => ({
    isPackaged: true,
    failListen: false,
    setProxy: "ok",
    closeAll: "ok",
    literalResolves: false,
    proxyAnswer: "",
    contents: "ok",
  });
  function makeDeep(): object {
    const target = function (): undefined {
      return undefined;
    };
    const proxy: object = new Proxy(target, {
      get: (_t, prop) =>
        prop === "then" || typeof prop === "symbol" ? undefined : proxy,
      apply: () => proxy,
      construct: () => proxy,
      has: () => true,
    });
    return proxy;
  }
  /** 任意の named import に deep stub を返す module。 */
  function deepModule(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const deep = makeDeep();
    return new Proxy(overrides, {
      get: (t, prop) => {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        return prop in t ? t[prop] : deep;
      },
      has: () => true,
    });
  }
  return { state, defaultMode, makeDeep, deepModule };
});

const { state } = h;
const log = (label: string): void => {
  state.log.push(label);
};
void log;

vi.mock("electron", () => {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const originalOn = emitter.on.bind(emitter);
  emitter.on = ((event: string, listener: (...args: unknown[]) => void) => {
    state.log.push(`app.on:${event}`);
    return originalOn(event, listener);
  }) as typeof emitter.on;
  Object.defineProperty(emitter, "isPackaged", {
    get: () => state.mode.isPackaged,
  });
  emitter.commandLine = {
    appendSwitch: (name: string) => {
      state.log.push(`appendSwitch:${name}`);
    },
  };
  emitter.requestSingleInstanceLock = () => true;
  emitter.setAsDefaultProtocolClient = () => true;
  emitter.getVersion = () => "0.0.0-test";
  emitter.whenReady = () =>
    new Promise<void>((resolve) => {
      state.resolveReady = resolve;
    });
  emitter.quit = () => {
    state.log.push("app.quit");
  };
  emitter.exit = () => {
    state.log.push("app.exit");
  };
  state.app = emitter;

  const defaultSession: Record<string, unknown> = {
    setProxy: async () => {
      state.log.push("setProxy:begin");
      if (state.mode.setProxy === "hang") return new Promise(() => undefined);
      await Promise.resolve();
      if (state.mode.setProxy === "reject") throw new Error("boom");
      state.log.push("setProxy:end");
      return undefined;
    },
    closeAllConnections: async () => {
      state.log.push("closeAllConnections:begin");
      await Promise.resolve();
      if (state.mode.closeAll === "reject") throw new Error("boom");
      state.log.push("closeAllConnections:end");
    },
    resolveHost: async (host: string) => {
      state.log.push(`resolveHost:${host}`);
      if (host === "grimodex-rule-sentinel.invalid") {
        return { endpoints: [{ address: "127.0.0.1" }] };
      }
      if (state.mode.literalResolves) {
        return { endpoints: [{ address: "203.0.113.7" }] };
      }
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
    resolveProxy: async (url: string) => {
      state.log.push(`resolveProxy:${url}`);
      return state.mode.proxyAnswer || `SOCKS5 127.0.0.1:${PORT}`;
    },
    setPermissionRequestHandler: () => {
      state.log.push("session:setPermissionRequestHandler");
    },
    setPermissionCheckHandler: () => {
      state.log.push("session:setPermissionCheckHandler");
    },
    on: (event: string) => {
      state.log.push(`session:on:${event}`);
    },
  };
  state.defaultSession = defaultSession;

  class BrowserWindow {
    static fromWebContents(): null {
      return null;
    }
  }
  const dialogCall = (): void => {
    state.dialogCalls += 1;
  };
  return {
    app: emitter,
    BrowserWindow,
    dialog: {
      showErrorBox: dialogCall,
      showMessageBox: dialogCall,
      showMessageBoxSync: dialogCall,
    },
    safeStorage: {},
    shell: { openExternal: async () => undefined },
    session: {
      get defaultSession() {
        state.log.push("defaultSession:get");
        return defaultSession;
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => {
        state.log.push("protocol.registerSchemesAsPrivileged");
      },
      handle: () => {
        state.log.push("protocol.handle");
      },
    },
  };
});

vi.mock("./rendererContainmentListener.js", () => ({
  startBlackholeListener: async (options: { onClosed?: () => void }) => {
    state.log.push("listener:start");
    await Promise.resolve();
    if (state.mode.failListen) throw new Error("EADDRINUSE");
    state.onClosed = options.onClosed;
    state.log.push("listener:listening");
    return { port: PORT };
  },
}));

vi.mock("./backend.js", () =>
  h.deepModule({
    getBackend: () => null,
    initBackend: () => {
      state.log.push("initBackend");
      return {};
    },
  }),
);
vi.mock("./userData.js", () =>
  h.deepModule({ configureAppUserData: () => "/tmp/grimodex-order-test" }),
);
vi.mock("./shellCommands.js", () =>
  h.deepModule({ resolveAppVersion: () => "0.0.0-test" }),
);
vi.mock("./windows.js", () =>
  h.deepModule({
    createMainWindow: () => {
      state.log.push("createMainWindow");
      // 最初の webContents の作成（BrowserWindow の構築中に app が event を出す）を模す。
      const mode = state.mode.contents;
      let policy = "default";
      const contents = {
        id: 1,
        session:
          mode === "foreign-session" ? { foreign: true } : state.defaultSession,
        on: () => undefined,
        once: () => undefined,
        setWindowOpenHandler: () => undefined,
        setWebRTCIPHandlingPolicy: (value: string) => {
          if (mode === "policy-throws") throw new Error("boom");
          state.log.push(`contents:setWebRTCIPHandlingPolicy:${value}`);
          policy = value;
        },
        getWebRTCIPHandlingPolicy: () =>
          mode === "policy-mismatch" ? "default" : policy,
        stop: () => state.log.push("contents:stop"),
        close: () => state.log.push("contents:close"),
      };
      state.app.emit("web-contents-created", {}, contents);
      state.log.push("web-contents-created:handler-returned");
      return {
        isDestroyed: () => false,
        once: () => undefined,
        webContents: contents,
      };
    },
    getWindow: () => null,
    setWindowTitleLock: () => undefined,
  }),
);

// それ以外の index.ts の依存は、この試験が見ない配線なので deep stub にする。
for (const id of [
  "./cliAi.js",
  "./codexAppServer/manager.js",
  "./codexAppServer/persistedSettings.js",
  "./codexAppServer/threadBindingStore.js",
  "./credentialMigration.js",
  "./events.js",
  "./externalMount.js",
  "./imeShutdown.js",
  "./ipc.js",
  "./keyStore.js",
  "./licenseValidation.js",
  "./narrativeFreshness.js",
  "./narrativeMaintenanceBootstrap.js",
  "./narrativeMaintenanceShutdown.js",
  "./linuxGraphics.js",
  "./mozkeyInstaller.js",
  "./mcpSidecar.js",
  "./profileDataGuardDefault.js",
  "./updater.js",
  "./vivliostyle.js",
  "./profileEgress.js",
  "./webEditorHandoffProtocol.js",
  "./productJourneyAi.js",
  "./narrativeMaintenanceCiSeam.js",
]) {
  vi.doMock(id, () => h.deepModule());
}
// `webEditorHandoffProtocol` は argv を読むので null を返す。
vi.doMock("./webEditorHandoffProtocol.js", () =>
  h.deepModule({ parseWebEditorHandoffProtocolRequest: () => null }),
);
vi.doMock("./narrativeMaintenanceCiSeam.js", () =>
  h.deepModule({
    shouldFailFastNarrativeMaintenanceCiLaunch: () => false,
    shouldDisableNarrativeFreshnessForLaunch: () => false,
    createNarrativeMaintenanceCiHeldFreshnessWriter: () => null,
  }),
);

const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 起動順序の不変条件。違反すると throw する。 */
function assertStartupOrder(entries: readonly string[]): void {
  const at = (label: string, from = 0): number => {
    const index = entries.indexOf(label, from);
    expect(index, `記録に ${label} がある`).toBeGreaterThanOrEqual(0);
    return index;
  };
  const lastIndexOfPrefix = (prefix: string): number => {
    let found = -1;
    entries.forEach((entry, index) => {
      if (entry.startsWith(prefix)) found = index;
    });
    expect(found, `記録に ${prefix}* がある`).toBeGreaterThanOrEqual(0);
    return found;
  };
  const ready = at("app-ready");
  // (i) host-resolver-rules の appendSwitch は ready の前。
  expect(at("appendSwitch:host-resolver-rules")).toBeLessThan(ready);
  // (ii) policy の handler（security の handler と NC-1 の handler の 2 本）は ready の前に登録済みで、
  //      最初の webContents に policy が当たる。
  const handlerRegistrations = entries
    .map((entry, index) =>
      entry === "app.on:web-contents-created" ? index : -1,
    )
    .filter((index) => index >= 0);
  expect(handlerRegistrations.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...handlerRegistrations)).toBeLessThan(ready);
  const window = at("createMainWindow");
  expect(
    at("contents:setWebRTCIPHandlingPolicy:disable_non_proxied_udp"),
  ).toBeGreaterThan(window);
  // (iii) setProxy と closeAllConnections の完了は最初の窓の前。
  const setProxyEnd = at("setProxy:end");
  const closeEnd = at("closeAllConnections:end");
  expect(at("setProxy:begin")).toBeLessThan(setProxyEnd);
  expect(setProxyEnd).toBeLessThan(at("closeAllConnections:begin"));
  expect(closeEnd).toBeLessThan(window);
  // (iv) NC-1 の完了（自己確認まで）は initBackend の最初の呼出しより前。
  const selfCheckEnd = lastIndexOfPrefix("resolveProxy:");
  expect(closeEnd).toBeLessThan(
    at("resolveHost:grimodex-rule-sentinel.invalid"),
  );
  expect(selfCheckEnd).toBeLessThan(at("initBackend"));
  expect(at("initBackend")).toBeLessThan(window);
  // (v) default session の接触の最初が NC-1 の setProxy。
  const contactLabels = new Set(["defaultSession:get", "protocol.handle"]);
  const firstContact = entries.findIndex((entry) => contactLabels.has(entry));
  expect(entries[firstContact]).toBe("defaultSession:get");
  expect(entries[firstContact + 1]).toBe("setProxy:begin");
  // 既存の 3 つはその後（この 3 つの順は現状のまま）。
  const permission = at("session:setPermissionRequestHandler");
  const download = at("session:on:will-download");
  const protocolHandle = at("protocol.handle");
  expect(permission).toBeGreaterThan(selfCheckEnd);
  expect(download).toBeGreaterThan(permission);
  expect(protocolHandle).toBeGreaterThan(download);
  // 窓は最後。
  expect(window).toBeGreaterThan(protocolHandle);
}

/** 1 回の起動の前に、module と fake の状態を初期化する（fake の app は run をまたいで同じ emitter）。 */
function resetRun(mode: ReturnType<typeof h.defaultMode>): void {
  vi.resetModules();
  state.app?.removeAllListeners();
  state.log = [];
  state.dialogCalls = 0;
  state.onClosed = undefined;
  state.mode = mode;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Run {
  entries: string[];
  errorCalls: unknown[][];
}

async function runIndex(
  modeOver: Partial<ReturnType<typeof h.defaultMode>> = {},
  options: {
    rendererUrl?: string;
    sourceTransform?: (source: string) => string;
    fake?: boolean;
  } = {},
): Promise<Run> {
  resetRun({ ...h.defaultMode(), ...modeOver });
  if (options.rendererUrl === undefined) {
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
  } else {
    vi.stubEnv("ELECTRON_RENDERER_URL", options.rendererUrl);
  }
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let tmpDir: string | undefined;
  try {
    if (options.sourceTransform) {
      // 書き換えた index.ts の写し。相対 import は元の絶対 path に直して同じ mock に当てる。
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "nc1-order-"));
      const original = readFileSync(path.join(MAIN_DIR, "index.ts"), "utf8");
      const transformed = options.sourceTransform(original);
      expect(transformed, "書き換えで source が変わる").not.toBe(original);
      const absolute = transformed.replace(
        /(from |import\()"\.\/([^"]+)"/g,
        (_m, head: string, rel: string) =>
          `${head}"${path.join(MAIN_DIR, rel)}"`,
      );
      const copy = path.join(tmpDir, "index.mutated.ts");
      writeFileSync(copy, absolute);
      await import(/* @vite-ignore */ copy);
    } else {
      await import("./index.js");
    }
    state.log.push("app-ready");
    state.resolveReady();
    await settle();
    return { entries: [...state.log], errorCalls: [...errorSpy.mock.calls] };
  } finally {
    errorSpy.mockRestore();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("index.ts の起動順序（packaged。正の対照）", () => {
  it("(i)〜(v) を満たし、全段完了で窓が作られる。失敗の出力も終了もない", async () => {
    const run = await runIndex();
    assertStartupOrder(run.entries);
    expect(run.entries).not.toContain("app.quit");
    expect(run.entries).not.toContain("app.exit");
    expect(run.errorCalls).toEqual([]);
    expect(state.dialogCalls).toBe(0);
    // 自己確認の入力。
    expect(
      run.entries.filter((entry) => entry.startsWith("resolveHost:")),
    ).toEqual([
      "resolveHost:grimodex-rule-sentinel.invalid",
      "resolveHost:1.1.1.1",
      "resolveHost:127.0.0.2",
    ]);
  });

  it("packaged は ELECTRON_RENDERER_URL があっても NC-1 を適用する", async () => {
    const run = await runIndex(
      { isPackaged: true },
      { rendererUrl: "http://127.0.0.1:5173" },
    );
    assertStartupOrder(run.entries);
  });
});

describe("MD-1: dev server を読む非 packaged の起動は NC-1 の全段を適用しない", () => {
  it("非 packaged で ELECTRON_RENDERER_URL あり: appendSwitch も policy の handler も setProxy もない", async () => {
    const run = await runIndex(
      { isPackaged: false },
      { rendererUrl: "http://127.0.0.1:5173" },
    );
    expect(run.entries).not.toContain("appendSwitch:host-resolver-rules");
    expect(run.entries).not.toContain("listener:start");
    expect(run.entries).not.toContain("setProxy:begin");
    // security の handler の 1 本だけ（NC-1 の handler は登録されない）。
    expect(
      run.entries.filter((entry) => entry === "app.on:web-contents-created"),
    ).toHaveLength(1);
    expect(run.entries).not.toContain(
      "contents:setWebRTCIPHandlingPolicy:disable_non_proxied_udp",
    );
    // dev の起動は従来どおり窓まで進む。
    expect(run.entries).toContain("createMainWindow");
    expect(run.entries).not.toContain("protocol.handle");
  });

  it("非 packaged で env なし: NC-1 を適用する（app://bundle を読む）", async () => {
    const run = await runIndex({ isPackaged: false });
    assertStartupOrder(run.entries);
  });
});

describe("起動前の失敗は窓を作らず、initBackend も呼ばず、app.quit() する", () => {
  const cases: ReadonlyArray<{
    code: string;
    mode: Partial<ReturnType<typeof h.defaultMode>>;
  }> = [
    { code: "NC-LISTEN", mode: { failListen: true } },
    { code: "NC-PROXY", mode: { setProxy: "reject" } },
    { code: "NC-CLOSE", mode: { closeAll: "reject" } },
    { code: "NC-SELF-RESOLVE", mode: { literalResolves: true } },
    { code: "NC-SELF-PROXY", mode: { proxyAnswer: "DIRECT" } },
  ];

  for (const { code, mode } of cases) {
    it(code, async () => {
      const run = await runIndex(mode);
      expect(run.entries).not.toContain("createMainWindow");
      expect(run.entries).not.toContain("initBackend");
      expect(run.entries).not.toContain("protocol.handle");
      expect(run.entries).not.toContain("session:setPermissionRequestHandler");
      expect(run.entries.filter((e) => e === "app.quit")).toHaveLength(1);
      expect(run.entries).not.toContain("app.exit");
      expect(run.errorCalls).toHaveLength(1);
      const line = String(run.errorCalls[0][0]);
      expect(line).toContain(code);
      expect(line).toContain("原稿は変更されていません");
      expect(line).not.toMatch(/[\r\n]/);
      expect(state.dialogCalls).toBe(0);
    });
  }

  it("NC-TIMEOUT: setProxy が返らないと 5 秒で終了し、窓も initBackend もない", async () => {
    resetRun({ ...h.defaultMode(), setProxy: "hang" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("./index.js");
      vi.useFakeTimers();
      state.log.push("app-ready");
      state.resolveReady();
      await vi.advanceTimersByTimeAsync(4999);
      expect(state.log).not.toContain("app.quit");
      await vi.advanceTimersByTimeAsync(1);
      expect(state.log.filter((e) => e === "app.quit")).toHaveLength(1);
      expect(state.log).not.toContain("createMainWindow");
      expect(state.log).not.toContain("initBackend");
      expect(state.log).not.toContain("protocol.handle");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain("NC-TIMEOUT");
      expect(state.dialogCalls).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("実行中の失敗は何も読み込ませず破棄し、既存の終了の経路（app.quit）に入る", () => {
  for (const [code, contents] of [
    ["NC-POLICY", "policy-throws"],
    ["NC-POLICY", "policy-mismatch"],
    ["NC-SESSION", "foreign-session"],
  ] as const) {
    it(`${code}（${contents}）`, async () => {
      const run = await runIndex({ contents });
      expect(run.entries).toContain("contents:stop");
      expect(run.entries).toContain("contents:close");
      expect(run.entries.filter((e) => e === "app.quit")).toHaveLength(1);
      // 実 Electron では handler の同期の中の stop／app.quit が SIGSEGV する（DR-NC1-18）。
      // 破棄と終了は handler が返った後（外の tick）で、破棄が終了より先。
      const returned = run.entries.indexOf(
        "web-contents-created:handler-returned",
      );
      expect(returned).toBeGreaterThanOrEqual(0);
      expect(run.entries.indexOf("contents:stop")).toBeGreaterThan(returned);
      expect(run.entries.indexOf("contents:close")).toBeGreaterThan(returned);
      expect(run.entries.indexOf("app.quit")).toBeGreaterThan(
        run.entries.indexOf("contents:close"),
      );
      expect(run.entries).not.toContain("app.exit");
      expect(run.errorCalls).toHaveLength(1);
      expect(String(run.errorCalls[0][0])).toBe(`[grimodex-electron] ${code}`);
      expect(state.dialogCalls).toBe(0);
    });
  }

  it("NC-LISTENER-LOST: 起動後 before-quit の前に listener が閉じると 1 回だけ出す。before-quit の後は出さない", async () => {
    const lost = await runIndex();
    state.onClosed?.();
    state.onClosed?.();
    await settle();
    expect(lost.entries).not.toContain("app.quit");
    expect(state.log.filter((e) => e === "app.quit")).toHaveLength(1);

    const normal = await runIndex();
    expect(normal.entries).not.toContain("app.quit");
    state.app.emit("before-quit", {});
    state.onClosed?.();
    await settle();
    expect(state.log).not.toContain("app.quit");
  });
});

describe("対照: 順序を動かすとこの試験が赤になる", () => {
  it("記録の並べ替え: 窓・initBackend・既存の接触・appendSwitch・policy の脱落を検出する", async () => {
    const run = await runIndex();
    assertStartupOrder(run.entries);
    const moveBefore = (label: string, anchor: string): string[] => {
      const entries = run.entries.filter((e) => e !== label);
      entries.splice(entries.indexOf(anchor), 0, label);
      return entries;
    };
    expect(() =>
      assertStartupOrder(moveBefore("createMainWindow", "setProxy:begin")),
    ).toThrow();
    expect(() =>
      assertStartupOrder(
        moveBefore("initBackend", "closeAllConnections:begin"),
      ),
    ).toThrow();
    expect(() =>
      assertStartupOrder(moveBefore("protocol.handle", "defaultSession:get")),
    ).toThrow();
    expect(() =>
      assertStartupOrder(
        moveBefore("session:setPermissionRequestHandler", "setProxy:begin"),
      ),
    ).toThrow();
    expect(() =>
      assertStartupOrder(
        moveBefore("app-ready", "appendSwitch:host-resolver-rules"),
      ),
    ).toThrow();
    expect(() =>
      assertStartupOrder(
        run.entries.filter((e) => !e.startsWith("contents:setWebRTC")),
      ),
    ).toThrow();
  });

  const START =
    "if (rendererContainment && !(await rendererContainment.start())) return;";
  const mutations: ReadonlyArray<{
    name: string;
    transform: (source: string) => string;
  }> = [
    {
      name: "applySessionPermissionPolicy() を NC-1 の前へ動かす",
      transform: (s) =>
        s.replace(START, `applySessionPermissionPolicy();\n    ${START}`),
    },
    {
      name: "installProductDownloadGuard() を NC-1 の前へ動かす",
      transform: (s) =>
        s.replace(START, `installProductDownloadGuard();\n    ${START}`),
    },
    {
      name: "registerAppProtocolHandler() を NC-1 の前へ動かす",
      transform: (s) =>
        s.replace(START, `registerAppProtocolHandler("/x");\n    ${START}`),
    },
    {
      name: "initBackend を NC-1 の前へ動かす",
      transform: (s) =>
        s.replace(START, `initBackend({ failFast: false });\n    ${START}`),
    },
    {
      name: "最初の窓の作成を NC-1 の前へ動かす",
      transform: (s) => s.replace(START, `createMainWindow();\n    ${START}`),
    },
    {
      name: "appendSwitch を ready の後へ動かす",
      transform: (s) =>
        s
          .replace("rendererContainment?.appendResolverSwitch();\n", "")
          .replace(
            START,
            `rendererContainment?.appendResolverSwitch();\n    ${START}`,
          ),
    },
    {
      name: "policy の handler の登録を外す",
      transform: (s) =>
        s.replace("  rendererContainment?.registerWebContentsPolicy();\n", ""),
    },
  ];

  for (const mutation of mutations) {
    it(`index.ts の書き換え: ${mutation.name}`, async () => {
      expect(readFileSync(path.join(MAIN_DIR, "index.ts"), "utf8")).toContain(
        START,
      );
      const run = await runIndex({}, { sourceTransform: mutation.transform });
      // 書き換えた写しが実際に最後まで起動している（import の失敗で偽の赤にならない）。
      expect(run.entries).toContain("createMainWindow");
      expect(run.entries).toContain("setProxy:end");
      expect(() => assertStartupOrder(run.entries)).toThrow();
    });
  }
});
