import { describe, it, expect } from "vitest";
import {
  trackSceneContentWrite,
  awaitPendingSceneContentWrite,
  serializeSceneWrite,
  awaitAllPendingSceneWrites,
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

  it("チェーンに並んだ未ディスパッチの write も待つ (writeChains バリア)", async () => {
    const d1 = deferred();
    const order: string[] = [];
    // 先行 write は in-flight、後続 write はチェーン待ち (UPDATE 未ディスパッチ
    // なので pendingWrites には載らない)。
    void serializeSceneWrite("s6", () => d1.promise);
    void serializeSceneWrite("s6", async () => {
      order.push("write2");
    });

    let readDone = false;
    const reader = awaitPendingSceneContentWrite("s6").then(() => {
      order.push("read");
      readDone = true;
    });
    await flushTasks();
    expect(readDone).toBe(false);

    d1.resolve();
    await reader;
    // reader は後続 write の完了後に解決する (追い越さない)
    expect(order).toEqual(["write2", "read"]);
  });
});

describe("serializeSceneWrite", () => {
  it("同一シーンの write は発行順に直列実行される (遅い A を速い B が追い越さない)", async () => {
    const order: string[] = [];
    const dA = deferred();

    // write A: 人工的に遅延させる (conn 待ちの autosave 相当)
    const a = serializeSceneWrite("w1", async () => {
      order.push("A:start");
      await dA.promise;
      order.push("A:end");
    });
    // write B: 即時完了する flush 相当。A が未完了の間は開始しない。
    const b = serializeSceneWrite("w1", async () => {
      order.push("B:run");
    });

    await flushTasks();
    expect(order).toEqual(["A:start"]);

    dA.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["A:start", "A:end", "B:run"]);
  });

  it("先行 write の失敗は後続 write をブロックしない (後続は実行される)", async () => {
    const a = serializeSceneWrite("w2", async () => {
      throw new Error("write A failed");
    });
    const b = serializeSceneWrite("w2", async () => "ok");

    await expect(a).rejects.toThrow("write A failed");
    await expect(b).resolves.toBe("ok");
  });

  it("別シーンはチェーンを共有しない (並行実行できる)", async () => {
    const dA = deferred();
    const a = serializeSceneWrite("w3", () => dA.promise);

    let bRan = false;
    await serializeSceneWrite("w4", async () => {
      bRan = true;
    });
    expect(bRan).toBe(true);

    dA.resolve();
    await a;
  });

  it("チェーンが空のときは write を同期ディスパッチする (read バリアの前提)", () => {
    let startedSynchronously = false;
    void serializeSceneWrite("w5", () => {
      startedSynchronously = true;
      return Promise.resolve();
    });
    expect(startedSynchronously).toBe(true);
  });
});

describe("awaitAllPendingSceneWrites", () => {
  it("pending が無ければ即座に解決する", async () => {
    await expect(awaitAllPendingSceneWrites()).resolves.toBeUndefined();
  });

  it("全シーンの pending write が完了するまで待つ", async () => {
    const d1 = deferred();
    const d2 = deferred();
    void serializeSceneWrite("q1", () => d1.promise);
    trackSceneContentWrite("q2", d2.promise);

    let done = false;
    const waiter = awaitAllPendingSceneWrites().then(() => {
      done = true;
    });

    await flushTasks();
    expect(done).toBe(false);

    d1.resolve();
    await flushTasks();
    expect(done).toBe(false);

    d2.resolve();
    await waiter;
    expect(done).toBe(true);
  });

  it("失敗した write があっても解決する", async () => {
    const d = deferred();
    const chained = serializeSceneWrite("q3", () => d.promise);
    chained.catch(() => {}); // unhandled rejection 抑止

    const waiter = awaitAllPendingSceneWrites();
    d.reject(new Error("ipc failed"));

    await expect(waiter).resolves.toBeUndefined();
  });
});
