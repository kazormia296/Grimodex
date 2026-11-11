import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";
import {
  NARRATIVE_MAINTENANCE_PREEMPT_BACKOFF_AFTER,
  canonicalNarrativeMaintenanceWorkKey,
  createNarrativeMaintenanceScheduler,
  type NarrativeMaintenanceCycleRequest,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";

// DR-MP-8: preempt が続く project の maintenance の再試行に backoff を入れる。
// 時間はすべて fake timer の仮想時間。実時間は使わない。
const INITIAL_DELAY_MS = 250;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;
/** 設計どおりの回数。製品側の定数とは別に固定して、定数の取り違えも検出する。 */
const BACKOFF_AFTER = 3;

const PREEMPTED = {
  status: "accepted",
  hasMore: true,
  preempted: true,
} as const;
const SETTLED = { status: "accepted", hasMore: false } as const;

function verifyWork(
  projectId: string,
  reason = "verify-requested",
): NarrativeMaintenanceRequest {
  return {
    projectId,
    runKind: "dependency-verify",
    workKey: `dependency-verify:${projectId}`,
    semanticEpochId: null,
    reason,
  };
}

function freshnessSummary(): string {
  return JSON.stringify({
    projectId: "project-fresh",
    fromSequenceExclusive: 0,
    throughSequenceInclusive: 1,
    affectedEdgeCount: 1,
    affectedConsumerCount: 1,
    hasMore: false,
  });
}

describe("narrative maintenance preempt backoff (DR-MP-8)", () => {
  const disposables: Array<{ dispose(): void | Promise<void> }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(async () => {
    // dispose は走行中の cycle（仮想時間の slot）を待つので、時間を進めながら待つ。
    const disposing = Promise.all(
      disposables.splice(0).map((item) => Promise.resolve(item.dispose())),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await disposing;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function create(
    backend: Parameters<typeof createNarrativeMaintenanceScheduler>[0],
  ): NarrativeMaintenanceScheduler {
    const scheduler = createNarrativeMaintenanceScheduler(backend, {
      warn: vi.fn(),
    });
    disposables.push(scheduler);
    return scheduler;
  }

  it("固定の回数は 3", () => {
    expect(NARRATIVE_MAINTENANCE_PREEMPT_BACKOFF_AFTER).toBe(BACKOFF_AFTER);
  });

  it("3 回続けて preempt されるまでは 10 ms、4 回目の後は 1 s（999／1000 の境界）", async () => {
    const calls: number[] = [];
    const scheduler = create({
      runNarrativeMaintenanceCycle: vi.fn(async () => {
        calls.push(Date.now());
        return PREEMPTED;
      }),
    });
    scheduler.request(verifyWork("project-boundary"));
    scheduler.start();

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(calls).toEqual([250]);
    // 1〜3 回目の preempt の次は 10 ms。
    for (let call = 2; call <= 4; call += 1) {
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS - 1);
      expect(calls).toHaveLength(call - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(call);
    }
    expect(calls).toEqual([250, 260, 270, 280]);

    // 4 回目の preempt の後は ERROR_RETRY_DELAY_MS。
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS - 1);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([250, 260, 270, 280, 1_280]);
    // その後も preempt が続く間は 1 s 間隔のまま。
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS - 1);
    expect(calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(6);
  });

  it("backoff の間は別 project が 10 ms で走り、元の project は元の notBefore で再開する", async () => {
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const times: number[] = [];
    const scheduler = create({
      runNarrativeMaintenanceCycle: vi.fn(
        async (request: NarrativeMaintenanceCycleRequest) => {
          requests.push(request);
          times.push(Date.now());
          const touchesA =
            request.work.some((work) => work.projectId === "project-a") ||
            request.wakeProjectIds.includes("project-a");
          return touchesA ? PREEMPTED : SETTLED;
        },
      ),
    });
    scheduler.request(verifyWork("project-a"));
    scheduler.start();
    // 250, 260, 270, 280 の 4 回の preempt で project-a は 1,280 まで backoff。
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS);
    expect(times).toEqual([250, 260, 270, 280]);

    await vi.advanceTimersByTimeAsync(300); // t = 580
    scheduler.request(verifyWork("project-b"));
    // 他の project は backoff の timer に待たされず 10 ms で走る。
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS - 1);
    expect(times).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([250, 260, 270, 280, 590]);
    expect(requests[4]?.work.map((work) => work.projectId)).toEqual([
      "project-b",
    ]);
    expect(requests[4]?.wakeProjectIds).toEqual([]);

    // project-a は元の notBefore（1,280）まで走らない。
    await vi.advanceTimersByTimeAsync(1_279 - 590);
    expect(times).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([250, 260, 270, 280, 590, 1_280]);
    expect(requests[5]?.wakeProjectIds).toEqual(["project-a"]);
  });

  it("同じ project の再 enqueue は backoff を縮めない", async () => {
    const times: number[] = [];
    const scheduler = create({
      runNarrativeMaintenanceCycle: vi.fn(async () => {
        times.push(Date.now());
        return PREEMPTED;
      }),
    });
    scheduler.request(verifyWork("project-same"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS);
    expect(times).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(100);
    // coordinator の再発見と同じ形：同じ project の同じ work が来る。
    scheduler.request(verifyWork("project-same", "rediscovered"));
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS * 5);
    expect(times).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_280 - 380 - BACKLOG_DELAY_MS * 5 - 1);
    expect(times).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(5);
  });

  it("全部の project が backoff の間は、timer を backoff の長さに置く（10 ms の空回りにしない）", async () => {
    const delays: number[] = [];
    const scheduler = create({
      runNarrativeMaintenanceCycle: vi.fn(async () => PREEMPTED),
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    scheduler.request(verifyWork("project-floor"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS);
    // 4 回目の preempt の cycle が終わった直後の timer。
    for (const call of timeoutSpy.mock.calls) {
      if (typeof call[1] === "number") delays.push(call[1]);
    }
    expect(delays.at(-1)).toBe(ERROR_RETRY_DELAY_MS);
    // backoff の間は timer が増えない（cycle も空回りもしない）。
    const timersDuringBackoff = timeoutSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS - 1);
    expect(timeoutSpy.mock.calls.length).toBe(timersDuringBackoff);
  });

  it("backoff 中の project の pending work は、別 project の cycle の batch に入らない", async () => {
    const binding = { authorityId: "authority-pending", generation: 3 };
    const requests: NarrativeMaintenanceCycleRequest[] = [];
    const times: number[] = [];
    const verifyA = verifyWork("project-pending-a");
    const touchesA = (request: NarrativeMaintenanceCycleRequest): boolean =>
      request.work.some((work) => work.projectId === verifyA.projectId) ||
      request.wakeProjectIds.includes(verifyA.projectId);
    let last: NarrativeMaintenanceCycleRequest | null = null;
    const scheduler = create({
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      runNarrativeMaintenanceCycle: vi.fn(
        async (request: NarrativeMaintenanceCycleRequest) => {
          requests.push(request);
          times.push(Date.now());
          last = request;
          return touchesA(request) ? PREEMPTED : SETTLED;
        },
      ),
      beginNarrativeMaintenanceAttempt: vi.fn(
        (attemptId: string, received: typeof binding) =>
          JSON.stringify({
            status: "open",
            attemptId,
            authorityId: received.authorityId,
            generation: received.generation,
          }),
      ),
      cancelNarrativeMaintenanceAttempt: vi.fn((attemptId: string) => {
        const aCycle = last !== null && touchesA(last);
        return JSON.stringify({
          schemaVersion: 1,
          attemptId,
          state: aCycle ? "interrupted" : "succeeded",
          stopReason: aCycle ? "foreground-preempted" : null,
          generation: binding.generation,
          workspaceBinding: binding,
          publishedGeneration: aCycle ? null : binding.generation,
          works: (last?.work ?? []).map((work) => ({
            workKey: canonicalNarrativeMaintenanceWorkKey(work),
            status: aCycle ? "interrupted" : "succeeded",
          })),
          cleanup: { status: "clean" },
          connectionReusable: true,
        });
      }),
    });
    scheduler.request(verifyA);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS);
    expect(times).toEqual([250, 260, 270, 280]);

    await vi.advanceTimersByTimeAsync(300); // 580 ms
    scheduler.request(verifyWork("project-pending-b"));
    await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
    expect(times).toEqual([250, 260, 270, 280, 590]);
    expect(requests[4]?.work.map((work) => work.projectId)).toEqual([
      "project-pending-b",
    ]);
    // project-pending-a は notBefore（1,280）まで走らず、そのときに再開する。
    await vi.advanceTimersByTimeAsync(1_279 - 590);
    expect(times).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(6);
    expect(requests[5]?.work.map((work) => work.projectId)).toEqual([
      "project-pending-a",
    ]);
  });

  describe("回数の戻し", () => {
    it("成功すると回数が戻り、次の preempt は 1 から数える", async () => {
      const times: number[] = [];
      let preemptsLeft = 3;
      const scheduler = create({
        runNarrativeMaintenanceCycle: vi.fn(async () => {
          times.push(Date.now());
          if (preemptsLeft > 0) {
            preemptsLeft -= 1;
            return PREEMPTED;
          }
          return SETTLED;
        }),
      });
      scheduler.request(verifyWork("project-success"));
      scheduler.start();
      // preempt 3 回の後に 4 回目で成功（250, 260, 270, 280）。
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS,
      );
      expect(times).toEqual([250, 260, 270, 280]);

      // 成功の後の新しい work は、また 3 回までは 10 ms で再試行される。
      preemptsLeft = 3;
      scheduler.request(verifyWork("project-success", "again"));
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
      await vi.advanceTimersByTimeAsync(3 * BACKLOG_DELAY_MS);
      expect(times).toEqual([250, 260, 270, 280, 290, 300, 310, 320]);
    });

    it("preempt 以外の結果（error）で回数が戻る", async () => {
      const times: number[] = [];
      let step = 0;
      const scheduler = create({
        runNarrativeMaintenanceCycle: vi.fn(async () => {
          times.push(Date.now());
          step += 1;
          // 2 回 preempt → error → preempt が続く。error で戻らなければ 4 回目で backoff になる。
          if (step === 3) throw new Error("native unavailable");
          return PREEMPTED;
        }),
      });
      scheduler.request(verifyWork("project-error"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + BACKLOG_DELAY_MS);
      expect(times).toEqual([250, 260]);
      // 3 回目が error（retry は 1 s 後）。
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
      expect(times).toEqual([250, 260, 270]);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS);
      expect(times).toEqual([250, 260, 270, 1_270]);
      // 回数は 0 から。1_270、1_280、1_290 の 3 回は 10 ms 間隔のまま
      // （error で戻らなければ 1_280 の preempt が 4 回目になり、1_290 は来ない）。
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS * 2);
      expect(times).toEqual([250, 260, 270, 1_270, 1_280, 1_290]);
      // 1_300 が 4 回目の preempt。その次は 1 s の backoff。
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
      expect(times).toHaveLength(7);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS - 1);
      expect(times).toHaveLength(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(times).toHaveLength(8);
    });

    it("quiesce（workspace の切替）で回数が戻る", async () => {
      const times: number[] = [];
      const scheduler = create({
        runNarrativeMaintenanceCycle: vi.fn(async () => {
          times.push(Date.now());
          return PREEMPTED;
        }),
      });
      scheduler.request(verifyWork("project-quiesce"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS,
      );
      expect(times).toHaveLength(4);

      const lease = await scheduler.quiesceForWorkspaceSwitch?.();
      await vi.advanceTimersByTimeAsync(100); // 380 ms：元の backoff（1,280 ms）の途中
      expect(times).toHaveLength(4); // quiesce の間は走らない
      await lease?.resume();
      // 戻した後は、backoff の残りでなく 10 ms で再開する。
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
      expect(times).toHaveLength(5);
    });

    it("binding が変わった work は、元の binding の backoff を引き継がない", async () => {
      const times: number[] = [];
      const bindings: Array<{ authorityId: string; generation: number }> = [];
      let binding = { authorityId: "authority-a", generation: 1 };
      const scheduler = create({
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle: vi.fn(
          async (request: NarrativeMaintenanceCycleRequest) => {
            times.push(Date.now());
            bindings.push(request.workspaceBinding ?? binding);
            return PREEMPTED;
          },
        ),
      });
      scheduler.request(verifyWork("project-binding"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS,
      );
      expect(times).toHaveLength(4);
      expect(bindings.every((value) => value.generation === 1)).toBe(true);

      binding = { authorityId: "authority-a", generation: 2 };
      scheduler.request(verifyWork("project-binding", "after-swap"));
      await vi.advanceTimersByTimeAsync(BACKLOG_DELAY_MS);
      expect(times).toHaveLength(5);
      expect(bindings[4]?.generation).toBe(2);
    });

    it("dispose で timer が残らず、以後の cycle も走らない", async () => {
      const times: number[] = [];
      const scheduler = create({
        runNarrativeMaintenanceCycle: vi.fn(async () => {
          times.push(Date.now());
          return PREEMPTED;
        }),
      });
      scheduler.request(verifyWork("project-dispose"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS,
      );
      expect(times).toHaveLength(4);
      expect(vi.getTimerCount()).toBe(1);

      await scheduler.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS * 5);
      expect(times).toHaveLength(4);
    });
  });

  describe("受領書の work key の数え方", () => {
    const binding = { authorityId: "authority-receipt", generation: 7 };

    function receiptBackend(
      runResult: (callIndex: number) => unknown,
      receiptWorks: (
        callIndex: number,
      ) => Array<{ workKey: string; status: string }>,
      calls: number[],
    ) {
      let cycleIndex = 0;
      let cancelIndex = 0;
      return {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        runNarrativeMaintenanceCycle: vi.fn(async () => {
          cycleIndex += 1;
          calls.push(Date.now());
          return runResult(cycleIndex);
        }),
        beginNarrativeMaintenanceAttempt: vi.fn(
          (attemptId: string, received: typeof binding) =>
            JSON.stringify({
              status: "open",
              attemptId,
              authorityId: received.authorityId,
              generation: received.generation,
            }),
        ),
        cancelNarrativeMaintenanceAttempt: vi.fn((attemptId: string) => {
          cancelIndex += 1;
          return JSON.stringify({
            schemaVersion: 1,
            attemptId,
            state: "interrupted",
            stopReason: "foreground-preempted",
            generation: binding.generation,
            workspaceBinding: binding,
            publishedGeneration: null,
            works: receiptWorks(cancelIndex),
            cleanup: { status: "clean" },
            connectionReusable: true,
          });
        }),
      };
    }

    it("同じ key の interrupted が続くと 4 回目の後に backoff する（同じ cycle で別の work が成功しても切れない）", async () => {
      const verify = verifyWork("project-receipt-same");
      const backfill: NarrativeMaintenanceRequest = {
        projectId: "project-receipt-same",
        runKind: "backfill",
        workKey: "legacy-dependency-backfill:v3",
        semanticEpochId: null,
        reason: "workspace-opened",
      };
      const verifyKey = canonicalNarrativeMaintenanceWorkKey(verify);
      const backfillKey = canonicalNarrativeMaintenanceWorkKey(backfill);
      const calls: number[] = [];
      const scheduler = create(
        receiptBackend(
          () => PREEMPTED,
          (index) =>
            index === 1
              ? [
                  { workKey: backfillKey, status: "succeeded" },
                  { workKey: verifyKey, status: "interrupted" },
                ]
              : [{ workKey: verifyKey, status: "interrupted" }],
          calls,
        ),
      );
      scheduler.request(verify);
      scheduler.request(backfill);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS,
      );
      expect(calls).toEqual([250, 260, 270, 280]);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS - 1);
      expect(calls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(5);
    });

    it("follow-up の予算超え（成功の work があり、key が毎回進む preempted:true）は数えない", async () => {
      const calls: number[] = [];
      const first = verifyWork("project-receipt-followup");
      const keyOf = (round: number): string =>
        canonicalNarrativeMaintenanceWorkKey({
          projectId: first.projectId,
          runKind: "semantic-index-rebuild",
          workKey: `dependency-rebuild-${round}`,
          semanticEpochId: `epoch-${round}`,
        });
      const scheduler = create(
        receiptBackend(
          () => PREEMPTED,
          (index) => [
            // 直前の follow-up が成功し、新しい follow-up は始められなかった。
            ...(index === 1
              ? [
                  {
                    workKey: canonicalNarrativeMaintenanceWorkKey(first),
                    status: "succeeded",
                  },
                ]
              : [{ workKey: keyOf(index - 1), status: "succeeded" }]),
            { workKey: keyOf(index), status: "not-started" },
          ],
          calls,
        ),
      );
      scheduler.request(first);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 7 * BACKLOG_DELAY_MS,
      );
      // 8 回続いても 10 ms のまま。
      expect(calls).toEqual([250, 260, 270, 280, 290, 300, 310, 320]);
    });

    it("受領書が coverage を証明できないときは project 単位で数える", async () => {
      const verify = verifyWork("project-receipt-null");
      const calls: number[] = [];
      const scheduler = create(
        receiptBackend(
          () => PREEMPTED,
          // batch の work を含まない受領書：`null`（coverage 不明）になる。
          () => [],
          calls,
        ),
      );
      scheduler.request(verify);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(
        INITIAL_DELAY_MS + 3 * BACKLOG_DELAY_MS,
      );
      expect(calls).toEqual([250, 260, 270, 280]);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_DELAY_MS - 1);
      expect(calls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(5);
    });
  });

  describe("2 つの scheduler の模型（最悪の位相を決定的に作る）", () => {
    const SLOT_MS = 240;
    const FRESHNESS_START_MS = 350; // maintenance の slot（250 から 240 ms）の内側
    const HORIZON_MS = 60_000;

    function runModel() {
      const slot = { busy: false };
      const maintenanceStarts: number[] = [];
      const freshnessAttempts: number[] = [];
      const freshnessRuns: number[] = [];
      const maintenance = createNarrativeMaintenanceScheduler(
        {
          runNarrativeMaintenanceCycle: vi.fn(async () => {
            slot.busy = true;
            maintenanceStarts.push(Date.now());
            await new Promise<void>((resolve) => {
              setTimeout(resolve, SLOT_MS);
            });
            slot.busy = false;
            return PREEMPTED;
          }),
        },
        { warn: vi.fn() },
      );
      const freshness = createNarrativeFreshnessScheduler(
        {
          runNarrativeFreshnessCycle: vi.fn(async () => {
            freshnessAttempts.push(Date.now());
            if (slot.busy) return null;
            freshnessRuns.push(Date.now());
            return freshnessSummary();
          }),
        },
        { warn: vi.fn() },
      );
      disposables.push(maintenance, freshness);
      maintenance.request(verifyWork("project-model"));
      maintenance.start();
      // freshness の初回（250 ms）が maintenance の slot の中に入る位相にする。
      setTimeout(() => freshness.start(), FRESHNESS_START_MS - 250);
      return { maintenanceStarts, freshnessAttempts, freshnessRuns };
    }

    it("backoff の後、2 tick 以内に freshness が 1 件通る", async () => {
      const model = runModel();
      await vi.advanceTimersByTimeAsync(HORIZON_MS);

      // 0 件が「試行していない」せいではない。
      expect(model.freshnessAttempts.length).toBeGreaterThanOrEqual(50);
      // 4 回目の preempt の cycle は 1,000 に始まり 1,240 に終わる。backoff はそこから。
      const backoffStartedAt = 1_240;
      expect(model.freshnessRuns.length).toBeGreaterThan(0);
      expect(model.freshnessRuns[0]!).toBeLessThanOrEqual(
        backoffStartedAt + 2 * 1_000,
      );
      // 60 s の cycle の数は有界で、止まってもいない（上限 3 + ⌈60 / 1⌉ 程度、下限は取り残しの検出）。
      expect(model.maintenanceStarts.length).toBeLessThanOrEqual(3 + 63);
      expect(model.maintenanceStarts.length).toBeGreaterThanOrEqual(45);
      // 最初の 4 回は 250 ms 周期、その後は slot＋1 s。
      expect(model.maintenanceStarts.slice(0, 5)).toEqual([
        250, 500, 750, 1_000, 2_240,
      ]);
    });
  });
});
