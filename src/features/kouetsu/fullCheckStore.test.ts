// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * fullCheckStore.ts — 中止（requestCancel）の abort スコープを検証する。
 *
 * 回帰: 旧実装は runStore の outcome 未確定 run を無差別に abort していたため、
 * 全体チェック中にユーザーが手動起動した無関係な並走 run（疑似コメント・単発・
 * 別 multi）まで巻き込んでいた。per-run 追跡（trackFullCheckRun）で全体チェック
 * 自身が起動した run に限定されることを assert する。
 */

const h = vi.hoisted(() => ({
  abortPostEffectRun: vi.fn(() => Promise.resolve()),
  lintCancel: vi.fn(),
}));

vi.mock("@/features/post-effect/api", () => ({
  abortPostEffectRun: h.abortPostEffectRun,
}));
vi.mock("@/features/lint/lintProjectStore", () => ({
  useLintProjectStore: { getState: () => ({ cancel: h.lintCancel }) },
}));

import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import {
  useFullCheckStore,
  trackFullCheckRun,
  resetFullCheckRuns,
} from "./fullCheckStore";

beforeEach(() => {
  vi.clearAllMocks();
  resetFullCheckRuns();
  usePostEffectRunStore.setState({ runs: {} });
  useFullCheckStore.setState({
    cancelRequested: false,
    runState: "idle",
    pipelineVisible: false,
  });
});

describe("fullCheckStore requestCancel の abort スコープ", () => {
  it("追跡している run だけを abort し、無関係の並走 run は巻き込まない", () => {
    // 全体チェックの現ステップ run（追跡対象）。
    usePostEffectRunStore.getState().begin({
      runId: "fc-run",
      projectId: "p1",
      effectType: "review",
      scopeType: "project",
      scopeTargetId: null,
    });
    trackFullCheckRun("fc-run");
    // ユーザーが手動起動した無関係な並走 run（別 effect type、追跡対象外）。
    usePostEffectRunStore.getState().begin({
      runId: "manual-run",
      projectId: "p1",
      effectType: "pseudo_comment",
      scopeType: "scene",
      scopeTargetId: "s9",
    });

    useFullCheckStore.getState().requestCancel();

    expect(useFullCheckStore.getState().cancelRequested).toBe(true);
    // 追跡 run のみ abort。無関係 run の abort IPC は呼ばれない。
    expect(h.abortPostEffectRun).toHaveBeenCalledTimes(1);
    expect(h.abortPostEffectRun).toHaveBeenCalledWith("fc-run", "p1");
    // lint scan cancel は常に呼ぶ（単一 scan 構造なので無害）。
    expect(h.lintCancel).toHaveBeenCalledTimes(1);
  });

  it("consistency の 2 本並走はどちらも追跡され両方 abort される", () => {
    for (const [runId, effect] of [
      ["cons-codex", "consistency"],
      ["cons-intra", "intra_scene_consistency"],
    ] as const) {
      usePostEffectRunStore.getState().begin({
        runId,
        projectId: "p1",
        effectType: effect,
        scopeType: "project",
        scopeTargetId: null,
      });
      trackFullCheckRun(runId);
    }
    useFullCheckStore.getState().requestCancel();
    expect(h.abortPostEffectRun).toHaveBeenCalledTimes(2);
    expect(h.abortPostEffectRun).toHaveBeenCalledWith("cons-codex", "p1");
    expect(h.abortPostEffectRun).toHaveBeenCalledWith("cons-intra", "p1");
  });

  it("追跡 run が既に終端（outcome 付き）なら abort しない", () => {
    // 終端済みエントリを直接組む（scheduleClear タイマーを避けるため complete は使わない）。
    usePostEffectRunStore.setState({
      runs: {
        "fc-done": {
          runId: "fc-done",
          projectId: "p1",
          effectType: "typo_detection",
          scopeType: "project",
          scopeTargetId: null,
          progress: 1,
          stage: "done",
          message: null,
          startedAt: Date.now(),
          outcome: { kind: "done", annotationCount: 0 },
        },
      },
    });
    trackFullCheckRun("fc-done");
    useFullCheckStore.getState().requestCancel();
    expect(h.abortPostEffectRun).not.toHaveBeenCalled();
  });

  it("追跡集合が空なら（reset 後）abort は一切呼ばれない", () => {
    usePostEffectRunStore.getState().begin({
      runId: "orphan",
      projectId: "p1",
      effectType: "review",
      scopeType: "project",
      scopeTargetId: null,
    });
    // trackFullCheckRun を呼ばない = 全体チェックが起動していない状態。
    useFullCheckStore.getState().requestCancel();
    expect(h.abortPostEffectRun).not.toHaveBeenCalled();
  });
});

describe("fullCheckStore パイプライン表示アクション", () => {
  it("showPipeline / hidePipeline は pipelineVisible だけを切り替える", () => {
    useFullCheckStore.getState().showPipeline();
    expect(useFullCheckStore.getState().pipelineVisible).toBe(true);
    expect(useFullCheckStore.getState().runState).toBe("idle"); // 触らない
    useFullCheckStore.getState().hidePipeline();
    expect(useFullCheckStore.getState().pipelineVisible).toBe(false);
  });

  it("closePipeline は runState=done を idle へ戻し表示を畳む", () => {
    useFullCheckStore.setState({ runState: "done", pipelineVisible: true });
    useFullCheckStore.getState().closePipeline();
    const s = useFullCheckStore.getState();
    expect(s.runState).toBe("idle");
    expect(s.pipelineVisible).toBe(false);
  });

  it("closePipeline は実行中（runState=running）なら表示のみ畳み runState は維持する", () => {
    useFullCheckStore.setState({ runState: "running", pipelineVisible: true });
    useFullCheckStore.getState().closePipeline();
    const s = useFullCheckStore.getState();
    expect(s.runState).toBe("running"); // run の終了処理側で確定する
    expect(s.pipelineVisible).toBe(false);
  });

  it("closePipeline は idle でも安全（表示を畳むだけ）", () => {
    useFullCheckStore.setState({ runState: "idle", pipelineVisible: true });
    useFullCheckStore.getState().closePipeline();
    const s = useFullCheckStore.getState();
    expect(s.runState).toBe("idle");
    expect(s.pipelineVisible).toBe(false);
  });
});
