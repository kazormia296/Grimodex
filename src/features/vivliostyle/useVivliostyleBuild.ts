// ────────────────────────────────────────────────────────────────────
// ビルドの状態機械 hook。idle → running → done | error。
// イベント購読の生存管理（アンマウント/再実行時の解除）をここに閉じ込め、
// VivliostyleDialog を表示に専念させる。
// ────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { abortVivliostyleBuild, runVivliostyleBuild } from "./api";
import type { VivliostyleBuildFile, VivliostyleFormat } from "./types";

/** 保持するログ行数の上限（表示は末尾数行のみだが、無限成長を防ぐ）。 */
const MAX_LOG_LINES = 200;

export type VivliostyleBuildPhase =
  | { phase: "idle" }
  | { phase: "running"; runId: string }
  | { phase: "done"; outputToken: string }
  | { phase: "error"; message: string };

export function useVivliostyleBuild() {
  const [status, setStatus] = useState<VivliostyleBuildPhase>({
    phase: "idle",
  });
  const [logs, setLogs] = useState<string[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(null);

  // アンマウント時にリスナーを解除する（ビルド自体は継続し得るが購読は破棄）。
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (params: {
      files: VivliostyleBuildFile[];
      format: VivliostyleFormat;
      binaryPath?: string | null;
    }) => {
      // 前回 run の購読が残っていれば解除してから始める。
      cleanupRef.current?.();
      cleanupRef.current = null;
      setLogs([]);

      try {
        const { runId, cleanup } = await runVivliostyleBuild(params, {
          onLog: (e) => {
            setLogs((prev) => {
              const next = [...prev, e.line];
              return next.length > MAX_LOG_LINES
                ? next.slice(next.length - MAX_LOG_LINES)
                : next;
            });
          },
          onDone: (e) => {
            runIdRef.current = null;
            setStatus({ phase: "done", outputToken: e.outputToken });
          },
          onError: (e) => {
            runIdRef.current = null;
            setStatus({ phase: "error", message: e.message });
          },
        });
        cleanupRef.current = cleanup;
        runIdRef.current = runId;
        // done/error が invoke 解決より先に届いた場合は上書きしない
        // （updater の「Finished 先行発火」と同系の罠）。
        setStatus((s) =>
          s.phase === "done" || s.phase === "error"
            ? s
            : { phase: "running", runId },
        );
      } catch (e) {
        runIdRef.current = null;
        setStatus({
          phase: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [],
  );

  const abort = useCallback(async () => {
    const runId = runIdRef.current;
    runIdRef.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStatus({ phase: "idle" });
    if (runId) {
      try {
        await abortVivliostyleBuild(runId);
      } catch (e) {
        // 中止失敗（既に終了済み等）は UI 上 idle に戻す以上のことはしない。
        console.warn("vivliostyle abort failed", e);
      }
    }
  }, []);

  const reset = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    runIdRef.current = null;
    setStatus({ phase: "idle" });
    setLogs([]);
  }, []);

  return { status, logs, start, abort, reset };
}
