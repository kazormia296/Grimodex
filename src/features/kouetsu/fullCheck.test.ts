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
  FULL_CHECK_STEP_ORDER,
  type FullCheckState,
  type FullCheckStepId,
  type FullCheckStepState,
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

/** 全観点 pending の steps レコード（beforeEach のリセット用）。 */
function pendingSteps(): Record<FullCheckStepId, FullCheckStepState> {
  const rec = {} as Record<FullCheckStepId, FullCheckStepState>;
  for (const id of FULL_CHECK_STEP_ORDER) rec[id] = { state: "pending" };
  return rec;
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
    runState: "idle",
    steps: pendingSteps(),
    pipelineVisible: false,
    lastFinishedAt: null,
    findingsTotal: 0,
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
    // 第 2 引数は onRunStarted フック（中止対象の限定用）。scope が正しく渡る
    // ことだけを assert する。
    expect(runTypo).toHaveBeenCalledWith(
      { type: "scene", sceneId: "scene-1" },
      expect.objectContaining({ onRunStarted: expect.any(Function) }),
    );
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

  it("consistency の codex 片側失敗は観点失敗として failures に可視化する", async () => {
    // runner の scene パスは片側の payload build 失敗を ok:false へ畳む
    // （reject しない）。無音の握り潰しにせず、観点失敗として完了 warning に出す。
    runConsistency.mockResolvedValue({
      codex: { ok: false, error: "codex build fail" },
      intra: { ok: true, fromCache: false, count: 3 },
    });
    await runFullCheck({ type: "project" }, enabled({ consistency: true }));
    const state = useFullCheckStore.getState();
    expect(state.failures).toEqual([
      { step: "consistency", error: "codex build fail" },
    ]);
    expect(state.done).toBe(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("consistency の intra 片側失敗も failures に可視化する", async () => {
    runConsistency.mockResolvedValue({
      codex: { ok: true, fromCache: false, count: 2 },
      intra: { ok: false, error: "intra run fail" },
    });
    await runFullCheck({ type: "project" }, enabled({ consistency: true }));
    const state = useFullCheckStore.getState();
    expect(state.failures).toEqual([
      { step: "consistency", error: "intra run fail" },
    ]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
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

describe("runFullCheck per-step 進捗（パイプライン表示用）", () => {
  it("開始時に対象=pending / 非対象=skipped(unchecked) で初期化し、実行中は running を立てる", async () => {
    // 閉包代入の CFA 制約を避けるため配列 push でスナップショットを捕捉する。
    const midStates: FullCheckState[] = [];
    runTypo.mockImplementation(async () => {
      midStates.push(useFullCheckStore.getState());
      return okOutcome;
    });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    // typo 実行中のスナップショット: 自分=running / 後続対象=pending / OFF=skipped。
    expect(midStates).toHaveLength(1);
    const mid = midStates[0];
    expect(mid.runState).toBe("running");
    expect(mid.pipelineVisible).toBe(true);
    expect(mid.findingsTotal).toBe(0);
    expect(mid.steps.typo).toEqual({ state: "running" });
    expect(mid.steps.review).toEqual({ state: "pending" });
    expect(mid.steps.lint).toEqual({ state: "skipped", reason: "unchecked" });
    expect(mid.steps.intent).toEqual({ state: "skipped", reason: "unchecked" });
  });

  it("scene スコープで除外された lint は skipped(sceneLint) になる", async () => {
    await runFullCheck({ type: "scene" }, enabled({ lint: true, typo: true }));
    const state = useFullCheckStore.getState();
    expect(state.steps.lint).toEqual({ state: "skipped", reason: "sceneLint" });
    expect(state.steps.typo).toEqual({ state: "done", count: 0 });
    // OFF の観点は unchecked のまま。
    expect(state.steps.review).toEqual({
      state: "skipped",
      reason: "unchecked",
    });
  });

  it("完走時は per-step done{count} と findingsTotal / lastFinishedAt を確定する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:34:56.000Z"));
    try {
      runTypo.mockResolvedValue({ ok: true, fromCache: false, count: 2 });
      runReview.mockResolvedValue({ ok: true, fromCache: false, count: 3 });
      await runFullCheck(
        { type: "project" },
        enabled({ typo: true, review: true }),
      );
      const state = useFullCheckStore.getState();
      expect(state.steps.typo).toEqual({ state: "done", count: 2 });
      expect(state.steps.review).toEqual({ state: "done", count: 3 });
      expect(state.findingsTotal).toBe(5);
      expect(state.lastFinishedAt).toBe("2026-07-06T12:34:56.000Z");
      // 完了後もパイプラインは閉じるまで表示を維持する（runState=done）。
      expect(state.runState).toBe("done");
      expect(state.running).toBe(false);
      expect(state.pipelineVisible).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("観点エラーは steps に error として記録し、後続観点は続行する（完走扱い）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:34:56.000Z"));
    try {
      runTypo.mockResolvedValue({ ok: false, error: "boom" });
      runReview.mockResolvedValue({ ok: true, fromCache: false, count: 4 });
      await runFullCheck(
        { type: "project" },
        enabled({ typo: true, review: true }),
      );
      const state = useFullCheckStore.getState();
      expect(state.steps.typo).toEqual({ state: "error", error: "boom" });
      expect(state.steps.review).toEqual({ state: "done", count: 4 });
      expect(state.failures).toEqual([{ step: "typo", error: "boom" }]);
      // 失敗ありでも中止ではないので完走扱い（lastFinishedAt / findingsTotal 確定）。
      expect(state.runState).toBe("done");
      expect(state.findingsTotal).toBe(4);
      expect(state.lastFinishedAt).toBe("2026-07-06T12:34:56.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("中止時は残り観点が pending のまま、runState=done で lastFinishedAt は未更新", async () => {
    runTypo.mockImplementation(async () => {
      useFullCheckStore.getState().requestCancel();
      return { ok: true, fromCache: false, count: 1 };
    });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.steps.typo).toEqual({ state: "done", count: 1 });
    expect(state.steps.review).toEqual({ state: "pending" }); // break で未着手のまま
    expect(state.runState).toBe("done"); // 中止でもパイプラインは閉じるまで維持
    expect(state.lastFinishedAt).toBeNull();
    expect(state.findingsTotal).toBe(0);
  });

  it("cancel 起因の abort error は steps に error 記録するが failures には積まない", async () => {
    runTypo.mockImplementation(async () => {
      useFullCheckStore.getState().requestCancel();
      return { ok: false, error: "aborted" };
    });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.steps.typo).toEqual({ state: "error", error: "aborted" });
    expect(state.failures).toHaveLength(0);
    expect(state.runState).toBe("done");
    expect(state.lastFinishedAt).toBeNull();
  });

  it("blocked（ガード拒否）は runState を idle に戻し lastFinishedAt / findingsTotal は未更新", async () => {
    runTypo.mockResolvedValue({ ok: true, blocked: true });
    await runFullCheck(
      { type: "project" },
      enabled({ typo: true, review: true }),
    );
    const state = useFullCheckStore.getState();
    expect(state.runState).toBe("idle");
    expect(state.pipelineVisible).toBe(false);
    expect(state.lastFinishedAt).toBeNull();
    expect(state.findingsTotal).toBe(0);
  });
});
