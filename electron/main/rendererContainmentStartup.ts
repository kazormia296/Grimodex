/**
 * NC-1 の統合（K3/3 `nir1-d2a-activation-proposal/3`。NC-1 の lane、S2）。
 *
 * renderer の外向き通信（WebRTC の接続と名前解決）を Main の network 層で塞ぐ機構を、
 * 起動の順序（MD-1。起動手順 (0)〜(4)）と失敗時の扱い（FC-1）に結ぶ。電子の
 * network 設定の API 名（`setProxy`、`resolveProxy`、`host-resolver-rules`、
 * `setWebRTC*`）はこの file だけに置く（`rendererIsolation.static.test.ts` の許可表が
 * 1 エントリで済む）。設定値と組立ては `rendererContainment.ts`（electron に依存しない）、
 * blackhole の listener は `rendererContainmentListener.ts`（`node:net` だけ）。
 *
 * - 起動手順 (0) `appendResolverSwitch()`: app が ready になる前に `host-resolver-rules`
 *   を 1 回だけ当てる。`buildHostResolverRules()` は引数なし（`prefixRules` は試験だけ）。
 * - 起動手順 (1) `registerWebContentsPolicy()`: 最初の webContents より前に
 *   `web-contents-created` の handler を登録する。全 webContents に policy を当て、
 *   読み戻す。例外・不一致は `NC-POLICY`、default session でないと `NC-SESSION`。
 * - 起動手順 (2)〜(4) `start()`: listener → `setProxy`（default session の最初の接触）
 *   → `closeAllConnections` → 自己確認 (a)〜(c) を、起動手順 (2) の開始から 5 秒の
 *   1 つの期限で包む。timer は 1 本で、各 `await` を個別に打ち切る機構は持たない。
 *   超過後に返った結果は捨てる。再試行はしない。
 * - 起動前の失敗（窓がない）と共有の期限の超過: 固定コードを `console.error` に 1 行出し、
 *   `app.quit()` する。OS の表示 API は呼ばない。窓を作らない（呼出し側が `false` で止める）。
 * - 実行中の失敗: 閉じ込めの外の webContents は何も読み込ませず破棄し、既存の graceful な
 *   終了の経路（`app.quit()`）に入る。新しい時間の上限も `app.exit` も足さない。
 *   `web-contents-created` の handler の中では判定だけを行い、破棄（`stop`／`close`）と
 *   固定コードの出力・`app.quit()` は handler の外の tick（`deps.defer`）で行う。同期の
 *   中で呼ぶと実 Electron 43.5.0（Linux）が SIGSEGV し、graceful な終了に入れない（DR-NC1-18）。
 *
 * 閉じ込めを止める入口（env、起動引数、設定、IPC）を置かない。`deps` は試験が依存を
 * 差し込むための引数で、製品の呼出し（`index.ts`）は引数なし。
 */
import { app, session } from "electron";

import {
  NC_STARTUP_DEADLINE_MS,
  RESOLVER_SENTINEL_HOST,
  SELF_CHECK_NAME_NOT_RESOLVED,
  SELF_CHECK_UNRESOLVABLE_LITERALS,
  SELF_CHECK_URLS_FOR_PROXY,
  LOOPBACK_ADDRESS,
  WEBRTC_IP_HANDLING_POLICY,
  buildHostResolverRules,
  buildProxyConfig,
  expectedBlackholeProxyString,
  formatRuntimeFailureLine,
  formatStartupFailureLine,
} from "./rendererContainment.js";
import type {
  NcRuntimeFailureCode,
  NcStartupFailureCode,
  RendererContainmentProxyConfig,
} from "./rendererContainment.js";
import { startBlackholeListener } from "./rendererContainmentListener.js";
import type { BlackholeListenerOptions } from "./rendererContainmentListener.js";

/** orchestrator が使う webContents の面（electron の型に依存しない構造的な型）。 */
export interface ContainmentWebContents {
  readonly session: unknown;
  setWebRTCIPHandlingPolicy(policy: typeof WEBRTC_IP_HANDLING_POLICY): void;
  getWebRTCIPHandlingPolicy(): string;
  stop(): void;
  close(options: { waitForBeforeUnload: boolean }): void;
}

/** orchestrator が使う default session の面。 */
export interface ContainmentSession {
  setProxy(config: RendererContainmentProxyConfig): Promise<void>;
  closeAllConnections(): Promise<void>;
  resolveHost(host: string): Promise<{
    endpoints: ReadonlyArray<{ address: string }>;
  }>;
  resolveProxy(url: string): Promise<string>;
}

/**
 * 試験が差し込む依存。既定は electron の実物。`app.exit` を持たない（実行中の失敗は
 * 既存の graceful な終了の経路に入るだけで、独自の終了を作らない）。
 */
