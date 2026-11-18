/**
 * モデル能力の写しの取得 scheduler（PR-C2）。起動・周期・single-flight・取消し・世代番号・終了を持つ。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §1.3（表 2 の A1〜A8）と §7。
 * 前例は `licenseValidation.ts`（前の cycle の完了から数える timer）。ただし license の `dispose` は終端で、
 * ここは「終端（quit）」と「再開できる停止（設定の無効化・profile の閉鎖）」を分ける。
 *
 * 規則：
 *   - 取得するのは「設定が有効」かつ「profile が unrestricted」のときだけ（Q2・Q4）。どちらかが崩れたら、
 *     走行中の取得を abort し、timer を全部解除し、世代番号を進める。取消し後に届いた結果は棄却する。
 *   - 起動は `start()` から初回の遅延 timer、以後は前の取得の完了から 24 時間ごと（Q3）。
 *   - 取得した本文は `parseSnapshot` を通し、前回の採用値（cache）と同梱の写しの両方に `compareSnapshots`
 *     を当てる。どちらかが拒否なら採用しない。cache は rename の直前の世代の確認を通ったときだけ書く。
 *   - `onProfileChanged` は `profileEgress.onStatusChange` の listener から呼ばれる。同期で、throw せず、
 *     file 操作を含めない（listener の throw は activation を fail closed にするため）。
 *   - log は固定の語と code と件数だけ。応答の本文・key・URL・error の message は出さない。
 *
 * 数値は全て暫定（2026-11-19）。実測後にユーザー確認する（Q10）。
 */
import {
  compareSnapshots,
  parseSnapshot,
  SNAPSHOT_POLICY,
  type SnapshotFinding,
  type SnapshotPolicy,
} from "../shared/modelCapabilityRegistry.js";
import {
  fetchModelCapabilityText,
  isRetryableFetchFailure,
  type FetchLike,
  type ModelCapabilityFetchTimers,
} from "./modelCapabilityFetch.js";
import {
  MODEL_CAPABILITY_ACCEPTED_SOURCE,
  type ModelCapabilityStore,
} from "./modelCapabilityStore.js";

/** 暫定値の 1 か所（試験は `schedule` で上書きする）。 */
export const MODEL_CAPABILITY_SCHEDULE = Object.freeze({
  /** 起動（`start()`）から初回の取得までの遅延。親の指定の暫定値。 */
  initialDelayMs: 30_000,
  /** 前の取得の完了から次の取得まで（Q3）。 */
  intervalMs: 24 * 60 * 60 * 1_000,
  /** 接続（応答の header が届くまで）の timeout。暫定。 */
  connectTimeoutMs: 10_000,
  /** 総時間（本文を読み切るまで）の timeout。暫定。 */
  totalTimeoutMs: 30_000,
  /** 1 回の周期の最大の試行回数（最初の 1 回を含む）。暫定。 */
  maxAttempts: 3,
  /** 試行の間の待ち（最後の値を使い回す）。暫定。 */
  retryDelaysMs: [30_000, 120_000] as readonly number[],
  /** 終了（dispose）が、走行中の取得の終了を待つ上限。超えても終了を止めない。暫定。 */
  quitWaitMs: 2_000,
});
export type ModelCapabilitySchedule = {
  -readonly [K in keyof typeof MODEL_CAPABILITY_SCHEDULE]: (typeof MODEL_CAPABILITY_SCHEDULE)[K];
};

export interface ModelCapabilitySchedulerDeps {
  readonly fetchImpl: FetchLike;
  readonly store: ModelCapabilityStore;
  readonly now: () => number;
  /** 「モデル情報の自動更新」の設定（Q4）。 */
  readonly isEnabled: () => boolean;
  /** profile が unrestricted か（restricted・activating・unavailable では false。Q2）。 */
  readonly isProfileOpen: () => boolean;
  readonly timers?: ModelCapabilityFetchTimers;
  readonly schedule?: Partial<ModelCapabilitySchedule>;
  readonly policy?: SnapshotPolicy;
  /** 固定の語と code と件数だけを受け取る。 */
  readonly log?: (message: string) => void;
}

