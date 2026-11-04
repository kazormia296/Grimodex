import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";
import {
  createNarrativeMaintenanceTriggerCoordinator,
  type NarrativeMaintenanceTriggerCoordinator,
} from "./narrativeMaintenanceTriggers.js";
import type { NarrativeMaintenanceScheduler } from "./narrativeMaintenance.js";

/**
 * 再現：新しい workspace で project を作った直後から書き込み（Chronicle 抽出）が続くと、
 * Verify の証跡が書き込みのたびに失効する（NEX_VERIFY_GRAPH_STATE_CHANGED）。
 * planner は同じ DesiredWork{Verify} を返し続け、再発見の上限（3 回）で chain が黙って終わる。
 * そのとき lastWakeReason="before-cutover" が残るので、Freshness の idle poll ごとの
 * cutoverNotReady（→ requestBeforeCutoverPreparation）も「chain は動いている」と見なされて
 * 無視され続ける。書き込みが止まっても誰も保守を起動せず、cutover の marker が付かない。
 *
 * 配線は index.ts / narrativeMaintenanceBootstrap.ts と同じ：
 *   Freshness.onCutoverNotReady -> coordinator.requestBeforeCutoverPreparation
 *   maintenance scheduler.onCycleAccepted -> coordinator.requestRediscovery
 * Native の planner と C2-ZC cutover だけを fake にしている。
 */

const BINDING = { authorityId: "authority-stall", generation: 1 };

const verifyWork = {
  projectId: "fusion-ir",
  runKind: "dependency-verify",
  workKey: "dependency-verify:epoch-1",
  semanticEpochId: "epoch-1",
  reasons: ["before-cutover"],
};

function createHarness() {
  const state = {
    /** 抽出の書き込みが続いている間 true。Verify の証跡は毎回失効する。 */
    writesActive: true,
    verifyFresh: false,
    cutoverDone: false,
    discoverCalls: 0,
  };
  let coordinator: NarrativeMaintenanceTriggerCoordinator | null = null;

  const scheduler = {
    // 受理された保守 cycle：Verify は完了するが、書き込み中なら証跡はすぐ失効する。
    requestManyWithBinding: vi.fn((work: readonly unknown[]) => {
      if (work.length === 0) return;
      setTimeout(() => {
        if (!state.writesActive) state.verifyFresh = true;
        coordinator?.requestRediscovery(); // bootstrap の onCycleAccepted と同じ
      }, 30);
    }),
  } as unknown as NarrativeMaintenanceScheduler;

  const backend = {
    // Rust planner の写し：証跡が失効している間は同じ Verify を返し、新鮮なら空。
    discoverNarrativeMaintenanceWork: vi.fn(async () => {
      state.discoverCalls += 1;
      return {
        workspaceBinding: BINDING,
        pages: [{ work: state.verifyFresh ? [] : [verifyWork] }],
      };
    }),
  };

  coordinator = createNarrativeMaintenanceTriggerCoordinator(
    backend,
    scheduler,
    {
      warn: vi.fn(),
    },
  );

  // run_narrative_freshness_cycle の写し：idle poll ごとに cut_over_workspace_freshness を
  // 試み、Verify が新鮮でなければ cutoverNotReady を返す。
  const freshness = createNarrativeFreshnessScheduler(
    {
      runNarrativeFreshnessCycle: vi.fn(async () => {
        if (state.cutoverDone) return null;
        if (state.verifyFresh) {
          state.cutoverDone = true; // marker を書く
          return null;
        }
        return JSON.stringify({ hasMore: false, cutoverNotReady: true });
      }),
    },
    {
      warn: vi.fn(),
      onCutoverNotReady: () => coordinator?.requestBeforeCutoverPreparation(),
    },
  );

  return {
    state,
    coordinator,
    freshness,
    dispose: async () => {
      await freshness.dispose();
      await coordinator?.dispose();
    },
  };
}

describe("narrative maintenance: 書き込み中に再発見が尽きたあとの cutover 前停止", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("書き込みが止まったあとの cutoverNotReady で保守が再開し、cutover まで進む", async () => {
    const harness = createHarness();
    harness.freshness.start();

    // 抽出が続く 10 秒：再発見の上限（3 回）を使い切る。
    await vi.advanceTimersByTimeAsync(10_000);
    const callsWhileWriting = harness.state.discoverCalls;
    expect(callsWhileWriting).toBeGreaterThanOrEqual(2);
    expect(harness.state.cutoverDone).toBe(false);

    // 書き込みが止まる。Freshness は 1 秒ごとに NOT_READY を通知し続けている。
    harness.state.writesActive = false;
    await vi.advanceTimersByTimeAsync(120_000);

    // 修正前：discover は上限で止まったままで、Verify も再実行されず cutover されない。
    expect(harness.state.discoverCalls).toBeGreaterThan(callsWhileWriting);
    expect(harness.state.verifyFresh).toBe(true);
    expect(harness.state.cutoverDone).toBe(true);
    await harness.dispose();
  });

  it("書き込みが止まらない間も discover は無制限に回らない（再点火の上限）", async () => {
    const harness = createHarness();
    harness.freshness.start();

    await vi.advanceTimersByTimeAsync(600_000);

    // 修正後は backoff（5 s × 2^(k-1)、上限 60 s）付きで再点火する。1 回の再点火は
    // 発見 1＋再発見 3 の最大 4 回。10 分（Freshness の poll は 600 回）で、
    // 5,10,20,40 s の後は 60 s ごと（約 13 回の再点火 ≒ 52 回）に収まる。poll ごとに
    // 回る暴走（約 600 回）は許さない。
    expect(harness.state.discoverCalls).toBeLessThanOrEqual(56);
    expect(harness.state.cutoverDone).toBe(false);
    await harness.dispose();
  });

  it("書き込みが無ければ従来どおり 1 本の chain で cutover まで進み、その後は discover しない", async () => {
    const harness = createHarness();
    harness.state.writesActive = false;
    harness.freshness.start();

    await vi.advanceTimersByTimeAsync(10_000);
    // Verify が新鮮になった時点で planner は空を返し、chain は終わる。
    expect(harness.state.cutoverDone).toBe(true);
    const callsAtCutover = harness.state.discoverCalls;
    expect(callsAtCutover).toBeLessThanOrEqual(3);

    // cutover の後は Freshness が NOT_READY を返さない。長く待っても再点火しない。
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.state.discoverCalls).toBe(callsAtCutover);
    await harness.dispose();
  });

  it("書き込みが止まったあと、最悪でも上限の cooldown（60 s）＋数秒で cutover する", async () => {
    const harness = createHarness();
    harness.freshness.start();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.state.cutoverDone).toBe(false);
    harness.state.writesActive = false;
    await vi.advanceTimersByTimeAsync(70_000);

    expect(harness.state.cutoverDone).toBe(true);
    await harness.dispose();
  });
});
