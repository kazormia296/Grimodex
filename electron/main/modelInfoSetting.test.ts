import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  MODEL_INFO_AUTO_UPDATE_KEY,
  MODEL_INFO_SETTING_FILE,
  createModelInfoSetting,
  wrapBackendForModelInfoSetting,
} from "./modelInfoSetting.js";
import { makeTempDir } from "./modelCapability.testSupport.js";

let temp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => temp.cleanup());

describe("設定の保存", () => {
  it("file が無ければ有効（既定）。読むだけでは file を作らない", () => {
    const setting = createModelInfoSetting(temp.dir);
    expect(setting.get()).toBe(true);
    expect(existsSync(path.join(temp.dir, MODEL_INFO_SETTING_FILE))).toBe(
      false,
    );
  });

  it("無効にすると file に残り、再起動（作り直し）しても無効のまま", () => {
    const first = createModelInfoSetting(temp.dir);
    first.set(false);
    expect(createModelInfoSetting(temp.dir).get()).toBe(false);
    first.set(true);
    expect(createModelInfoSetting(temp.dir).get()).toBe(true);
    expect(readdirSync(temp.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("変わったときだけ listener を呼び、listener の失敗は保存を失敗させない", () => {
    const setting = createModelInfoSetting(temp.dir);
    const listener = vi.fn();
    setting.onChange(() => {
      throw new Error("listener failure");
    });
    setting.onChange(listener);
    setting.set(true);
    expect(listener).not.toHaveBeenCalled();
    expect(() => setting.set(false)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    setting.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("壊れた・読めない file は無効（fail-closed）で、理由を警告する", () => {
    const warn = vi.fn();
    writeFileSync(
      path.join(temp.dir, MODEL_INFO_SETTING_FILE),
      "{broken",
      "utf8",
    );
    expect(createModelInfoSetting(temp.dir, warn).get()).toBe(false);
    writeFileSync(
      path.join(temp.dir, MODEL_INFO_SETTING_FILE),
      JSON.stringify({ schemaVersion: 1, [MODEL_INFO_AUTO_UPDATE_KEY]: "yes" }),
      "utf8",
    );
    expect(createModelInfoSetting(temp.dir, warn).get()).toBe(false);
    writeFileSync(
      path.join(temp.dir, MODEL_INFO_SETTING_FILE),
      JSON.stringify({
        schemaVersion: 1,
        [MODEL_INFO_AUTO_UPDATE_KEY]: true,
        extra: 1,
      }),
      "utf8",
    );
    expect(createModelInfoSetting(temp.dir, warn).get()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("書けないときは投げ、メモリの値も変えず、listener も呼ばない", () => {
    // 作成の後に、userData の場所が file に置き換わった状況（mkdir できない）。
    const blocker = path.join(temp.dir, "blocker");
    const setting = createModelInfoSetting(blocker);
    expect(setting.get()).toBe(true);
    writeFileSync(blocker, "x", "utf8");
    const listener = vi.fn();
    setting.onChange(listener);
    expect(() => setting.set(false)).toThrow();
    expect(setting.get()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

/** Rust の `AiSettings` を真似る：struct に無い key は保存の往復で捨てる。 */
function fakeNativeBackend(initial: Record<string, unknown>) {
  let stored: Record<string, unknown> = { ...initial };
  const known = new Set(["provider", "model", "thinkingEnabled"]);
  const saveAiSettings = vi.fn(async (settings: unknown) => {
    const next = settings as Record<string, unknown>;
    if (next.reject === true) throw new Error("native rejected");
    stored = Object.fromEntries(
      Object.entries(next).filter(([key]) => known.has(key)),
    );
  });
  const backend = {
    getAiSettings: vi.fn(async () => JSON.stringify(stored)),
    saveAiSettings,
    other: vi.fn(function (this: unknown) {
      return this;
    }),
  } as unknown as NapiBackendLike;
  return { backend, saveAiSettings, getStored: () => stored };
}

describe("AiSettings の往復（Rust の struct は未知の key を捨てる）", () => {
  it("無効にした値が save → get の往復と再起動で落ちない。Native には項目を渡さない", async () => {
    const native = fakeNativeBackend({ provider: "openai", model: "m" });
    const setting = createModelInfoSetting(temp.dir);
    const backend = wrapBackendForModelInfoSetting(native.backend, setting)!;

    // 前提：素の backend では、この項目は往復で消える。
    await native.backend.saveAiSettings!({
      provider: "openai",
      model: "m",
      [MODEL_INFO_AUTO_UPDATE_KEY]: false,
    });
    expect(JSON.parse(await native.backend.getAiSettings())).not.toHaveProperty(
      MODEL_INFO_AUTO_UPDATE_KEY,
    );

    await backend.saveAiSettings!({
      provider: "openai",
      model: "m",
      [MODEL_INFO_AUTO_UPDATE_KEY]: false,
    });
    expect(native.saveAiSettings).toHaveBeenLastCalledWith({
      provider: "openai",
      model: "m",
    });
    const read = JSON.parse(await backend.getAiSettings()) as Record<
      string,
      unknown
    >;
    expect(read).toEqual({
      provider: "openai",
      model: "m",
      [MODEL_INFO_AUTO_UPDATE_KEY]: false,
    });
    // 再起動：新しい setting と backend でも無効のまま。
    const restarted = wrapBackendForModelInfoSetting(
      native.backend,
      createModelInfoSetting(temp.dir),
    )!;
    expect(
      (JSON.parse(await restarted.getAiSettings()) as Record<string, unknown>)[
        MODEL_INFO_AUTO_UPDATE_KEY
      ],
    ).toBe(false);
  });

  it("項目が無い save は現在の値を変えない（既定値から作った設定で再有効化されない）", async () => {
    const native = fakeNativeBackend({ provider: "openai" });
    const setting = createModelInfoSetting(temp.dir);
    setting.set(false);
    const backend = wrapBackendForModelInfoSetting(native.backend, setting)!;
    await backend.saveAiSettings!({ provider: "ollama", model: "x" });
    expect(setting.get()).toBe(false);
    const read = JSON.parse(await backend.getAiSettings()) as Record<
      string,
      unknown
    >;
    expect(read[MODEL_INFO_AUTO_UPDATE_KEY]).toBe(false);
  });

  it("boolean でない値は無視する（現在の値を変えない）が、Native へは渡さない", async () => {
    const native = fakeNativeBackend({ provider: "openai" });
    const setting = createModelInfoSetting(temp.dir);
    const backend = wrapBackendForModelInfoSetting(native.backend, setting)!;
    for (const bad of ["false", 0, null, undefined, {}, []]) {
      await backend.saveAiSettings!({
        provider: "x",
        [MODEL_INFO_AUTO_UPDATE_KEY]: bad,
      });
      expect(setting.get()).toBe(true);
      expect(native.saveAiSettings).toHaveBeenLastCalledWith({ provider: "x" });
    }
  });

  it("Native が save を拒否したら、この項目も変えない", async () => {
    const native = fakeNativeBackend({ provider: "openai" });
    const setting = createModelInfoSetting(temp.dir);
    const backend = wrapBackendForModelInfoSetting(native.backend, setting)!;
    await expect(
      backend.saveAiSettings!({
        reject: true,
        [MODEL_INFO_AUTO_UPDATE_KEY]: false,
      }),
    ).rejects.toThrow("native rejected");
    expect(setting.get()).toBe(true);
    expect(existsSync(path.join(temp.dir, MODEL_INFO_SETTING_FILE))).toBe(
      false,
    );
  });

  it("この項目を書けなければ save を失敗させる", async () => {
    const blocker = path.join(temp.dir, "blocker");
    const native = fakeNativeBackend({ provider: "openai" });
    const setting = createModelInfoSetting(blocker);
    writeFileSync(blocker, "x", "utf8");
    const backend = wrapBackendForModelInfoSetting(native.backend, setting)!;
    await expect(
      backend.saveAiSettings!({ [MODEL_INFO_AUTO_UPDATE_KEY]: false }),
    ).rejects.toThrow();
    expect(setting.get()).toBe(true);
  });

  it("他の method はそのまま通り、this も保たれる。backend が null なら null", async () => {
    const native = fakeNativeBackend({});
    const backend = wrapBackendForModelInfoSetting(
      native.backend,
      createModelInfoSetting(temp.dir),
    )! as unknown as { other(): unknown };
    expect(backend.other()).toBe(native.backend);
    expect(
      wrapBackendForModelInfoSetting(null, createModelInfoSetting(temp.dir)),
    ).toBeNull();
  });

  it("JSON でない getAiSettings の結果はそのまま返す", async () => {
    const native = fakeNativeBackend({});
    (
      native.backend.getAiSettings as ReturnType<typeof vi.fn>
    ).mockResolvedValue("not json");
    const backend = wrapBackendForModelInfoSetting(
      native.backend,
      createModelInfoSetting(temp.dir),
    )!;
    await expect(backend.getAiSettings()).resolves.toBe("not json");
  });

  it("file の内容は項目の値だけで、他の設定は含まない", async () => {
    const setting = createModelInfoSetting(temp.dir);
    setting.set(false);
    expect(
      JSON.parse(
        readFileSync(path.join(temp.dir, MODEL_INFO_SETTING_FILE), "utf8"),
      ),
    ).toEqual({ schemaVersion: 1, [MODEL_INFO_AUTO_UPDATE_KEY]: false });
  });
});
