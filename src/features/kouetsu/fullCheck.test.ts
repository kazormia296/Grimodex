import { describe, it, expect, beforeEach, vi } from "vitest";

// runners バレルを丸ごとモックし、オーケストレータの直列/順序/失敗継続/中止
// ロジックだけを検証する（実 run・payload 構築・IPC は範囲外）。
vi.mock("@/features/kouetsu/runners", () => ({
  runTypoCheck: vi.fn(),
  runReviewCheck: vi.fn(),
  runConsistencyCheck: vi.fn(),
  runMetaStructureCheck: vi.fn(),
  runTimelineCheck: vi.fn(),
  runIntentDriftCheck: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import * as runners from "@/features/kouetsu/runners";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  runFullCheck,
  useFullCheckStore,
  type FullCheckStepId,
} from "./fullCheck";

const okOutcome = { ok: true as const, fromCache: false, count: 0 };
const runTypo = vi.mocked(runners.runTypoCheck);
const runReview = vi.mocked(runners.runReviewCheck);
const runConsistency = vi.mocked(runners.runConsistencyCheck);
const runMeta = vi.mocked(runners.runMetaStructureCheck);
const runTimeline = vi.mocked(runners.runTimelineCheck);
const runIntent = vi.mocked(runners.runIntentDriftCheck);

function enabled(
  overrides: Partial<Record<FullCheckStepId, boolean>>,
): Record<FullCheckStepId, boolean> {
  return {
    lint: false,
    typo: false,
    consistency: false,
    review: false,
    meta: false,
    timeline: false,
    intent: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFullCheckStore.setState({
    running: false,
    currentStep: null,
    done: 0,
    total: 0,
    failures: [],
    cancelRequested: false,
  });
  runTypo.mockResolvedValue(okOutcome);
  runReview.mockResolvedValue(okOutcome);
  runConsistency.mockResolvedValue({ codex: okOutcome, intra: okOutcome });
  runMeta.mockResolvedValue(okOutcome);
  runTimeline.mockResolvedValue(okOutcome);
  runIntent.mockResolvedValue(okOutcome);
  useTreeStore.setState({ activeSceneId: "scene-1" });
});

describe("runFullCheck", () => {
  it("有効な観点だけを固定順で直列実行する", async () => {
    const order: string[] = [];
    runReview.mockImplementation(async () => {
      order.push("review");
      return okOutcome;
    });
    runTypo.mockImplementation(async () => {
      order.push("typo");
      return okOutcome;
    });
    // enabled は review→typo の順で渡しても固定順(typo→review)で実行される。
    await runFullCheck(
      { type: "project" },
      enabled({ review: true, typo: true }),
    );
    expect(order).toEqual(["typo", "review"]);
    expect(useFullCheckStore.getState().total).toBe(2);
    expect(useFullCheckStore.getState().done).toBe(2);
    expect(useFullCheckStore.getState().running).toBe(false);
  });

  it("scene スコープでは lint ステップが total に入らない", async () => {
    await runFullCheck({ type: "scene" }, enabled({ lint: true, typo: true }));
    // lint は live lint 済みなので scene では除外 → total は typo の 1 のみ。
    expect(useFullCheckStore.getState().total).toBe(1);
    expect(runTypo).toHaveBeenCalledTimes(1);
    expect(runTypo).toHaveBeenCalledWith({ type: "scene", sceneId: "scene-1" });
  });

  it("観点の失敗は failures に積んで続行する", async () => {
    runTypo.mockResolvedValue({ ok: false, error: "boom" });
    runReview.mockResolvedValue({ ok: true, fromCache: false, count: 1 });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toEqual({ step: "typo", error: "boom" });
    expect(runReview).toHaveBeenCalled();
    expect(state.done).toBe(2);
    // 失敗ありは warning トーストで完了を告げる（success は出さない）。
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("requestCancel 後は残り観点を実行しない", async () => {
    runTypo.mockImplementation(async () => {
      useFullCheckStore.getState().requestCancel();
      return okOutcome;
    });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    expect(runTypo).toHaveBeenCalledTimes(1);
    expect(runReview).not.toHaveBeenCalled();
    // 中止時は success トーストを出さない。
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("二重起動は無視される (running 中の再入)", async () => {
    let release: () => void = () => {};
    runTypo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(okOutcome);
        }),
    );
    const first = runFullCheck({ type: "project" }, enabled({ typo: true }));
    // first がまだ typo を await 中 (running=true) の間に再入。
    const second = runFullCheck({ type: "project" }, enabled({ typo: true }));
    await second;
    release();
    await first;
    expect(runTypo).toHaveBeenCalledTimes(1);
  });

  it("blocked 観点で全体を即中断する（failures に積まない）", async () => {
    runTypo.mockResolvedValue({ ok: true, blocked: true });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(runReview).not.toHaveBeenCalled();
    expect(state.failures).toHaveLength(0);
    // ガードが toast 済みなので完了トーストは出さない。
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("consistency は 1 観点として数え、両 outcome の指摘を合算する", async () => {
    runConsistency.mockResolvedValue({
      codex: { ok: true, fromCache: false, count: 2 },
      intra: { ok: true, fromCache: false, count: 3 },
    });
    await runFullCheck({ type: "project" }, enabled({ consistency: true }));
    const state = useFullCheckStore.getState();
    expect(runConsistency).toHaveBeenCalledTimes(1);
    expect(state.total).toBe(1);
    expect(state.done).toBe(1);
    expect(state.failures).toHaveLength(0);
    // 完全成功 → success トースト（合算 5 件）。
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("intent runner は isCancelled が true になった時点で以降のシーンを起動しない", async () => {
    // runIntentDriftCheck の per-scene 直列を mock で再現し、各シーン起動前に
    // opts.isCancelled() を確認する。途中で cancelRequested を立て、以降の
    // シーン起動が止まる（＝isCancelled が実際に直列を止める）ことを検証する。
    const launched: number[] = [];
    runIntent.mockImplementation(async (_scope, opts) => {
      for (let i = 0; i < 5; i++) {
        if (opts?.isCancelled?.()) break;
        launched.push(i);
        // 2 シーン目起動後に外部から中止要求が来たと想定。
        if (i === 1) useFullCheckStore.getState().requestCancel();
      }
      return okOutcome;
    });
    await runFullCheck({ type: "project" }, enabled({ intent: true }));
    // i=0,1 は起動、i=2 の直前で isCancelled()===true → 停止。3 件目以降なし。
    expect(launched).toEqual([0, 1]);
  });

  it("runner が reject しても後続観点を続行し failures に積む（running も戻す）", async () => {
    // Fix 1 回帰: payload build / flush / IPC の reject が running を恒久ロック
    // しないこと、continue-on-error で後続が走ること、failures に積まれることを検証。
    runTypo.mockRejectedValue(new Error("ipc down"));
    runReview.mockResolvedValue({ ok: true, fromCache: false, count: 1 });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toEqual({ step: "typo", error: "ipc down" });
    expect(runReview).toHaveBeenCalled(); // continue-on-error
    expect(state.done).toBe(2);
    expect(state.running).toBe(false); // finally で必ず復帰
    // 真の失敗ありなので warning、success は出さない。
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("非 Error の throw も message 化して failures に積む", async () => {
    runTypo.mockImplementation(async () => {
      throw "raw string failure";
    });
    await runFullCheck({ type: "project" }, enabled({ typo: true }));
    const state = useFullCheckStore.getState();
    expect(state.failures[0]).toEqual({
      step: "typo",
      error: "raw string failure",
    });
    expect(state.running).toBe(false);
  });

  it("実行中の cancel で生じた観点 error は failures に積まず warning を出さない", async () => {
    // Fix 2 回帰: in-flight run を abort すると backend が error 終端になるが、
    // cancelRequested 後の error は「中止起因」とみなし failures に積まない。
    runTypo.mockImplementation(async () => {
      // in-flight で中止要求（backend abort → error 終端相当）。
      useFullCheckStore.getState().requestCancel();
      return { ok: false, error: "aborted" };
    });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.failures).toHaveLength(0); // 中止起因は積まない
    expect(runReview).not.toHaveBeenCalled(); // 中止で残りをスキップ
    expect(state.running).toBe(false);
    // 真の失敗なし → warning も success も出さない（中止＝トーストなし）。
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("cancel 前の真の失敗は残り、中止後もその warning を出す", async () => {
    // typo は真に失敗（cancel 前）、review 実行中に cancel → review の error は
    // 中止起因で積まないが、typo の failure は残るので warning が出る。
    runTypo.mockResolvedValue({ ok: false, error: "boom" });
    runReview.mockImplementation(async () => {
      useFullCheckStore.getState().requestCancel();
      return { ok: false, error: "aborted" };
    });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.failures).toEqual([{ step: "typo", error: "boom" }]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});
