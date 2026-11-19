import { describe, expect, it, vi } from "vitest";
import { sendWhenFresh } from "./sendWhenFresh";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sendWhenFresh", () => {
  it("有効なら context を渡して実行する", async () => {
    const run = vi.fn();
    sendWhenFresh(Promise.resolve("ctx"), () => true, run);
    await flush();
    expect(run).toHaveBeenCalledWith("ctx");
  });

  it("待っている間に無効になったら送らない", async () => {
    const run = vi.fn();
    let fresh = true;
    sendWhenFresh(Promise.resolve("ctx"), () => fresh, run);
    fresh = false;
    await flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("context の作成が reject しても未処理の rejection にしない", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const run = vi.fn();
    sendWhenFresh(Promise.reject(new Error("db down")), () => true, run);
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(run).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("run が投げても未処理の rejection にしない", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    sendWhenFresh(
      Promise.resolve("ctx"),
      () => true,
      () => {
        throw new Error("generate failed");
      },
    );
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
