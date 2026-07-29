import { useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { announce } from "@/lib/a11y/announcer";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import { isWorkspaceSwitchingError } from "@/features/concurrency/workspaceSwitching";
import { AlreadyNotifiedSaveError } from "@/features/editor/document/saveErrors";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import {
  documentIdFromKey,
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import {
  cancelEditorAnalysisTask,
  scheduleEditorAnalysisTask,
} from "@/lib/editorAnalysisScheduler";
export { AlreadyNotifiedSaveError } from "@/features/editor/document/saveErrors";

export interface AutoSave {
  /**
   * Queues a new user mutation. Returns false while a destructive lifecycle
   * lease is active; already-pending persistence remains drainable by flush().
   */
  schedule: () => boolean;
  cancel: () => void;
  /**
   * Stop background persistence without discarding the queued edit. Explicit
   * quiesce fails while a paused edit exists, so workspace switching cannot
   * silently abandon a conflict-staged buffer.
   */
  pause: () => void;
  resume: () => void;
  flush: () => Promise<void>;
  setDelay: (delayMs: number) => void;
}

export interface AutoSaveLifecycle {
  /** Effect setup, including React StrictMode's post-cleanup reactivation. */
  onActivate?: () => void;
  /** Runs synchronously before the unmount flush starts. */
  onRetire?: () => void;
  /** Exact persistence target used by explicit per-document discard. */
  documentKey?: () => DocumentKey | null;
}

/**
 * 生存中の AutoSave インスタンスの registry。workspace 切替 (open_workspace)
 * の直前に、マウント中の全エディタ/パネルの未保存 debounce を強制 flush する
 * ため (quiesce)。DB コマンドの async 化 (M3) で切替と save が並行しうるため、
 * 切替前に書き込みを静止させないと旧 workspace 向けの save が新 workspace の
 * DB に落ちる。
 */
const activeAutoSaves = new Map<AutoSave, number>();
const retiringAutoSaves = new Map<AutoSave, Set<() => void>>();
const autoSaveDocumentKeyProviders = new WeakMap<
  AutoSave,
  () => DocumentKey | null
>();
let autoSaveRegistryRevision = 0;
const MAX_REGISTRY_DRAIN_ROUNDS = 50;

function markAutoSaveRegistryChanged(): void {
  autoSaveRegistryRevision++;
}

function finalizeRetiringAutoSave(instance: AutoSave): void {
  const unregisters = retiringAutoSaves.get(instance);
  if (!unregisters) return;
  retiringAutoSaves.delete(instance);
  markAutoSaveRegistryChanged();
  for (const unregister of unregisters) unregister();
}

/** useAutoSave がマウント時に登録する。戻り値は登録解除関数。 */
export function registerAutoSaveForQuiesce(instance: AutoSave): () => void {
  activeAutoSaves.set(instance, (activeAutoSaves.get(instance) ?? 0) + 1);
  markAutoSaveRegistryChanged();
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const remaining = (activeAutoSaves.get(instance) ?? 1) - 1;
    if (remaining > 0) activeAutoSaves.set(instance, remaining);
    else activeAutoSaves.delete(instance);
    markAutoSaveRegistryChanged();
  };
}

/**
 * 生存中の全 AutoSave の pending save を flush して完了を待つ。
 * 通常の background save は失敗を toast で通知して未処理 reject を出さないが、
 * workspace 切替前の明示的な flush は失敗を呼び出し元へ伝播する。1 件でも
 * 永続化できなければ切替側が native swap を中断できる。
 */
async function flushMatchingAutoSaves(
  matches: (documentKey: DocumentKey | null) => boolean,
): Promise<void> {
  const failures: unknown[] = [];
  const failedInstances = new Set<AutoSave>();

  for (let round = 0; round < MAX_REGISTRY_DRAIN_ROUNDS; round++) {
    const revisionAtStart = autoSaveRegistryRevision;
    const instances = new Set([
      ...activeAutoSaves.keys(),
      ...retiringAutoSaves.keys(),
    ]);
    const candidates = [...instances].filter((instance) => {
      if (failedInstances.has(instance)) return false;
      let documentKey: DocumentKey | null;
      try {
        documentKey = autoSaveDocumentKeyProviders.get(instance)?.() ?? null;
      } catch {
        // A detached editor whose identity getter broke may still own stale
        // manuscript content. Conservatively drain it for scoped boundaries;
        // ordinary non-editor AutoSaves return null without throwing.
        return true;
      }
      return matches(documentKey);
    });
    const results = await Promise.allSettled(
      candidates.map(async (autoSave) => {
        await autoSave.flush();
        finalizeRetiringAutoSave(autoSave);
      }),
    );
    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const instance = candidates[index];
      if (instance) failedInstances.add(instance);
      failures.push(result.reason);
    });

    // Mount/StrictMode/virtualization cleanup may mutate the registry while
    // an earlier snapshot is awaiting persistence. Re-snapshot until one full
    // round observes no registration/retirement/finalization changes.
    if (autoSaveRegistryRevision !== revisionAtStart) continue;
    if (failures.length > 0) {
      const message =
        failures.length === 1 && failures[0] instanceof Error
          ? failures[0].message
          : "One or more AutoSave flushes failed";
      throw new AggregateError(failures, message);
    }
    return;
  }

  throw new Error("AutoSave registry did not reach quiescence");
}