export interface RendererContainmentDeps {
  appendSwitch(name: string, value: string): void;
  onWebContentsCreated(
    listener: (contents: ContainmentWebContents) => void,
  ): void;
  onBeforeQuit(listener: () => void): void;
  quit(): void;
  /**
   * `web-contents-created` の handler の外の tick へ処理を回す（既定は `setImmediate`）。
   * 実 Electron 43.5.0（Linux）では、この handler の同期の中で `webContents.stop()` や
   * `app.quit()` を呼ぶと SIGSEGV する（`close()` の後でも同じ）ため、破棄と終了は
   * handler の外の tick で行う（DR-NC1-18）。
   */
  defer(callback: () => void): void;
  getDefaultSession(): ContainmentSession;
  startListener(
    options: BlackholeListenerOptions,
  ): Promise<{ readonly port: number }>;
  reportFailure(line: string): void;
}

export interface RendererContainment {
  /** 起動手順 (0)。app が ready になる前に 1 回。 */
  appendResolverSwitch(): void;
  /** 起動手順 (1)。最初の webContents が作られる前に 1 回。 */
  registerWebContentsPolicy(): void;
  /** 起動手順 (2)〜(4)。true のときだけ起動を続ける。false は失敗（窓を作らない）。 */
  start(): Promise<boolean>;
}

function defaultDeps(): RendererContainmentDeps {
  return {
    appendSwitch: (name, value) => {
      app.commandLine.appendSwitch(name, value);
    },
    onWebContentsCreated: (listener) => {
      app.on("web-contents-created", (_event, contents) => {
        listener(contents);
      });
    },
    onBeforeQuit: (listener) => {
      app.on("before-quit", listener);
    },
    quit: () => {
      app.quit();
    },
    defer: (callback) => {
      setImmediate(callback);
    },
    getDefaultSession: () => session.defaultSession,
    startListener: (options) => startBlackholeListener(options),
    reportFailure: (line) => {
      console.error(line);
    },
  };
}

class StartupFailure extends Error {
  constructor(readonly code: NcStartupFailureCode) {
    super(code);
  }
}

function isNameNotResolved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(SELF_CHECK_NAME_NOT_RESOLVED);
}

/** 自己確認 (a)〜(c)。窓の作成前。食い違いは `StartupFailure`。 */
async function runSelfCheck(
  defaultSession: ContainmentSession,
  listenerPort: number,
  isStale: () => boolean,
): Promise<void> {
  // (a) sentinel の resolveHost が 127.0.0.1（規則が届いている）。
  try {
    const resolved = await defaultSession.resolveHost(RESOLVER_SENTINEL_HOST);
    const addresses = resolved.endpoints.map((endpoint) => endpoint.address);
    if (addresses.length !== 1 || addresses[0] !== LOOPBACK_ADDRESS) {
      throw new StartupFailure("NC-SELF-RESOLVE");
    }
  } catch {
    throw new StartupFailure("NC-SELF-RESOLVE");
  }
  if (isStale()) return;
  // (b) EXCLUDE していない IP literal が ERR_NAME_NOT_RESOLVED（規則が部分的にしか
  // 効いていない状態は (a)(c) だけでは検出できない）。
  for (const literal of SELF_CHECK_UNRESOLVABLE_LITERALS) {
    let resolvedUnexpectedly = false;
    try {
      await defaultSession.resolveHost(literal);
      resolvedUnexpectedly = true;
    } catch (error) {
      if (!isNameNotResolved(error)) {
        throw new StartupFailure("NC-SELF-RESOLVE");
      }
    }
    if (resolvedUnexpectedly) throw new StartupFailure("NC-SELF-RESOLVE");
    if (isStale()) return;
  }
  // (c) 固定の 3 URL が blackhole の proxy（SOCKS5 127.0.0.1:<port>）へ向く。
  const expected = expectedBlackholeProxyString(listenerPort);
  for (const url of SELF_CHECK_URLS_FOR_PROXY) {
    let actual: string;
    try {
      actual = await defaultSession.resolveProxy(url);
    } catch {
      throw new StartupFailure("NC-SELF-PROXY");
    }
    if (actual !== expected) throw new StartupFailure("NC-SELF-PROXY");
    if (isStale()) return;
  }
}

/**
 * 閉じ込めの外の webContents に何も読み込ませず破棄する（best effort。各段の失敗は無視する）。
 * `web-contents-created` の handler の外の tick で呼ぶこと（同期の中の `stop()` は実機で
 * SIGSEGV する。遅らせた `stop()` と `close({ waitForBeforeUnload: false })` は落ちず、
 * 破棄された webContents の `loadURL` は `ERR_FAILED` になる）。
 */
function discardWebContents(contents: ContainmentWebContents): void {
  const steps: Array<() => void> = [
    () => contents.stop(),
    () => contents.close({ waitForBeforeUnload: false }),
  ];
  for (const step of steps) {
    try {
      step();
    } catch {
      // 破棄済みなど。続けて次の段を試す。
    }
  }
}

/**
 * NC-1 の orchestrator を作る。状態（終了に入ったか、`before-quit` を見たか、各入口の
 * 呼出し済み）はこの instance が持つ。製品は `index.ts` で 1 つだけ作る。
 */
