import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import { dispatchInvoke, SHELL_COMMAND_NAMES } from "../shared/ipcContract.js";
import {
  MODEL_CAPABILITY_SNAPSHOT_COMMAND,
  parseModelCapabilitySnapshotView,
} from "../shared/modelCapabilitySnapshotWire.js";
import type { ProfileEgressStatusView } from "../shared/profileEgressStatusWire.js";
import type { FetchLike } from "./modelCapabilityFetch.js";
import {
  MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE,
  createModelCapabilityRuntime,
  resolveBundledSnapshotPath,
} from "./modelCapabilityRuntime.js";
import { MODEL_CAPABILITY_CACHE_FILE } from "./modelCapabilityStore.js";
import {
  MODEL_INFO_AUTO_UPDATE_KEY,
  MODEL_INFO_SETTING_FILE,
} from "./modelInfoSetting.js";
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

const bundledModels = makeModels(12);
const bundledText = snapshotText(bundledModels, BUNDLED_GENERATED_AT);
const newerText = snapshotText(
  { ...bundledModels, ...makeModels(2, "openai", 100) },
  NEWER_GENERATED_AT,
);

let temp: ReturnType<typeof makeTempDir>;

class FakeProfile {
  state: ProfileEgressStatusView["state"] = "unrestricted";
  listeners = new Set<(view: ProfileEgressStatusView) => void>();
  statusView(): ProfileEgressStatusView {
    return { state: this.state } as ProfileEgressStatusView;
  }
  onStatusChange(listener: (view: ProfileEgressStatusView) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(state: "unrestricted" | "activating" | "restricted"): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener({ state });
  }
}

function build(
  options: {
    bundled?: string | null;
    profile?: FakeProfile;
    backend?: NapiBackendLike | null;
    fetchImpl?: FetchLike;
    isPackaged?: boolean;
    userDataDir?: string;
  } = {},
) {
  const profile = options.profile ?? new FakeProfile();
  const bundledPath =
    options.bundled === null
      ? path.join(temp.dir, "missing.json")
      : writeBundled(temp.dir, options.bundled ?? bundledText);
  const fetchImpl =
    options.fetchImpl ?? vi.fn<FetchLike>(async () => makeResponse(newerText));
  const runtime = createModelCapabilityRuntime({
    isPackaged: options.isPackaged ?? true,
    userDataDir: options.userDataDir ?? temp.dir,
    bundledPath,
    backend: options.backend ?? null,
    profile,
    fetchImpl,
    now: () => TEST_NOW,
    log: () => undefined,
  });
  return { runtime, profile, fetchImpl };
}

beforeEach(() => {
  temp = makeTempDir();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
});

describe("bundled の path（dev と packaged）", () => {
  it("packaged は resources/model-capabilities/ に置く（extraResources）", () => {
    expect(
      resolveBundledSnapshotPath({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
      }),
    ).toBe(
      path.join(
        "/opt/Grimodex/resources",
        "resources",
        "model-capabilities",
        "model-capabilities.json",
      ),
    );
  });

  it("dev は repo の electron/resources/（main の bundle は <repo>/dist-electron）", () => {
    expect(
      resolveBundledSnapshotPath({
        isPackaged: false,
        resourcesPath: "/ignored",
        mainDir: "/repo/dist-electron",
      }),
    ).toBe(
      path.join("/repo", "electron", "resources", "model-capabilities.json"),
    );
  });
});