export async function flushAllAutoSaves(): Promise<void> {
  await flushMatchingAutoSaves(() => true);
}

/** Drain active and retiring AutoSaves for every variant of one entity. */
export async function flushAutoSavesForEntity(
  kind: DocumentKey["kind"],
  documentId: string,
): Promise<void> {
  await flushMatchingAutoSaves(
    (key) => key?.kind === kind && documentIdFromKey(key) === documentId,
  );
}

/** Drain active and retiring AutoSaves of one document kind. */
export async function flushAutoSavesForKind(
  kind: DocumentKey["kind"],
): Promise<void> {
  await flushMatchingAutoSaves((key) => key?.kind === kind);
}

/** Explicit destructive lifecycle path used only after user confirmation. */
export function discardAllAutoSaves(): void {
  const instances = new Set([
    ...activeAutoSaves.keys(),
    ...retiringAutoSaves.keys(),
  ]);
  for (const autoSave of instances) {
    autoSave.cancel();
    finalizeRetiringAutoSave(autoSave);
  }
}

/**
 * Explicitly abandon pending/failed AutoSave work for one exact document.
 *
 * Retiring instances remain in the global registry after an unmount failure
 * even though their component-level discard handler is gone. Keeping this
 * document-key provider beside the AutoSave closes that gap for an external
 * Reload choice without touching drafts for other scenes.
 */
export function discardAutoSavesForDocument(documentKey: DocumentKey): void {
  const target = encodeDocumentKey(documentKey);
  const instances = new Set([
    ...activeAutoSaves.keys(),
    ...retiringAutoSaves.keys(),
  ]);
  for (const autoSave of instances) {
    let current: DocumentKey | null = null;
    try {
      current = autoSaveDocumentKeyProviders.get(autoSave)?.() ?? null;
    } catch {
      // A destroyed component getter cannot identify this instance. Leave it
      // to global recovery rather than discarding an uncertain target.
    }
    if (!current || encodeDocumentKey(current) !== target) continue;
    autoSave.cancel();
    finalizeRetiringAutoSave(autoSave);
  }
}

registerQuiescenceProvider({
  id: "mounted-auto-saves",
  stage: "autosave",
  flush: flushAllAutoSaves,
  discard: discardAllAutoSaves,
});

const MAX_DRAIN_RUNS = 20;
let nextAutoSaveSchedulerId = 0;