export function createRendererContainment(
  deps: RendererContainmentDeps = defaultDeps(),
): RendererContainment {
  let enteredTermination = false;
  let quitting = false;
  let switchApplied = false;
  let handlersRegistered = false;
  let started = false;
  const handled = new WeakSet<object>();

  function terminate(line: string, deferred: boolean): void {
    // 最初の失敗だけが終了に入る（二重の終了も二重の出力も起こさない）。印は同期に立てる
    // （遅らせた終了が実行されるまでの間に起動が続かないようにする）。
    if (enteredTermination) return;
    enteredTermination = true;
    const run = (): void => {
      try {
        deps.reportFailure(line);
      } finally {
        deps.quit();
      }
    };
    if (deferred) deps.defer(run);
    else run();
  }

  function failStartup(code: NcStartupFailureCode): void {
    // 起動前の失敗は promise の継続から呼ばれる（web-contents-created の handler の外）。
    terminate(formatStartupFailureLine(code), false);
  }

  function failRuntime(code: NcRuntimeFailureCode): void {
    // 実行中の失敗は web-contents-created の handler からも呼ばれるので、出力と
    // `app.quit()` は handler の外の tick へ回す。
    terminate(formatRuntimeFailureLine(code), true);
  }

  /** handler の中では判定だけを行い、破棄は handler の外の tick へ回す。 */
  function discardLater(contents: ContainmentWebContents): void {
    deps.defer(() => discardWebContents(contents));
  }

  function applyPolicyTo(contents: ContainmentWebContents): void {
    if (handled.has(contents)) return;
    handled.add(contents);

    let isDefaultSession: boolean;
    try {
      isDefaultSession = contents.session === deps.getDefaultSession();
    } catch {
      isDefaultSession = false;
    }
    if (!isDefaultSession) {
      discardLater(contents);
      failRuntime("NC-SESSION");
      return;
    }

    let policyApplied: boolean;
    try {
      contents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
      policyApplied =
        contents.getWebRTCIPHandlingPolicy() === WEBRTC_IP_HANDLING_POLICY;
    } catch {
      policyApplied = false;
    }
    if (!policyApplied) {
      discardLater(contents);
      failRuntime("NC-POLICY");
    }
  }

  async function runStartupSteps(isStale: () => boolean): Promise<void> {
    // (2) listener。default session に触れない。
    let listenerPort: number;
    try {
      const listener = await deps.startListener({
        onClosed: () => {
          // 終了の開始（before-quit）より前に閉じたときだけ消失として数える。再 bind はしない。
          // `server.close()` が呼ばれたときだけ起こる（accept 不能の検知ではない。DR-NC1-19）。
          // 終了が取り消された後も `quitting` は戻さない（DR-NC1-19）。
          if (!quitting) failRuntime("NC-LISTENER-LOST");
        },
      });
      listenerPort = listener.port;
    } catch {
      throw new StartupFailure("NC-LISTEN");
    }
    if (isStale()) return;

    // (3) setProxy は default session の最初の接触。
    let defaultSession: ContainmentSession;
    try {
      defaultSession = deps.getDefaultSession();
      await defaultSession.setProxy(buildProxyConfig(listenerPort));
    } catch {
      throw new StartupFailure("NC-PROXY");
    }
    if (isStale()) return;
    try {
      await defaultSession.closeAllConnections();
    } catch {
      throw new StartupFailure("NC-CLOSE");
    }
    if (isStale()) return;

    // (4) 自己確認。
    await runSelfCheck(defaultSession, listenerPort, isStale);
  }

  return {
    appendResolverSwitch() {
      if (switchApplied) throw new Error("host-resolver-rules already applied");
      switchApplied = true;
      deps.appendSwitch("host-resolver-rules", buildHostResolverRules());
    },

    registerWebContentsPolicy() {
      if (handlersRegistered) {
        throw new Error("web-contents policy handler already registered");
      }
      handlersRegistered = true;
      deps.onBeforeQuit(() => {
        quitting = true;
      });
      deps.onWebContentsCreated(applyPolicyTo);
    },

    start() {
      if (started) throw new Error("renderer containment already started");
      started = true;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (code: NcStartupFailureCode | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (code !== null) failStartup(code);
          // 終了に入っている（listener の消失など）ときは起動を続けない。
          resolve(code === null && !enteredTermination);
        };
        // 起動手順 (2) の開始から 5 秒の 1 つの期限（timer は 1 本）。
        const deadline = setTimeout(
          () => finish("NC-TIMEOUT"),
          NC_STARTUP_DEADLINE_MS,
        );
        runStartupSteps(() => settled).then(
          () => finish(null),
          (error: unknown) =>
            // StartupFailure 以外は各段の変換をすり抜けた想定外の例外。固定コード 9 個に
            // 新しいコードは足せないので、最初の network 設定の段の NC-PROXY を既定にする（DR-NC1-20）。
            finish(error instanceof StartupFailure ? error.code : "NC-PROXY"),
        );
      });
    },
  };
}
