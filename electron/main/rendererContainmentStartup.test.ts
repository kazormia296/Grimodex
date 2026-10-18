/**
 * NC-1 の orchestrator の単体試験（K3/3 の Negative (30a) の適用失敗、Positive (9)(ii)）。
 *
 * 起動前の 6 コードと実行中の 3 コードを、依存の注入（試験専用の seam。製品の入口では
 * ない）で 1 つずつ起こし、窓が作られない・固定コードが 1 行・OS の表示 API は呼ばない・
 * `app.quit()` が 1 回・返らない promise は共有の 5 秒で打ち切る、を固定する。
 * `index.ts` の呼出し順は `rendererContainment.startupOrder.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  session: {},
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(),
    showMessageBoxSync: vi.fn(),
  },
}));

const {
  NC_RUNTIME_FAILURE_CODES,
  NC_STARTUP_DEADLINE_MS,
  NC_STARTUP_FAILURE_CODES,
  RESOLVER_SENTINEL_HOST,
  SELF_CHECK_URLS_FOR_PROXY,
  WEBRTC_IP_HANDLING_POLICY,
  buildHostResolverRules,
  formatRuntimeFailureLine,
  formatStartupFailureLine,
} = await import("./rendererContainment.js");
const { createRendererContainment } =
  await import("./rendererContainmentStartup.js");
const { dialog } = await import("electron");

import type {
  ContainmentSession,
  ContainmentWebContents,
  RendererContainmentDeps,
} from "./rendererContainmentStartup.js";

const PORT = 40123;
const NEVER = new Promise<never>(() => undefined);

/** `host-resolver-rules` の最小の評価器（MAP／EXCLUDE の意味だけ。EXCLUDE は MAP に優先）。 */
function resolveByRules(rules: string, host: string): string[] {
  const parsed = rules.split(",").map((rule) => rule.trim().split(/\s+/));
  if (parsed.some(([kind, name]) => kind === "EXCLUDE" && name === host)) {
    // EXCLUDE した名前は実 DNS へ進む。試験は 127.0.0.1 の literal だけを実際に解決させる。
    if (host === "127.0.0.1") return ["127.0.0.1"];
    return ["203.0.113.7"];
  }
  for (const [kind, name, target] of parsed) {
    if (kind !== "MAP") continue;
    if (name === host) return [target];
    if (name === "*") {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    }
  }
  return ["203.0.113.7"];
}

interface Harness {
  deps: RendererContainmentDeps;
  session: ContainmentSession & {
    setProxy: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
    resolveHost: ReturnType<typeof vi.fn>;
    resolveProxy: ReturnType<typeof vi.fn>;
  };
  appendSwitch: ReturnType<typeof vi.fn>;
  startListener: ReturnType<typeof vi.fn>;
  reportFailure: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  webContentsListeners: Array<(contents: ContainmentWebContents) => void>;
  beforeQuitListeners: Array<() => void>;
  listenerClosed: () => void;
  rules: () => string;
  /** `deps.defer` に積まれた処理（handler の外の tick）。flush するまで実行されない。 */
  deferred: Array<() => void>;
  flush: () => void;
}

