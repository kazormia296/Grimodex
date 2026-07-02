import { useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { announce } from "@/lib/a11y/announcer";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";

export interface AutoSave {
  schedule: () => void;
  cancel: () => void;
  flush: () => Promise<void>;
}

/**
 * 生存中の AutoSave インスタンスの registry。workspace 切替 (open_workspace)
 * の直前に、マウント中の全エディタ/パネルの未保存 debounce を強制 flush する
 * ため (quiesce)。DB コマンドの async 化 (M3) で切替と save が並行しうるため、
 * 切替前に書き込みを静止させないと旧 workspace 向けの save が新 workspace の
 * DB に落ちる。
 */
const activeAutoSaves = new Set<AutoSave>();

/** useAutoSave がマウント時に登録する。戻り値は登録解除関数。 */
export function registerAutoSaveForQuiesce(instance: AutoSave): () => void {
  activeAutoSaves.add(instance);
  return () => {
    activeAutoSaves.delete(instance);
  };
}

/**
 * 生存中の全 AutoSave の pending save を flush して完了を待つ。
 * flush は内部でエラーを握って toast 表示する (reject しない) ので、
 * ここでの失敗は「保存失敗 toast + dirty 維持」として既存フローに乗る。
 */
export async function flushAllAutoSaves(): Promise<void> {
  await Promise.all([...activeAutoSaves].map((autoSave) => autoSave.flush()));
}

export function createAutoSave(
  saveFn: () => Promise<void>,
  delayMs: number,
): AutoSave {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let lastFailed = false;
  /**
   * 実行中の runSave。flush はこれも待つ — pending の debounce だけ見ると
   * 「直近オートセーブがまさに実行中」の save (切替直前に最も高確率で存在
   * する) をすり抜け、workspace 切替 quiesce が in-flight write を取り残す
   * (M3 review I2)。
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
      // workspace 切替中の明示拒否 (Rust with_db の WORKSPACE_SWITCHING) は
      // 生メッセージではなく i18n 済みの短い文言で知らせる。dirty は維持され、
      // 次の入力/スケジュールでリトライされる。
      if (detail.includes("WORKSPACE_SWITCHING")) {
        toast.error(i18next.t("autoSave.workspaceSwitching"));
      } else {
        toast.error(i18next.t("autoSave.failed", { reason: rootCause(e) }));
      }
    }
  }

  function startSave(label: "save" | "flush"): Promise<void> {
    const run = runSave(label).finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  }

  function cancel() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    pending = false;
  }

  function schedule() {
    cancel();
    pending = true;
    timerId = setTimeout(async () => {
      timerId = null;
      pending = false;
      await startSave("save");
    }, delayMs);
  }

  async function flush() {
    // 実行中の save があれば先に完了を待つ (runSave はエラーを内部処理する
    // ので reject しない)。その後に pending の debounce を即時実行する。
    const running = inFlight;
    if (running) await running;
    if (!pending) return;
    cancel();
    await startSave("flush");
  }

  return { schedule, cancel, flush };
}

export function useAutoSave(
  saveFn: () => Promise<void>,
  delayMs = 2000,
): AutoSave {
  const autoSaveRef = useRef<AutoSave | null>(null);

  if (autoSaveRef.current === null) {
    autoSaveRef.current = createAutoSave(saveFn, delayMs);
  }

  const schedule = useCallback(() => {
    autoSaveRef.current?.schedule();
  }, []);

  const cancel = useCallback(() => {
    autoSaveRef.current?.cancel();
  }, []);

  const flush = useCallback(async () => {
    await autoSaveRef.current?.flush();
  }, []);

  useEffect(() => {
    const instance = autoSaveRef.current;
    const unregister = instance ? registerAutoSaveForQuiesce(instance) : null;
    return () => {
      unregister?.();
      instance?.flush();
    };
  }, []);

  return { schedule, cancel, flush };
}
