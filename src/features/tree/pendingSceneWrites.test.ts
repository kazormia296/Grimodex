import { describe, it, expect } from "vitest";
import {
  trackSceneContentWrite,
  awaitPendingSceneContentWrite,
} from "./pendingSceneWrites";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マクロタスク 1 周分。pending 中の continuation を全部流す。 */
function flushTasks() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

describe("pendingSceneWrites", () => {
  it("pending が無ければ即座に解決する", async () => {
    await expect(
      awaitPendingSceneContentWrite("no-writes"),
    ).resolves.toBeUndefined();
  });

  it("in-flight の write が解決するまで待つ", async () => {
    const d = deferred();
    trackSceneContentWrite("s1", d.promise);

    let done = false;
    const waiter = awaitPendingSceneContentWrite("s1").then(() => {
      done = true;
    });

    await flushTasks();
    expect(done).toBe(false);

    d.resolve();
    await waiter;
    expect(done).toBe(true);
  });

  it("待機中に track された後続 write も待つ", async () => {
    const d1 = deferred();
    const d2 = deferred();
    trackSceneContentWrite("s2", d1.promise);

    let done = false;
    const waiter = awaitPendingSceneContentWrite("s2").then(() => {
      done = true;
    });

    trackSceneContentWrite("s2", d2.promise);
    d1.resolve();
    await flushTasks();
    expect(done).toBe(false);

    d2.resolve();
    await waiter;
    expect(done).toBe(true);
  });

  it("write の失敗は reader をブロックも reject もしない", async () => {
    const d = deferred();
    trackSceneContentWrite("s3", d.promise);

    const waiter = awaitPendingSceneContentWrite("s3");
    d.reject(new Error("ipc failed"));

    await expect(waiter).resolves.toBeUndefined();
  });

  it("解決済み entry は自己クリアされ、次の reader は即解決する", async () => {
    const d = deferred();
    trackSceneContentWrite("s4", d.promise);
    d.resolve();
    await flushTasks();

    // entry が残っていたら while ループに入り deferred 永久待ちになる
    await expect(awaitPendingSceneContentWrite("s4")).resolves.toBeUndefined();
  });

  it("scene ごとに独立して追跡される", async () => {
    const d = deferred();
    trackSceneContentWrite("s5", d.promise);

    // 別シーンの reader はブロックされない
    await expect(
      awaitPendingSceneContentWrite("other"),
    ).resolves.toBeUndefined();

    d.resolve();
  });
});