export interface ModelCapabilityScheduler {
  /** ready の後に 1 回呼ぶ。設定が無効なら cache を削除する。 */
  start(): void;
  /** 設定の変更の後。無効なら取得を止めて cache を削除し、有効へ戻ったら初回の遅延から始める。 */
  onSettingChanged(): void;
  /** profile の状態の変更の後。同期で、throw せず、file 操作を含めない。 */
  onProfileChanged(): void;
  /**
   * 終端の停止（quit）。走行中の取得を abort し、終了を `quitWaitMs` まで待つ。reject しない。
   */
  dispose(): Promise<void>;
  /**
   * 取得を 1 回走らせる（single-flight：走行中なら同じ promise を返す）。main の内部と試験の入口で、
   * renderer へは出さない。閉じているときは何もしない。reject しない。
   */
  runCycle(): Promise<void>;
}

function summarize(findings: readonly SnapshotFinding[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(
      finding.code,
      (counts.get(finding.code) ?? 0) + (finding.count ?? 1),
    );
  }
  if (counts.size === 0) return "none";
  return [...counts].map(([code, count]) => `${code}=${count}`).join(",");
}

export function createModelCapabilityScheduler(
  deps: ModelCapabilitySchedulerDeps,
): ModelCapabilityScheduler {
  const schedule: ModelCapabilitySchedule = {
    ...MODEL_CAPABILITY_SCHEDULE,
    ...deps.schedule,
  };
  const policy = deps.policy ?? SNAPSHOT_POLICY;
  const timers: ModelCapabilityFetchTimers = deps.timers ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const log =
    deps.log ??
    ((message: string): void => console.log(`[model-capability] ${message}`));

  let generation = 0;
  let admitted = false;
  let started = false;
  let disposed = false;
  let timer: unknown = null;
  let wakeRetry: (() => void) | null = null;
  let active: {
    readonly gen: number;
    readonly controller: AbortController;
    readonly promise: Promise<void>;
  } | null = null;

  const allowed = (): boolean =>
    started && !disposed && deps.isEnabled() && deps.isProfileOpen();

  const clearTimer = (): void => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };

  const arm = (delayMs: number): void => {
    clearTimer();
    timer = timers.setTimeout(() => {
      timer = null;
      void runCycle();
    }, delayMs);
  };

  /** 再開できる停止。世代を進めるので、走行中の取得の結果は棄却される。同期で、file 操作を含めない。 */
  const closeAdmission = (): void => {
    generation += 1;
    admitted = false;
    clearTimer();
    active?.controller.abort();
    wakeRetry?.();
  };

  const openAdmission = (): void => {
    admitted = true;
    generation += 1;
    arm(schedule.initialDelayMs);
  };

  const reconcile = (): void => {
    if (allowed()) {
      if (!admitted) openAdmission();
    } else if (admitted) {
      closeAdmission();
    }
  };

  const purge = (): void => {
    try {
      deps.store.purgeCache();
    } catch {
      // 削除できなくても、無効の間の読出しは同梱の写しだけを返す。
    }
  };

  /** 試行の間の待ち。閉じられたら false。 */
  const sleep = (delayMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const handle = timers.setTimeout(() => {
        wakeRetry = null;
        resolve(true);
      }, delayMs);
      wakeRetry = () => {
        timers.clearTimeout(handle);
        wakeRetry = null;
        resolve(false);
      };
    });

  const adopt = (text: string, gen: number): void => {
    const nowMs = deps.now();
    const bundled = deps.store.loadBundled(nowMs);
    if (!bundled.ok) {
      log(`not adopted: bundled snapshot unavailable (${bundled.reason})`);
      return;
    }
    const parsed = parseSnapshot(text, policy, { nowMs });
    if (!parsed.ok) {
      log(
        `not adopted: invalid ${parsed.code} (findings ${summarize(parsed.findings)})`,
      );
      return;
    }
    // 取得元の刻印は "grimodex" だけ（T8）。直接取得の "models.dev" は選択肢が出るまで受けない。
    if (parsed.snapshot.source !== MODEL_CAPABILITY_ACCEPTED_SOURCE) {
      log("not adopted: unexpected source");
      return;
    }
    const againstBundled = compareSnapshots(
      bundled.snapshot,
      parsed.snapshot,
      policy,
    );
    if (!againstBundled.ok) {
      log(`not adopted: rejected against bundled ${againstBundled.code}`);
      return;
    }
    const findings: SnapshotFinding[] = [
      ...parsed.findings,
      ...againstBundled.findings,
    ];
    const cache = deps.store.readCache(nowMs);
    if (cache.ok) {
      const againstCache = compareSnapshots(
        cache.snapshot,
        parsed.snapshot,
        policy,
      );
      if (!againstCache.ok) {
        log(`not adopted: rejected against cache ${againstCache.code}`);
        return;
      }
      if (cache.digest === parsed.digest) {
        log("unchanged: same as the adopted cache");
        return;
      }
      findings.push(...againstCache.findings);
    } else if (bundled.digest === parsed.digest) {
      log("unchanged: same as the bundled snapshot");
      return;
    }
    const written = deps.store.writeCache(
      text,
      nowMs,
      () => gen === generation && allowed(),
    );
    if (written) {
      log(
        `adopted models=${Object.keys(parsed.snapshot.models).length} findings ${summarize(findings)}`,
      );
    } else {
      log("not written: the scheduler was closed");
    }
  };

  const cycle = async (gen: number, signal: AbortSignal): Promise<void> => {
    for (let attempt = 0; attempt < schedule.maxAttempts; attempt += 1) {
      if (gen !== generation || !allowed()) return;
      const result = await fetchModelCapabilityText({
        fetchImpl: deps.fetchImpl,
        timers,
        maxBytes: policy.maxSnapshotBytes,
        connectTimeoutMs: schedule.connectTimeoutMs,
        totalTimeoutMs: schedule.totalTimeoutMs,
        signal,
      });
      // 取消し後に届いた結果は棄却する（世代番号）。
      if (gen !== generation || !allowed()) return;
      if (result.ok) {
        try {
          adopt(result.text, gen);
        } catch {
          // 保存の失敗（disk 等）は、次の周期まで古い値を残す。理由の文言は出さない。
          log("not adopted: storage failure");
        }
        return;
      }
      if (result.code === "aborted") return;
      log(
        `fetch failed: ${result.code} (attempt ${attempt + 1}/${schedule.maxAttempts})`,
      );
      if (
        !isRetryableFetchFailure(result.code) ||
        attempt + 1 >= schedule.maxAttempts
      ) {
        return;
      }
      const delay =
        schedule.retryDelaysMs[
          Math.min(attempt, schedule.retryDelaysMs.length - 1)
        ] ?? schedule.intervalMs;
      if (!(await sleep(delay))) return;
    }
  };

  function runCycle(): Promise<void> {
    if (active !== null) {
      // single-flight：走行中なら同じ promise を返す。
      if (active.gen === generation) return active.promise;
      // 閉じられた周期（abort 済み）が settle するまで待ってから始める。reject しない。
      return active.promise.then(() => runCycle());
    }
    if (!allowed()) return Promise.resolve();
    const gen = generation;
    const controller = new AbortController();
    const promise: Promise<void> = cycle(gen, controller.signal)
      .catch(() => {
        log("cycle failed");
      })
      .finally(() => {
        if (active?.promise === promise) active = null;
        // 前の取得の完了から数える（Q3）。閉じられた周期は再 arm しない。
        if (gen === generation && admitted && !disposed) {
          arm(schedule.intervalMs);
        }
      });
    active = { gen, controller, promise };
    return promise;
  }

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      if (!deps.isEnabled()) purge();
      reconcile();
    },

    onSettingChanged(): void {
      if (disposed) return;
      try {
        reconcile();
      } catch {
        // 設定の保存の往復を、scheduler の失敗で止めない。
      }
      if (!deps.isEnabled()) purge();
    },

    onProfileChanged(): void {
      if (disposed) return;
      try {
        reconcile();
      } catch {
        // listener の throw は activation を fail closed にする。ここでは決して投げない。
      }
    },

    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      disposed = true;
      const pending = active?.promise ?? null;
      closeAdmission();
      if (pending === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const handle = timers.setTimeout(resolve, schedule.quitWaitMs);
        void pending.then(() => {
          timers.clearTimeout(handle);
          resolve();
        });
      });
    },

    runCycle,
  };
}
