import { describe, expect, it, vi } from "vitest";
import { sendWhenFresh } from "./sendWhenFresh";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 状態（rev）を持つ最小の fake。rev が変わると古くなる。 */
function setup(opts: { canRebuild?: (rev: number) => boolean } = {}) {
  const state = { rev: 0 };
  const build = vi.fn(async (snapshot: number) => `ctx@${snapshot}`);
  const run = vi.fn();
  const start = () =>
    sendWhenFresh({
      capture: () => state.rev,
      build,
      isFresh: (snapshot) => state.rev === snapshot,
      canRebuild: opts.canRebuild,
      run,
    });
  return { state, build, run, start };
}

describe("sendWhenFresh", () => {
  it("有効なら context を作った時点の snapshot とともに 1 回だけ実行する", async () => {
    const { build, run, start } = setup();
    start();
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("ctx@0", 0);
  });

  it("待っている間に古くなったら、今の状態で 1 回だけ作り直して送る", async () => {
    const { state, build, run, start } = setup();
    start();
    state.rev = 1; // build の await の間に選択・文書が変わった
    await flush();
    expect(build).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("ctx@1", 1);
  });

  it("作り直しの間にも古くなったら送らず、debug に残す", async () => {
    const { state, run, build, start } = setup();
    build.mockImplementation(async (snapshot: number) => {
      state.rev += 1; // 作る間に毎回変わる
      return `ctx@${snapshot}`;
    });
    start();
    await flush();
    expect(build).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("作り直しても意味がない変化（別の文書へ移った等）は作り直さず送らない", async () => {
    const { state, build, run, start } = setup({ canRebuild: () => false });
    start();
    state.rev = 1;
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("context の作成が reject しても未処理の rejection にしない", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const run = vi.fn();
    sendWhenFresh({
      capture: () => 0,
      build: () => Promise.reject(new Error("db down")),
      isFresh: () => true,
      run,
    });
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(run).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("run が投げても未処理の rejection にしない", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    sendWhenFresh({
      capture: () => 0,
      build: async () => "ctx",
      isFresh: () => true,
      run: () => {
        throw new Error("generate failed");
      },
    });
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
