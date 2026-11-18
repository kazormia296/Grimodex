import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MODEL_CAPABILITY_FETCH_URL } from "./modelCapabilityFetch.js";
import type { FetchLike } from "./modelCapabilityFetch.js";
import {
  MODEL_CAPABILITY_SCHEDULE,
  createModelCapabilityScheduler,
  type ModelCapabilityScheduler,
} from "./modelCapabilityScheduler.js";
import {
  MODEL_CAPABILITY_CACHE_FILE,
  createModelCapabilityStore,
  type ModelCapabilityStore,
} from "./modelCapabilityStore.js";
import {
  BUNDLED_GENERATED_AT,
  NEWER_GENERATED_AT,
  TEST_NOW,
  makeModels,
  makeResponse,
  makeTempDir,
  snapshotText,
  writeBundled,
} from "./modelCapability.testSupport.js";

const MARKER = "SECRET_BODY_MARKER_9d2e";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const bundledModels = makeModels(12);
const bundledText = snapshotText(bundledModels, BUNDLED_GENERATED_AT);
/** 同梱に 2 件足した、新しい日時の写し。 */
const newerText = snapshotText(
  { ...bundledModels, ...makeModels(2, "openai", 100) },
  NEWER_GENERATED_AT,
);
const newestText = snapshotText(
  { ...bundledModels, ...makeModels(3, "openai", 200) },
  "2026-11-20T00:00:00Z",
);

interface Harness {
  scheduler: ModelCapabilityScheduler;
  store: ModelCapabilityStore;
  fetchImpl: ReturnType<typeof vi.fn<FetchLike>>;
  state: { enabled: boolean; profileOpen: boolean };
  logs: string[];
  dir: string;
  cachePath: string;
}

let temp: ReturnType<typeof makeTempDir>;