describe("読み取り専用の typed IPC", () => {
  it("cache が無ければ同梱の写しを返す。renderer の契約の形を満たす", async () => {
    const { runtime } = build();
    const view = runtime.readAdoptedSnapshot();
    expect(view.origin).toBe("bundled");
    expect(view.source).toBe("grimodex");
    expect(view.generatedAt).toBe(BUNDLED_GENERATED_AT);
    expect(Object.keys(view.models)).toHaveLength(12);
    // IPC を通った後の値（JSON の往復）が契約の検証を通る。
    const wire = JSON.parse(JSON.stringify(view)) as unknown;
    expect(parseModelCapabilitySnapshotView(wire)).toEqual(view);
  });

  it("検証を通った採用済みの cache があれば cache を返す", async () => {
    const { runtime } = build();
    // 取得して採用する。
    runtime.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const view = runtime.readAdoptedSnapshot();
    expect(view.origin).toBe("cache");
    expect(view.generatedAt).toBe(NEWER_GENERATED_AT);
    expect(Object.keys(view.models)).toHaveLength(14);
    await runtime.dispose();
  });

  it("dispatchInvoke から呼べて、{ ok: true, value } を返す。引数を与えると拒否する", async () => {
    const { runtime } = build();
    expect(SHELL_COMMAND_NAMES).toContain(MODEL_CAPABILITY_SNAPSHOT_COMMAND);
    const ok = await dispatchInvoke(
      MODEL_CAPABILITY_SNAPSHOT_COMMAND,
      {},
      { backend: null, shell: runtime.handlers },
    );
    expect(ok.ok).toBe(true);
    const withArgs = await dispatchInvoke(
      MODEL_CAPABILITY_SNAPSHOT_COMMAND,
      { url: "https://evil.example/x.json" },
      { backend: null, shell: runtime.handlers },
    );
    expect(withArgs.ok).toBe(false);
    if (!withArgs.ok)
      expect(withArgs.error).toContain("does not take arguments");
  });

  it("同梱も cache も使えなければ、固定の error で reject する（renderer は自前の表へ落ちる）", async () => {
    const { runtime } = build({ bundled: null });
    expect(() => runtime.readAdoptedSnapshot()).toThrow(
      MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE,
    );
    const result = await dispatchInvoke(
      MODEL_CAPABILITY_SNAPSHOT_COMMAND,
      {},
      { backend: null, shell: runtime.handlers },
    );
    expect(result.ok).toBe(false);
  });

  it("restricted でも cache の読出しは可（Q2）。取得は止まる", async () => {
    const profile = new FakeProfile();
    const { runtime, fetchImpl } = build({ profile });
    runtime.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.readAdoptedSnapshot().origin).toBe("cache");
    profile.emit("restricted");
    expect(runtime.readAdoptedSnapshot().origin).toBe("cache");
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("設定を無効にすると cache を削除し、IPC は同梱だけを返す（Q4）", async () => {
    const { runtime } = build({
      backend: {
        getAiSettings: async () => "{}",
        saveAiSettings: async () => undefined,
      } as unknown as NapiBackendLike,
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const cachePath = path.join(temp.dir, MODEL_CAPABILITY_CACHE_FILE);
    expect(existsSync(cachePath)).toBe(true);
    await runtime.backend!.saveAiSettings!({
      [MODEL_INFO_AUTO_UPDATE_KEY]: false,
    });
    expect(existsSync(cachePath)).toBe(false);
    expect(runtime.readAdoptedSnapshot().origin).toBe("bundled");
    expect(vi.getTimerCount()).toBe(0);
    // 無効の設定は file に残る。
    expect(existsSync(path.join(temp.dir, MODEL_INFO_SETTING_FILE))).toBe(true);
  });
});

describe("unpackaged（開発・CI・journey・評価の harness）では取得しない", () => {
  const DAY = 86_400_000;

  it("start しても fetch は 1 回も呼ばれず、timer も張らない", async () => {
    const { runtime, fetchImpl } = build({ isPackaged: false });
    runtime.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * DAY);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("設定の切替・profile の通知が来ても、取得は始まらない", async () => {
    const profile = new FakeProfile();
    const { runtime, fetchImpl } = build({
      isPackaged: false,
      profile,
      backend: {
        getAiSettings: async () => "{}",
        saveAiSettings: async () => undefined,
      } as unknown as NapiBackendLike,
    });
    runtime.start();
    await runtime.backend!.saveAiSettings!({
      [MODEL_INFO_AUTO_UPDATE_KEY]: false,
    });
    await runtime.backend!.saveAiSettings!({
      [MODEL_INFO_AUTO_UPDATE_KEY]: true,
    });
    profile.emit("activating");
    profile.emit("unrestricted");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * DAY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("IPC は同梱の写しを返し、cache があればその読みは可", async () => {
    // packaged の runtime が取得して採用した cache を、unpackaged の runtime が読む。
    const packaged = build();
    packaged.runtime.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await packaged.runtime.dispose();
    expect(existsSync(path.join(temp.dir, MODEL_CAPABILITY_CACHE_FILE))).toBe(
      true,
    );
    const { runtime, fetchImpl } = build({ isPackaged: false });
    runtime.start();
    expect(runtime.readAdoptedSnapshot().origin).toBe("cache");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cache が無ければ同梱を返す", () => {
    const { runtime } = build({ isPackaged: false });
    runtime.start();
    expect(runtime.readAdoptedSnapshot().origin).toBe("bundled");
  });

  it("packaged の判定を上書きする入口は無い（env・設定・IPC のどれにも読ませない）", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./modelCapabilityRuntime.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env|getBoolean|isPackaged\s*\?\?/u);
    const index = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    expect(index).toMatch(/isPackaged:\s*app\.isPackaged,\s*\n\s*userDataDir/u);
  });
});

describe("profile の通知（onStatusChange）", () => {
  it("activating で走行中の取得を閉じ、unrestricted に戻ったら 30 秒後に再開する", async () => {
    const profile = new FakeProfile();
    let signal: AbortSignal | null = null;
    const fetchImpl = vi.fn<FetchLike>((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => undefined);
    });
    const { runtime } = build({ profile, fetchImpl });
    runtime.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    profile.emit("activating");
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(86_400_000 * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    profile.emit("unrestricted");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it("restricted で起動したときは start しても取得を始めない", async () => {
    const profile = new FakeProfile();
    profile.state = "restricted";
    const { runtime, fetchImpl } = build({ profile });
    runtime.start();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("listener は throw しない（activation を fail closed にしない）", () => {
    const profile = new FakeProfile();
    const { runtime } = build({ profile });
    runtime.start();
    expect(() => profile.emit("activating")).not.toThrow();
    expect(() => profile.emit("restricted")).not.toThrow();
  });
});

describe("終了", () => {
  it("dispose は reject せず、timer を残さない（fatal exit の判断に混ぜない）", async () => {
    const { runtime } = build();
    runtime.start();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("実際の同梱ファイルが無い環境でも、読むまで main は落ちない", () => {
    expect(() => build({ bundled: null })).not.toThrow();
    // 書かれていない path を指しても、start は投げない。
    const { runtime } = build({ bundled: null });
    expect(() => runtime.start()).not.toThrow();
    writeFileSync(path.join(temp.dir, "unused"), "", "utf8");
  });
});