function normalizeDelay(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

export function createAutoSave(
  saveFn: () => Promise<void>,
  initialDelayMs: number,
): AutoSave {
  const schedulerKey = `autosave:${nextAutoSaveSchedulerId++}`;
  let timerArmed = false;
  let delayMs = normalizeDelay(initialDelayMs);
  let pending = false;
  let lastFailed = false;
  let paused = false;
  /**
   * AutoSave instance ごとの単一 drain。saveFn 自体はこの loop からしか呼ばず、
   * 実行中の schedule は pending=true へ畳み込む。これにより古い save が新しい
   * save より後に完了する並行 write と、単一 inFlight slot の上書きを防ぐ。
   */
  let inFlight: Promise<void> | null = null;

  // 自動保存は数秒おきに発火するため、成功を毎回読み上げると SR 利用者の
  // 執筆を妨げる。失敗 → 成功の回復時のみ announce する (失敗時は Sonner の
  // toast が読み上げるので announce しない: 二重読み上げ防止)。
  async function runSave(label: "save" | "flush") {
    try {
      await saveFn();
      if (lastFailed) {
        lastFailed = false;
        announce(i18next.t("autoSave.recovered"));
      }
    } catch (e) {
      lastFailed = true;
      const detail = errorDetail(e);
      debugLog.error("AutoSave", `${label} failed`, detail);
      // 発生源で通知済みの失敗はトーストを重ねない (二重通知防止)。
      // workspace 切替中の明示拒否 (Rust with_db の WORKSPACE_SWITCHING) は
      // 生メッセージではなく i18n 済みの短い文言で知らせる。dirty は維持され、
      // 次の入力/スケジュールでリトライされる。
      if (e instanceof AlreadyNotifiedSaveError) {
        // 通知済み: toast なし (debugLog / lastFailed / 回復 announce は通常どおり)
      } else if (isWorkspaceSwitchingError(e)) {
        toast.error(i18next.t("autoSave.workspaceSwitching"));
      } else {
        toast.error(i18next.t("autoSave.failed", { reason: rootCause(e) }));
      }
      // background caller は catch して未処理 reject を防ぐ。flush caller には
      // 同じ失敗を伝播し、workspace 切替や手動保存を成功扱いさせない。
      throw e;
    }
  }

  async function drain(label: "save" | "flush"): Promise<void> {
    let runs = 0;
    while (pending) {
      // A conflict can arrive while the preceding write is in flight. Keep
      // the coalesced follow-up queued until the user explicitly resolves it;
      // scene saves do not use OCC, so running that follow-up would otherwise
      // overwrite the external change while the conflict banner is visible.
      if (paused) return;
      if (runs >= MAX_DRAIN_RUNS) {
        const error = new Error("AutoSave queue did not reach quiescence");
        lastFailed = true;
        // この drain 自身が処理しきれなかった pathological rerun はここで
        // 停止する。明示 flush は lastFailed を見て再試行できるが、background
        // timer が無限に再武装されることはない。
        pending = false;
        debugLog.warn(
          "AutoSave",
          `drain reached its ${MAX_DRAIN_RUNS}-run cap; quiescence failed`,
        );
        throw error;
      }
      runs++;
      // schedule が saveFn の await 中に来れば再び true になり、成功後に最新
      // snapshot をもう 1 回保存する。失敗時は runSave が reject し、次の
      // schedule / flush まで自動再試行しない。
      pending = false;
      await runSave(label);
    }
  }

  function startDrain(label: "save" | "flush"): Promise<void> {
    if (inFlight) return inFlight;
    // drain の開始を microtask へ送ってから inFlight を公開する。saveFn が
    // 同期的に schedule しても「idle」と誤認して timer を作らない。
    const run = Promise.resolve()
      .then(() => drain(label))
      .finally(() => {
        if (inFlight !== run) return;
        inFlight = null;
        // drain の終了判定と finally の間に schedule が入る競合でも request を
        // 失わない。flush 待機中なら flush 側がこの timer を消して即時 drain
        // し、background なら通常どおり debounce する。
        if (pending && !timerArmed) armTimer();
      });
    inFlight = run;
    return run;
  }

  function clearTimer() {
    if (!timerArmed) return;
    cancelEditorAnalysisTask(schedulerKey);
    timerArmed = false;
  }

  function armTimer() {
    clearTimer();
    if (paused) return;
    timerArmed = true;
    scheduleEditorAnalysisTask({
      key: schedulerKey,
      kind: "save",
      delayMs,
      run: async () => {
        timerArmed = false;
        // runSave が toast / debugLog を担当済み。共有 scheduler も reject を
        // 終端するため、background debounce は Global unhandled rejection に
        // ならない。
        await startDrain("save");
      },
    });
  }

  function cancel() {
    clearTimer();
    pending = false;
    lastFailed = false;
  }

  function pause() {
    paused = true;
    clearTimer();
  }

  function resume() {
    if (!paused) return;
    paused = false;
    if (pending && !inFlight) armTimer();
  }

  function schedule(): boolean {
    if (!canScheduleQuiescenceMutation()) return false;
    clearTimer();
    pending = true;
    // 実行中なら drain が pending を観測して直列 rerun する。別 timer を
    // 作らないため saveFn は決して並行しない。
    if (!inFlight && !paused) armTimer();
    return true;
  }

  function setDelay(nextDelayMs: number) {
    delayMs = normalizeDelay(nextDelayMs);
    // 設定変更時点から新しい delay で再武装する。実行中の rerun request は
    // 現在の drain が直列に処理するため timer は不要。
    if (timerArmed && pending && !inFlight) armTimer();
  }

  async function flush() {
    clearTimer();
    for (;;) {
      const running = inFlight;
      if (running) {
        // background drain の失敗もここで reject し、quiesce callerへ伝える。
        await running;
        clearTimer();
        continue;
      }
      if (paused && (pending || lastFailed)) {
        throw new AlreadyNotifiedSaveError(
          "AutoSave is paused by an unresolved external edit conflict",
        );
      }
      if (!pending && !lastFailed) return;
      // 直前の background save が失敗して未保存のままなら、明示 flush で
      // 1 回再試行する。再失敗は runSave からそのまま伝播する。
      if (!pending && lastFailed) pending = true;
      clearTimer();
      await startDrain("flush");
    }
  }

  return { schedule, cancel, pause, resume, flush, setDelay };
}

export function useAutoSave(
  saveFn: () => Promise<void>,
  delayMs = 2000,
  lifecycle?: AutoSaveLifecycle,
): AutoSave {
  const autoSaveRef = useRef<AutoSave | null>(null);
  const latestSaveFnRef = useRef(saveFn);
  const lifecycleRef = useRef(lifecycle);
  latestSaveFnRef.current = saveFn;
  lifecycleRef.current = lifecycle;

  if (autoSaveRef.current === null) {
    autoSaveRef.current = createAutoSave(
      () => latestSaveFnRef.current(),
      delayMs,
    );
  }
  autoSaveDocumentKeyProviders.set(
    autoSaveRef.current,
    () => lifecycleRef.current?.documentKey?.() ?? null,
  );

  const schedule = useCallback((): boolean => {
    return autoSaveRef.current?.schedule() ?? false;
  }, []);

  const cancel = useCallback(() => {
    autoSaveRef.current?.cancel();
  }, []);

  const pause = useCallback(() => {
    autoSaveRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    autoSaveRef.current?.resume();
  }, []);

  const flush = useCallback(async () => {
    await autoSaveRef.current?.flush();
  }, []);

  const setDelay = useCallback((nextDelayMs: number) => {
    autoSaveRef.current?.setDelay(nextDelayMs);
  }, []);

  useEffect(() => {
    setDelay(delayMs);
  }, [delayMs, setDelay]);

  useEffect(() => {
    const instance = autoSaveRef.current;
    lifecycleRef.current?.onActivate?.();
    const unregister = instance ? registerAutoSaveForQuiesce(instance) : null;
    return () => {
      // A retiring document save session must freeze its freshness boundary
      // before flush() can invoke the detached editor closure.
      lifecycleRef.current?.onRetire?.();
      // unmount cleanup は background lifecycle。失敗通知は runSave の toast
      // 契約に任せ、reject は終端して未処理 Promise にしない。flush が完了
      // するまでは registry に残し、直後の workspace 切替がこの書き込みを
      // 待てるようにする。
      if (!instance) {
        unregister?.();
        return;
      }
      const existingUnregisters = retiringAutoSaves.get(instance);
      const unregisters = existingUnregisters ?? new Set();
      const previousSize = unregisters.size;
      if (unregister) unregisters.add(unregister);
      retiringAutoSaves.set(instance, unregisters);
      if (!existingUnregisters || unregisters.size !== previousSize) {
        markAutoSaveRegistryChanged();
      }
      void instance
        .flush()
        .then(() => finalizeRetiringAutoSave(instance))
        .catch(() => {
          // Keep the detached instance registered after a failed flush. It
          // retains the editor snapshot and `lastFailed`, so a later workspace
          // quiesce can retry instead of losing an edit whose component has
          // already unmounted.
        });
    };
  }, []);

  return { schedule, cancel, pause, resume, flush, setDelay };
}
