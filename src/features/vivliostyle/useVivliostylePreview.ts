// ────────────────────────────────────────────────────────────────────
// プレビューの状態機械 hook。running ⇄ idle の 2 状態。
// プレビュープロセスは Rust 側 singleton なので runId は持たない。
//
// ダイアログを閉じてもプレビューは止めない: プロセスの生死は Rust 側が
// 管理し、この hook はアンマウント時にイベント購読を解除するだけ。
// （再マウント時は idle から始まるが、再度プレビューを押せば Rust 側が
// 旧プロセスを kill して置き換えるので整合は保たれる。）
// ────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  onVivliostylePreviewExited,
  startVivliostylePreview,
  stopVivliostylePreview,
} from "./api";
import type { VivliostyleBuildFile } from "./types";

export function useVivliostylePreview() {
  const [running, setRunning] = useState(false);

  // 自然終了（ユーザーがプレビューウィンドウを閉じた等）の購読。
  // アンマウント時に解除する（購読解除はプロセスを止めない）。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onVivliostylePreviewExited(() => setRunning(false))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {
        /* listen 失敗時は exited を検知できないだけ（stop は引き続き可能） */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const start = useCallback(
    async (params: {
      files: VivliostyleBuildFile[];
      binaryPath?: string | null;
    }) => {
      // 即死クラッシュで exited イベントが invoke 解決より先に届く race でも
      // running が立ちっぱなしにならないよう、invoke 前に楽観的に立てて
      // 失敗時のみ戻す（この時点ではプロセス未 spawn なので exited は来ない。
      // updater の「Finished 先行発火」と同系の罠への対処）。
      setRunning(true);
      try {
        await startVivliostylePreview(params);
      } catch (e) {
        setRunning(false);
        throw e;
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    setRunning(false);
    try {
      await stopVivliostylePreview();
    } catch (e) {
      // 停止失敗（既に終了済み等）は UI 上 idle に戻す以上のことはしない。
      console.warn("vivliostyle preview stop failed", e);
    }
  }, []);

  return { running, start, stop };
}