function makeHarness(
  over: {
    session?: Partial<ContainmentSession>;
    startListener?: RendererContainmentDeps["startListener"];
    rewriteRules?: (rules: string) => string;
  } = {},
): Harness {
  let appliedRules = "";
  let onClosed: (() => void) | undefined;
  const session = {
    setProxy: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    resolveHost: vi.fn(async (host: string) => ({
      endpoints: resolveByRules(appliedRules, host).map((address) => ({
        address,
      })),
    })),
    resolveProxy: vi.fn(async () => `SOCKS5 127.0.0.1:${PORT}`),
    ...over.session,
  } as Harness["session"];
  const appendSwitch = vi.fn((name: string, value: string) => {
    expect(name).toBe("host-resolver-rules");
    appliedRules = over.rewriteRules ? over.rewriteRules(value) : value;
  });
  const startListener = vi.fn(
    over.startListener ??
      (async (options: { onClosed?: () => void }) => {
        onClosed = options.onClosed;
        return { port: PORT };
      }),
  );
  const reportFailure = vi.fn();
  const quit = vi.fn();
  const webContentsListeners: Harness["webContentsListeners"] = [];
  const beforeQuitListeners: Harness["beforeQuitListeners"] = [];
  const deferred: Array<() => void> = [];
  const deps: RendererContainmentDeps = {
    appendSwitch,
    onWebContentsCreated: (listener) => webContentsListeners.push(listener),
    onBeforeQuit: (listener) => beforeQuitListeners.push(listener),
    quit,
    defer: (callback) => {
      deferred.push(callback);
    },
    getDefaultSession: () => session,
    startListener: startListener as RendererContainmentDeps["startListener"],
    reportFailure,
  };
  return {
    deps,
    session,
    appendSwitch,
    startListener,
    reportFailure,
    quit,
    webContentsListeners,
    beforeQuitListeners,
    listenerClosed: () => onClosed?.(),
    rules: () => appliedRules,
    deferred,
    flush: () => {
      while (deferred.length > 0) deferred.shift()?.();
    },
  };
}

function expectSingleFixedLine(h: Harness, expected: string): void {
  expect(h.reportFailure).toHaveBeenCalledTimes(1);
  const line = h.reportFailure.mock.calls[0][0] as string;
  expect(line).toBe(expected);
  expect(line).not.toMatch(/[\r\n]/);
  expect(h.quit).toHaveBeenCalledTimes(1);
  // OS の表示 API は呼ばない。
  expect(dialog.showErrorBox).not.toHaveBeenCalled();
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
  expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("起動前（窓がない）: 正の対照", () => {
  it("全段が完了すると true で、失敗の出力も終了もない。setProxy の設定と自己確認の入力が固定どおり", async () => {
    const h = makeHarness();
    const containment = createRendererContainment(h.deps);
    containment.appendResolverSwitch();
    containment.registerWebContentsPolicy();
    await expect(containment.start()).resolves.toBe(true);

    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.appendSwitch).toHaveBeenCalledTimes(1);
    expect(h.appendSwitch).toHaveBeenCalledWith(
      "host-resolver-rules",
      buildHostResolverRules(),
    );
    expect(h.startListener).toHaveBeenCalledTimes(1);
    // 製品の呼出しは上界を渡さない（確認済みの上限をそのまま使う）。
    expect(Object.keys(h.startListener.mock.calls[0][0])).toEqual(["onClosed"]);
    expect(h.session.setProxy).toHaveBeenCalledTimes(1);
    expect(h.session.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: `socks5://127.0.0.1:${PORT}`,
      proxyBypassRules: "<-loopback>",
    });
    expect(h.session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(h.session.setProxy.mock.invocationCallOrder[0]).toBeLessThan(
      h.session.closeAllConnections.mock.invocationCallOrder[0],
    );
    expect(h.session.resolveHost.mock.calls.map((c) => c[0])).toEqual([
      RESOLVER_SENTINEL_HOST,
      "1.1.1.1",
      "127.0.0.2",
    ]);
    expect(h.session.resolveProxy.mock.calls.map((c) => c[0])).toEqual([
      ...SELF_CHECK_URLS_FOR_PROXY,
    ]);
    expect(SELF_CHECK_URLS_FOR_PROXY).toEqual([
      "https://turn.attacker.invalid:443/",
      "https://example.invalid:8443/",
      "http://127.0.0.1:1/",
    ]);
  });

  it("全段が完了したあとは期限の timer が残らない（成功で解除）", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const containment = createRendererContainment(h.deps);
    containment.appendResolverSwitch();
    await expect(containment.start()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(NC_STARTUP_DEADLINE_MS * 2);
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });
});