function build(
  options: {
    enabled?: boolean;
    profileOpen?: boolean;
    storeWrap?: (store: ModelCapabilityStore) => ModelCapabilityStore;
    schedule?: Partial<typeof MODEL_CAPABILITY_SCHEDULE>;
  } = {},
): Harness {
  const realStore = createModelCapabilityStore({
    cacheDir: temp.dir,
    bundledPath: writeBundled(temp.dir, bundledText),
  });
  const store = options.storeWrap ? options.storeWrap(realStore) : realStore;
  const state = {
    enabled: options.enabled ?? true,
    profileOpen: options.profileOpen ?? true,
  };
  const logs: string[] = [];
  const fetchImpl = vi.fn<FetchLike>(async () => makeResponse(newerText));
  const scheduler = createModelCapabilityScheduler({
    fetchImpl,
    store,
    now: () => TEST_NOW,
    isEnabled: () => state.enabled,
    isProfileOpen: () => state.profileOpen,
    schedule: options.schedule,
    log: (message) => logs.push(message),
  });
  return {
    scheduler,
    store: realStore,
    fetchImpl,
    state,
    logs,
    dir: temp.dir,
    cachePath: path.join(temp.dir, MODEL_CAPABILITY_CACHE_FILE),
  };
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

beforeEach(() => {
  temp = makeTempDir();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  temp.cleanup();
});

describe("単発と周期（A1・A2）", () => {
  it("start の 30 秒後に 1 回取得して cache に採用する。それまでは通信しない", async () => {
    const h = build();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(h.cachePath)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(h.cachePath)).toBe(true);
    const read = h.store.readCache(TEST_NOW);
    expect(read.ok).toBe(true);
    expect(leftovers(h.dir)).toEqual([]);
    expect(h.logs.some((line) => line.startsWith("adopted models=14"))).toBe(
      true,
    );
  });

  it("次の取得は、前の取得の完了から 24 時間後（取得中の時間は数えない）", async () => {
    const h = build();
    let delay = 0;
    h.fetchImpl.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return makeResponse(newerText);
    });
    delay = 5_000;
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000 + 5_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    // 完了は 35 秒。24 時間後は 35 秒 + 24 時間。
    h.fetchImpl.mockImplementation(async () => makeResponse(newestText));
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    // 新しい写しに更新される。
    const read = h.store.readCache(TEST_NOW);
    expect(read.ok && read.snapshot.generatedAt).toBe("2026-11-20T00:00:00Z");
  });

  it("失敗しても、完了から 24 時間後にもう一度取得する（古い値を残す）", async () => {
    const h = build();
    h.fetchImpl.mockImplementation(async () =>
      makeResponse("x", { status: 404 }),
    );
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(h.cachePath)).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("起動時の timer と周期の timer は、取得 1 回につき 1 つだけ（重ならない）", async () => {
    const h = build();
    h.scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("single-flight", () => {
  it("走行中の runCycle は同じ promise を返し、fetch は 1 回だけ", async () => {
    const h = build();
    let release: (response: Response) => void = () => undefined;
    h.fetchImpl.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    h.scheduler.start();
    const first = h.scheduler.runCycle();
    const second = h.scheduler.runCycle();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    release(makeResponse(newerText));
    await first;
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.store.readCache(TEST_NOW).ok).toBe(true);
  });

  it("start を重ねても timer は増えない", () => {
    const h = build();
    h.scheduler.start();
    h.scheduler.start();
    h.scheduler.onSettingChanged();
    h.scheduler.onProfileChanged();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("start の前の runCycle は何もしない", async () => {
    const h = build();
    await h.scheduler.runCycle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("再試行（A3）", () => {
  it("一時的な失敗は回数と間隔に上限を持って再試行し、成功したら採用する", async () => {
    const h = build();
    h.fetchImpl
      .mockImplementationOnce(async () => {
        throw new Error("offline");
      })
      .mockImplementationOnce(async () => makeResponse("x", { status: 503 }))
      .mockImplementation(async () => makeResponse(newerText));
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    // 2 回目と 3 回目の間は 120 秒。
    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.store.readCache(TEST_NOW).ok).toBe(true);
  });

  it("失敗が続いても 1 周期に maxAttempts 回まで。その後は次の周期まで取得しない", async () => {
    const h = build();
    h.fetchImpl.mockImplementation(async () => {
      throw new Error(MARKER);
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000 + 30_000 + 120_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(
      MODEL_CAPABILITY_SCHEDULE.maxAttempts,
    );
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(
      MODEL_CAPABILITY_SCHEDULE.maxAttempts,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(
      MODEL_CAPABILITY_SCHEDULE.maxAttempts + 1,
    );
  });

  it("内容・場所の誤り（404・redirect・host の不一致）は再試行しない", async () => {
    for (const make of [
      () => makeResponse("x", { status: 404 }),
      () => makeResponse("x", { status: 302 }),
      () => makeResponse(newerText, { url: "https://evil.example/x.json" }),
    ]) {
      const h = build();
      h.fetchImpl.mockImplementation(async () => make());
      h.scheduler.start();
      await vi.advanceTimersByTimeAsync(30_000 + 30_000 + 120_000);
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
      expect(existsSync(h.cachePath)).toBe(false);
      await h.scheduler.dispose();
    }
  });

  it("再試行の待ちの間に設定を無効にすると、再試行は打ち切られる", async () => {
    const h = build();
    h.fetchImpl.mockImplementation(async () => {
      throw new Error("offline");
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.state.enabled = false;
    h.scheduler.onSettingChanged();
    await vi.advanceTimersByTimeAsync(DAY * 2);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("restricted・unavailable・activating の profile（Q2・A8）", () => {
  it("profile が閉じている間は start しても取得しない。開いたら 30 秒後に始める", async () => {
    const h = build({ profileOpen: false });
    h.scheduler.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY * 3);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h.state.profileOpen = true;
    h.scheduler.onProfileChanged();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("走行中の取得は profile の閉鎖で abort し、遅れて届いた結果は採用しない", async () => {
    const h = build();
    let signal: AbortSignal | null = null;
    let release: (response: Response) => void = () => undefined;
    h.fetchImpl.mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal).not.toBeNull();
    expect((signal as unknown as AbortSignal).aborted).toBe(false);
    h.state.profileOpen = false;
    h.scheduler.onProfileChanged();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    release(makeResponse(newerText));
    await vi.advanceTimersByTimeAsync(10);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.logs.some((line) => line.startsWith("adopted"))).toBe(false);
  });

  it("本文を読んでいる途中の閉鎖でも、cache は書かれない", async () => {
    const h = build();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    h.fetchImpl.mockImplementation(async () =>
      makeResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            controller.enqueue(
              new TextEncoder().encode(newerText.slice(0, 20)),
            );
          },
        }),
      ),
    );
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    h.state.profileOpen = false;
    h.scheduler.onProfileChanged();
    (
      controllerRef as unknown as ReadableStreamDefaultController<Uint8Array> | null
    )?.enqueue(new TextEncoder().encode(newerText.slice(20)));
    await vi.advanceTimersByTimeAsync(10);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it("listener からの onProfileChanged は例外を投げず、file 操作もしない（cache は残る）", async () => {
    const h = build();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(existsSync(h.cachePath)).toBe(true);
    const purge = vi.spyOn(h.store, "purgeCache");
    h.state.profileOpen = false;
    expect(() => h.scheduler.onProfileChanged()).not.toThrow();
    expect(purge).not.toHaveBeenCalled();
    expect(existsSync(h.cachePath)).toBe(true);
  });

  it("isProfileOpen が投げても onProfileChanged は投げない", () => {
    const h = build();
    h.scheduler.start();
    const throwing = createModelCapabilityScheduler({
      fetchImpl: h.fetchImpl,
      store: h.store,
      now: () => TEST_NOW,
      isEnabled: () => true,
      isProfileOpen: () => {
        throw new Error("boom");
      },
    });
    expect(() => throwing.onProfileChanged()).not.toThrow();
  });
});

describe("設定の無効化（Q4・A6）", () => {
  it("無効にすると走行中の取得を止め、cache を削除し、timer を全部解除する", async () => {
    const h = build();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(existsSync(h.cachePath)).toBe(true);
    // 次の周期の取得が走行中のときに無効にする。
    let signal: AbortSignal | null = null;
    h.fetchImpl.mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => undefined);
    });
    await vi.advanceTimersByTimeAsync(DAY);
    expect(signal).not.toBeNull();
    h.state.enabled = false;
    h.scheduler.onSettingChanged();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(existsSync(h.cachePath)).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY * 3);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("起動時に無効で cache が残っていれば削除する。取得はしない", async () => {
    const seed = build();
    seed.store.writeCache(newerText, TEST_NOW, () => true);
    await seed.scheduler.dispose();
    expect(existsSync(seed.cachePath)).toBe(true);
    const h = build({ enabled: false });
    h.scheduler.start();
    expect(existsSync(h.cachePath)).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY * 2);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("再び有効にすると、初回と同じ 30 秒の遅延から始める", async () => {
    const h = build({ enabled: false });
    h.scheduler.start();
    h.state.enabled = true;
    h.scheduler.onSettingChanged();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("書込みの途中（rename の直前）で無効になっても、cache も tmp も残らない", async () => {
    const h = build({
      storeWrap: (store) => ({
        ...store,
        writeCache(body, fetchedAtMs, guard) {
          // tmp を書いた後、rename の直前の guard の時点で設定が無効になった状況を作る。
          return store.writeCache(body, fetchedAtMs, () => {
            h.state.enabled = false;
            return guard();
          });
        },
      }),
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
    expect(h.logs).toContain("not written: the scheduler was closed");
  });

  it("書込みの途中で profile が閉じても、cache も tmp も残らない", async () => {
    const h = build({
      storeWrap: (store) => ({
        ...store,
        writeCache(body, fetchedAtMs, guard) {
          return store.writeCache(body, fetchedAtMs, () => {
            h.state.profileOpen = false;
            return guard();
          });
        },
      }),
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });
});

describe("世代番号：取消し後の結果の棄却", () => {
  it("閉じて開き直した後に、古い取得が遅れて終わっても採用せず、新しい周期は動く", async () => {
    const h = build();
    let first = true;
    let releaseOld: (response: Response) => void = () => undefined;
    h.fetchImpl.mockImplementation(() => {
      if (first) {
        first = false;
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      }
      return Promise.resolve(makeResponse(newestText));
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.state.profileOpen = false;
    h.scheduler.onProfileChanged();
    h.state.profileOpen = true;
    h.scheduler.onProfileChanged();
    releaseOld(makeResponse(newerText));
    await vi.advanceTimersByTimeAsync(10);
    expect(existsSync(h.cachePath)).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    const read = h.store.readCache(TEST_NOW);
    // 新しい世代の結果（newestText）だけが採用される。
    expect(read.ok && read.snapshot.generatedAt).toBe("2026-11-20T00:00:00Z");
  });
});

describe("終了（A7）", () => {
  it("dispose は走行中の取得を abort して終わり、timer を全部解除する。以後は何もしない", async () => {
    const h = build();
    let signal: AbortSignal | null = null;
    h.fetchImpl.mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => undefined);
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const disposed = h.scheduler.dispose();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(disposed).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    h.state.profileOpen = true;
    h.scheduler.onProfileChanged();
    h.scheduler.onSettingChanged();
    await h.scheduler.runCycle();
    await vi.advanceTimersByTimeAsync(DAY * 3);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(h.cachePath)).toBe(false);
    await expect(h.scheduler.dispose()).resolves.toBeUndefined();
  });

  it("取得が無いときの dispose は即座に終わる", async () => {
    const h = build();
    h.scheduler.start();
    await expect(h.scheduler.dispose()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort が効かなくても、dispose は quitWaitMs（2 秒）で戻り、終了を止めない", async () => {
    const h = build();
    h.fetchImpl.mockImplementation(
      () => new Promise<Response>(() => undefined),
    );
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    // abort が効かない状況（実装の不具合・実行環境の差）を作る。
    vi.spyOn(AbortController.prototype, "abort").mockImplementation(
      () => undefined,
    );
    let settled = false;
    const disposed = h.scheduler.dispose().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(MODEL_CAPABILITY_SCHEDULE.quitWaitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await disposed;
    expect(settled).toBe(true);
  });

  it("dispose の後に届いた結果は書かない", async () => {
    const h = build();
    let release: (response: Response) => void = () => undefined;
    h.fetchImpl.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await h.scheduler.dispose();
    release(makeResponse(newerText));
    await vi.advanceTimersByTimeAsync(10);
    expect(existsSync(h.cachePath)).toBe(false);
  });
});

describe("検証の失敗（T1・T2）：採用しない・古い値を残す", () => {
  async function runOnce(
    h: Harness,
    body: string | Response,
    wait = 30_000,
  ): Promise<void> {
    h.fetchImpl.mockImplementation(async () =>
      typeof body === "string" ? makeResponse(body) : body,
    );
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(wait);
  }

  it.each([
    ["壊れた JSON", "{not json", /invalid syntax/],
    ["途中で切れた JSON", newerText.slice(0, 200), /invalid syntax/],
    ["空の models", snapshotText({}, NEWER_GENERATED_AT), /invalid empty/],
    [
      "知らない schemaVersion",
      snapshotText(makeModels(12), NEWER_GENERATED_AT, { schemaVersion: 2 }),
      /invalid unsupported-schema-version/,
    ],
    [
      "未来の generatedAt",
      snapshotText(makeModels(12), "2027-01-01T00:00:00Z"),
      /invalid future-generated-at/,
    ],
    [
      "取得元の刻印が models.dev（T8）",
      snapshotText(
        { ...bundledModels, ...makeModels(2, "openai", 100) },
        NEWER_GENERATED_AT,
        {
          source: "models.dev",
        },
      ),
      /unexpected source/,
    ],
    [
      "同梱より古い（再生）",
      snapshotText(bundledModels, "2026-11-01T00:00:00Z"),
      /rejected against bundled stale/,
    ],
    [
      "同梱に対して急減（12 件→4 件）",
      snapshotText(makeModels(4), NEWER_GENERATED_AT),
      /rejected against bundled shrunk/,
    ],
    [
      "同梱と同じ日時で中身が違う",
      snapshotText(
        { ...bundledModels, ...makeModels(1, "openai", 100) },
        BUNDLED_GENERATED_AT,
      ),
      /rejected against bundled generated-at-conflict/,
    ],
  ])("%s は採用せず、cache を作らない", async (_label, body, pattern) => {
    const h = build();
    await runOnce(h, body);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(h.logs.join("\n")).toMatch(pattern);
    // 検証の失敗は再試行しない（待っても直らない）。
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("同梱に対しては通るが、前回の採用値（cache）に対して急減なら採用せず、cache は変えない", async () => {
    const h = build();
    const big = snapshotText(
      { ...bundledModels, ...makeModels(12, "openai", 300) },
      NEWER_GENERATED_AT,
    );
    h.store.writeCache(big, TEST_NOW, () => true);
    const before = h.store.readCache(TEST_NOW);
    expect(before.ok).toBe(true);
    // 9 件：同梱（12）の 75%、cache（24）の 37.5%。
    const shrunk = snapshotText(makeModels(9), "2026-11-19T06:00:00Z");
    await runOnce(h, shrunk);
    expect(h.logs.join("\n")).toMatch(/rejected against cache shrunk/);
    const after = h.store.readCache(TEST_NOW);
    expect(after.ok && after.digest).toBe(before.ok && before.digest);
  });

  it("cache より古い写しは採用しない", async () => {
    const h = build();
    h.store.writeCache(newestText, TEST_NOW, () => true);
    await runOnce(h, newerText);
    expect(h.logs.join("\n")).toMatch(/rejected against cache stale/);
  });

  it("cache と内容が同じなら書き直さない", async () => {
    const h = build();
    h.store.writeCache(newerText, TEST_NOW, () => true);
    const write = vi.spyOn(h.store, "writeCache");
    await runOnce(h, newerText);
    expect(write).not.toHaveBeenCalled();
    expect(h.logs).toContain("unchanged: same as the adopted cache");
  });

  it("同梱と内容が同じなら cache を作らない", async () => {
    const h = build();
    await runOnce(h, bundledText);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(h.logs).toContain("unchanged: same as the bundled snapshot");
  });

  it("同梱が読めないときは採用しない（比べる基準が無い）", async () => {
    const h = build({
      storeWrap: (store) => ({
        ...store,
        loadBundled: () => ({ ok: false, reason: "unreadable" }),
      }),
    });
    await runOnce(h, newerText);
    expect(existsSync(h.cachePath)).toBe(false);
    expect(h.logs.join("\n")).toMatch(/bundled snapshot unavailable/);
  });

  it("上限を超える本文（content-length・読込み中の両方）は採用しない", async () => {
    const huge = "x".repeat(2_000_000);
    const h1 = build();
    await runOnce(
      h1,
      makeResponse(huge, {
        headers: { "content-length": String(huge.length) },
      }),
    );
    expect(existsSync(h1.cachePath)).toBe(false);
    expect(h1.logs.join("\n")).toMatch(/fetch failed: too-large/);
    await h1.scheduler.dispose();

    const h2 = build();
    await runOnce(h2, makeResponse(huge));
    expect(existsSync(h2.cachePath)).toBe(false);
    expect(h2.logs.join("\n")).toMatch(/fetch failed: too-large/);
  });

  it("timeout した取得は再試行され、cache は作られない", async () => {
    const h = build();
    h.fetchImpl.mockImplementation(
      () => new Promise<Response>(() => undefined),
    );
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000 + 10_000);
    expect(h.logs.join("\n")).toMatch(
      /fetch failed: timeout-connect \(attempt 1\/3\)/,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(existsSync(h.cachePath)).toBe(false);
  });
});

describe("log に本文や key を出さない", () => {
  it("あらゆる失敗・採用の経路の log に、本文・model の key・URL・error の message が出ない", async () => {
    const bodies: Array<string | Response | Error> = [
      `{"broken": "${MARKER}"`,
      // 未知の field に marker。採用はされるが、log に出ない。
      snapshotText(
        {
          ...bundledModels,
          "openai/model-100": {
            contextWindow: 100_000,
            note: MARKER,
          },
        },
        NEWER_GENERATED_AT,
      ),
      // 不正な key（marker を含む）。件数だけが出る。
      snapshotText(
        { ...bundledModels, [`openai/${MARKER}`]: { contextWindow: 1 } },
        "2026-11-19T03:00:00Z",
      ),
      new Error(`secret ${MARKER}`),
      makeResponse(MARKER, { status: 500 }),
      makeResponse(MARKER, { url: `https://evil.example/${MARKER}` }),
      snapshotText(makeModels(2), "2026-11-19T09:00:00Z"),
    ];
    const h = build();
    let index = 0;
    h.fetchImpl.mockImplementation(async () => {
      const next = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return typeof next === "string" ? makeResponse(next) : next;
    });
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(DAY);
    }
    const output = h.logs.join("\n");
    expect(h.logs.length).toBeGreaterThan(3);
    expect(output).not.toContain(MARKER);
    expect(output).not.toMatch(/openai\/model/);
    expect(output).not.toContain("evil.example");
    expect(output).not.toContain(MODEL_CAPABILITY_FETCH_URL);
    expect(output).not.toContain("raw.githubusercontent.com");
  });
});
