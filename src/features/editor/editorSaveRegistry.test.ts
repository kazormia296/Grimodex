import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerSaveHandler,
  unregisterSaveHandler,
  saveScene,
  registeredSaveHandlerIds,
} from "./editorSaveRegistry";

beforeEach(() => {
  // モジュールシングルトンの Map を空にする (テスト間リーク防止)
  for (const id of registeredSaveHandlerIds()) {
    unregisterSaveHandler(id);
  }
});

describe("editorSaveRegistry", () => {
  it("登録した handler を saveScene が呼ぶ / 未登録は no-op", async () => {
    const fn = vi.fn(async () => {});
    registerSaveHandler("n1", fn);
    await saveScene("n1");
    expect(fn).toHaveBeenCalledTimes(1);
    await saveScene("unknown");
  });

  it("registeredSaveHandlerIds は登録中の全 id を返す", () => {
    registerSaveHandler("n1", async () => {});
    registerSaveHandler("n2", async () => {});
    expect(registeredSaveHandlerIds().sort()).toEqual(["n1", "n2"]);
    unregisterSaveHandler("n1");
    expect(registeredSaveHandlerIds()).toEqual(["n2"]);
  });

  it("fn 指定の unregister は、新インスタンスが先に再登録していたら消さない (remount 競合ガード)", async () => {
    const oldFn = vi.fn(async () => {});
    const newFn = vi.fn(async () => {});
    registerSaveHandler("n1", oldFn);
    // remount: 新インスタンスの register が旧 cleanup より先に走るケース
    registerSaveHandler("n1", newFn);
    unregisterSaveHandler("n1", oldFn);

    await saveScene("n1");
    expect(newFn).toHaveBeenCalledTimes(1);
    expect(oldFn).not.toHaveBeenCalled();

    // 自分自身の fn なら消える
    unregisterSaveHandler("n1", newFn);
    expect(registeredSaveHandlerIds()).toEqual([]);
  });

  it("fn 省略の unregister は無条件で消す (後方互換)", () => {
    registerSaveHandler("n1", async () => {});
    unregisterSaveHandler("n1");
    expect(registeredSaveHandlerIds()).toEqual([]);
  });
});
