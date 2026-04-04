import { useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";

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
      try {
        await saveFn();
      } catch (e) {
        const detail = errorDetail(e);
        debugLog.error("AutoSave", "save failed", detail);
        toast.error(
          `自動保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }, delayMs);
  }

  async function flush() {
    if (!pending) return;
    cancel();
    try {
      await saveFn();
    } catch (e) {
      const detail = errorDetail(e);
      debugLog.error("AutoSave", "flush failed", detail);
      toast.error(
        `自動保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
