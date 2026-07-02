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

export function createAutoSave(
  saveFn: () => Promise<void>,
  delayMs: number,
): AutoSave {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let lastFailed = false;

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
      toast.error(i18next.t("autoSave.failed", { reason: rootCause(e) }));
    }
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
      await runSave("save");
    }, delayMs);
  }

  async function flush() {
    if (!pending) return;
    cancel();
    await runSave("flush");
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
    return () => {
      autoSaveRef.current?.flush();
    };
  }, []);

  return { schedule, cancel, flush };
}