describe("起動前（窓がない）の 6 コード", () => {
  it("固定コードの列挙は draft の FC-1 と 1 対 1", () => {
    expect([...NC_STARTUP_FAILURE_CODES]).toEqual([
      "NC-LISTEN",
      "NC-PROXY",
      "NC-CLOSE",
      "NC-SELF-RESOLVE",
      "NC-SELF-PROXY",
      "NC-TIMEOUT",
    ]);
    expect([...NC_RUNTIME_FAILURE_CODES]).toEqual([
      "NC-POLICY",
      "NC-SESSION",
      "NC-LISTENER-LOST",
    ]);
  });

  async function runFailing(
    h: Harness,
    code: (typeof NC_STARTUP_FAILURE_CODES)[number],
  ): Promise<void> {
    const containment = createRendererContainment(h.deps);
    containment.appendResolverSwitch();
    await expect(containment.start()).resolves.toBe(false);
    expectSingleFixedLine(h, formatStartupFailureLine(code));
    expect(formatStartupFailureLine(code)).toContain(
      "原稿は変更されていません",
    );
    expect(formatStartupFailureLine(code)).toContain(code);
  }

  it("NC-LISTEN: listener の起動が失敗する。以降の段に進まない", async () => {
    const h = makeHarness({
      startListener: async () => {
        throw new Error("EADDRINUSE");
      },
    });
    await runFailing(h, "NC-LISTEN");
    expect(h.session.setProxy).not.toHaveBeenCalled();
    // error の message を出力に含めない。
    expect(h.reportFailure.mock.calls[0][0]).not.toContain("EADDRINUSE");
  });

  it("NC-PROXY: setProxy が失敗する（default session の取得の失敗を含む）", async () => {
    const rejected = makeHarness({
      session: {
        setProxy: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    await runFailing(rejected, "NC-PROXY");
    expect(rejected.session.closeAllConnections).not.toHaveBeenCalled();

    const noSession = makeHarness();
    noSession.deps.getDefaultSession = () => {
      throw new Error("no session");
    };
    await runFailing(noSession, "NC-PROXY");
  });

  it("NC-CLOSE: closeAllConnections が失敗する。自己確認に進まない", async () => {
    const h = makeHarness({
      session: {
        closeAllConnections: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    await runFailing(h, "NC-CLOSE");
    expect(h.session.resolveHost).not.toHaveBeenCalled();
  });

  it("NC-SELF-RESOLVE: sentinel が 127.0.0.1 に解決されない", async () => {
    const h = makeHarness({
      session: {
        resolveHost: vi.fn(async () => ({
          endpoints: [{ address: "203.0.113.7" }],
        })),
      },
    });
    await runFailing(h, "NC-SELF-RESOLVE");
  });

  it("NC-SELF-RESOLVE: sentinel の MAP だけの構成（IP literal が解決される）を検出する", async () => {
    const h = makeHarness({
      rewriteRules: () => `MAP ${RESOLVER_SENTINEL_HOST} 127.0.0.1`,
    });
    await runFailing(h, "NC-SELF-RESOLVE");
    // (a) は通り、(b) の最初の literal で検出される。
    expect(h.session.resolveHost.mock.calls.map((c) => c[0])).toEqual([
      RESOLVER_SENTINEL_HOST,
      "1.1.1.1",
    ]);
    expect(h.session.resolveProxy).not.toHaveBeenCalled();
  });

  it("NC-SELF-RESOLVE: IP literal の失敗が ERR_NAME_NOT_RESOLVED 以外なら検出する", async () => {
    const h = makeHarness({
      session: {
        resolveHost: vi.fn(async (host: string) => {
          if (host === RESOLVER_SENTINEL_HOST) {
            return { endpoints: [{ address: "127.0.0.1" }] };
          }
          throw new Error("net::ERR_INTERNET_DISCONNECTED");
        }),
      },
    });
    await runFailing(h, "NC-SELF-RESOLVE");
  });

  it("NC-SELF-PROXY: resolveProxy が blackhole の proxy を返さない", async () => {
    const direct = makeHarness({
      session: { resolveProxy: vi.fn(async () => "DIRECT") },
    });
    await runFailing(direct, "NC-SELF-PROXY");

    const other = makeHarness({
      session: { resolveProxy: vi.fn(async () => "SOCKS5 127.0.0.1:1") },
    });
    await runFailing(other, "NC-SELF-PROXY");

    const rejects = makeHarness({
      session: {
        resolveProxy: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    await runFailing(rejects, "NC-SELF-PROXY");
  });

  it("最終構成の規則では (a)(b) が通る（評価器の正の対照）", async () => {
    const h = makeHarness();
    createRendererContainment(h.deps).appendResolverSwitch();
    await expect(
      h.session.resolveHost(RESOLVER_SENTINEL_HOST),
    ).resolves.toEqual({ endpoints: [{ address: "127.0.0.1" }] });
    await expect(h.session.resolveHost("1.1.1.1")).rejects.toThrow(
      "ERR_NAME_NOT_RESOLVED",
    );
  });
});

describe("NC-TIMEOUT: 起動前の共有の 5 秒の期限", () => {
  const stages: ReadonlyArray<{
    name: string;
    make: () => Harness;
    reached: (h: Harness) => void;
  }> = [
    {
      name: "listener",
      make: () => makeHarness({ startListener: () => NEVER }),
      reached: (h) => expect(h.session.setProxy).not.toHaveBeenCalled(),
    },
    {
      name: "setProxy",
      make: () => makeHarness({ session: { setProxy: () => NEVER } }),
      reached: (h) =>
        expect(h.session.closeAllConnections).not.toHaveBeenCalled(),
    },
    {
      name: "closeAllConnections",
      make: () =>
        makeHarness({ session: { closeAllConnections: () => NEVER } }),
      reached: (h) => expect(h.session.resolveHost).not.toHaveBeenCalled(),
    },
    {
      name: "自己確認",
      make: () => makeHarness({ session: { resolveHost: () => NEVER } }),
      reached: (h) => expect(h.session.resolveProxy).not.toHaveBeenCalled(),
    },
  ];

  for (const stage of stages) {
    it(`${stage.name} が返らないと、4999 ms は待ち、5000 ms で NC-TIMEOUT・窓なし・quit 1 回`, async () => {
      vi.useFakeTimers();
      const h = stage.make();
      const containment = createRendererContainment(h.deps);
      containment.appendResolverSwitch();
      let result: boolean | undefined;
      void containment.start().then((value) => {
        result = value;
      });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(NC_STARTUP_DEADLINE_MS - 1);
      expect(result).toBeUndefined();
      expect(h.reportFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);
      expectSingleFixedLine(h, formatStartupFailureLine("NC-TIMEOUT"));
      stage.reached(h);
      // さらに時間が進んでも二重の終了は起きない。
      await vi.advanceTimersByTimeAsync(NC_STARTUP_DEADLINE_MS * 10);
      expect(h.reportFailure).toHaveBeenCalledTimes(1);
      expect(h.quit).toHaveBeenCalledTimes(1);
    });
  }

  it("期限を過ぎてから遅れて返しても、後続の段に進まず、窓も二重の終了も起こさない", async () => {
    vi.useFakeTimers();
    let releaseSetProxy: () => void = () => undefined;
    const h = makeHarness({
      session: {
        setProxy: () =>
          new Promise<void>((resolve) => {
            releaseSetProxy = resolve;
          }),
      },
    });
    const containment = createRendererContainment(h.deps);
    containment.appendResolverSwitch();
    let result: boolean | undefined;
    void containment.start().then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(NC_STARTUP_DEADLINE_MS);
    expect(result).toBe(false);
    releaseSetProxy();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.closeAllConnections).not.toHaveBeenCalled();
    expect(h.session.resolveHost).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(h.reportFailure).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it("期限の timer は start の 1 本だけで、各 await に個別の timer を足さない", async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      session: { closeAllConnections: () => NEVER },
    });
    const containment = createRendererContainment(h.deps);
    containment.appendResolverSwitch();
    void containment.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(1);
  });
});

function fakeContents(over: Partial<ContainmentWebContents> = {}): {
  contents: ContainmentWebContents;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  let policy = "default";
  const stop = vi.fn();
  const close = vi.fn();
  const set = vi.fn((value: string) => {
    policy = value;
  });
  const contents = {
    session: undefined as unknown,
    setWebRTCIPHandlingPolicy: set,
    getWebRTCIPHandlingPolicy: () => policy,
    stop,
    close,
    ...over,
  } as ContainmentWebContents;
  return { contents, stop, close, set };
}

describe("実行中の 3 コード", () => {
  function registered(h: Harness) {
    const containment = createRendererContainment(h.deps);
    containment.registerWebContentsPolicy();
    expect(h.webContentsListeners).toHaveLength(1);
    expect(h.beforeQuitListeners).toHaveLength(1);
    return { containment, emit: h.webContentsListeners[0] };
  }

  it("default session の webContents には policy を当て、読み戻しが一致すれば何も起きない。同じ webContents への再入は冪等", () => {
    const h = makeHarness();
    const { emit } = registered(h);
    const { contents, set, close } = fakeContents({ session: h.session });
    emit(contents);
    emit(contents);
    h.flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(WEBRTC_IP_HANDLING_POLICY);
    expect(WEBRTC_IP_HANDLING_POLICY).toBe("disable_non_proxied_udp");
    expect(close).not.toHaveBeenCalled();
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("handler の同期の中では何も破棄せず、出力も quit もしない。handler の外の tick で破棄し、出力し、quit する（実機の SIGSEGV の回避。DR-NC1-18）", () => {
    for (const foreign of [true, false]) {
      const h = makeHarness();
      const { emit } = registered(h);
      const { contents, stop, close } = fakeContents(
        foreign
          ? { session: { other: true } }
          : {
              session: h.session,
              getWebRTCIPHandlingPolicy: () => "default",
            },
      );
      emit(contents);
      // handler の同期の中（emit が返るまで）に stop／close／出力／quit が呼ばれない。
      expect(stop).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(h.reportFailure).not.toHaveBeenCalled();
      expect(h.quit).not.toHaveBeenCalled();
      expect(h.deferred.length).toBeGreaterThan(0);
      h.flush();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      // 破棄が終了より先（破棄された後に終了の経路に入る）。
      expectSingleFixedLine(
        h,
        formatRuntimeFailureLine(foreign ? "NC-SESSION" : "NC-POLICY"),
      );
    }
  });

  it("handler の外の tick までに起動が続かない（失敗の印は同期に立つ）", async () => {
    const h = makeHarness();
    const containment = createRendererContainment(h.deps);
    containment.registerWebContentsPolicy();
    containment.appendResolverSwitch();
    const started = containment.start();
    h.webContentsListeners[0](
      fakeContents({ session: { other: true } }).contents,
    );
    await expect(started).resolves.toBe(false);
    h.flush();
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-SESSION"));
  });

  it("NC-POLICY: 適用が例外を投げる。破棄してコードだけを 1 行出し、quit 1 回", () => {
    const h = makeHarness();
    const { emit } = registered(h);
    const { contents, stop, close } = fakeContents({
      session: h.session,
      setWebRTCIPHandlingPolicy: () => {
        throw new Error("boom");
      },
    });
    emit(contents);
    h.flush();
    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-POLICY"));
    expect(h.reportFailure.mock.calls[0][0]).toBe(
      "[grimodex-electron] NC-POLICY",
    );
  });

  it("NC-POLICY: 読み戻しが disable_non_proxied_udp でない", () => {
    const h = makeHarness();
    const { emit } = registered(h);
    const { contents, close } = fakeContents({
      session: h.session,
      getWebRTCIPHandlingPolicy: () => "default",
    });
    emit(contents);
    h.flush();
    expect(close).toHaveBeenCalled();
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-POLICY"));
  });

  it("NC-SESSION: default session でない webContents は何も読み込ませず破棄する。policy も当てない", () => {
    const h = makeHarness();
    const { emit } = registered(h);
    const { contents, stop, close, set } = fakeContents({
      session: { other: true },
    });
    emit(contents);
    h.flush();
    expect(set).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-SESSION"));
  });

  it("破棄の途中の例外は握りつぶして終了に入る。2 件目の失敗は出力も quit も重ねない（破棄はする）", () => {
    const h = makeHarness();
    const { emit } = registered(h);
    const first = fakeContents({
      session: { other: true },
      stop: () => {
        throw new Error("destroyed");
      },
      close: () => {
        throw new Error("destroyed");
      },
    });
    emit(first.contents);
    const second = fakeContents({ session: { other: true } });
    emit(second.contents);
    h.flush();
    expect(second.close).toHaveBeenCalled();
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-SESSION"));
  });

  it("NC-LISTENER-LOST: before-quit の前に listener が閉じると 1 回だけ数え、再 bind しない", async () => {
    const h = makeHarness();
    const containment = createRendererContainment(h.deps);
    containment.registerWebContentsPolicy();
    containment.appendResolverSwitch();
    await expect(containment.start()).resolves.toBe(true);
    h.listenerClosed();
    h.listenerClosed();
    h.flush();
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-LISTENER-LOST"));
    expect(h.startListener).toHaveBeenCalledTimes(1);
  });

  it("通常の終了（before-quit の後）に listener が閉じても、固定コードも二重の終了も起きない", async () => {
    const h = makeHarness();
    const containment = createRendererContainment(h.deps);
    containment.registerWebContentsPolicy();
    containment.appendResolverSwitch();
    await expect(containment.start()).resolves.toBe(true);
    for (const listener of h.beforeQuitListeners) listener();
    h.listenerClosed();
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("起動中に listener を失ったら、ほかの段が成功しても起動を続けない", async () => {
    const h = makeHarness({
      session: {
        closeAllConnections: vi.fn(async () => {
          h.listenerClosed();
        }),
      },
    });
    const containment = createRendererContainment(h.deps);
    containment.registerWebContentsPolicy();
    containment.appendResolverSwitch();
    await expect(containment.start()).resolves.toBe(false);
    h.flush();
    expectSingleFixedLine(h, formatRuntimeFailureLine("NC-LISTENER-LOST"));
  });

  it("実行中の失敗の終了は app.quit() の 1 回だけで、deps に exit がなく、新しい timer も足さない", () => {
    // この試験が主張する範囲: 独自の終了手段（app.exit）を持たず、quit は 1 回、timer は 0。
    // flush の待ち（close-veto、strict persistence drain、will-quit の finalizer）そのものは
    // この層の外の既存の経路で、windowChrome／close-veto の既存の試験と S3 の実機の観測で示す。
    vi.useFakeTimers();
    const h = makeHarness();
    expect(Object.keys(h.deps)).not.toContain("exit");
    const containment = createRendererContainment(h.deps);
    containment.registerWebContentsPolicy();
    h.webContentsListeners[0](
      fakeContents({ session: { other: true } }).contents,
    );
    h.flush();
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("入口は 1 回だけ", () => {
  it("appendResolverSwitch、registerWebContentsPolicy、start の二度目は拒否する", async () => {
    const h = makeHarness();
    const containment = createRendererContainment(h.deps);
    containment.appendResolverSwitch();
    expect(() => containment.appendResolverSwitch()).toThrow();
    containment.registerWebContentsPolicy();
    expect(() => containment.registerWebContentsPolicy()).toThrow();
    await containment.start();
    expect(() => containment.start()).toThrow();
    expect(h.appendSwitch).toHaveBeenCalledTimes(1);
  });
});
