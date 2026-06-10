import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import { useLicenseStore } from "./store";
import type { LicenseStateDto } from "./types";

/**
 * Rust のバックグラウンド validate（設計書 §5.4）が emit する
 * `license:state_changed` を store へ反映する。App で単一マウント。
 * external-mount の listener と同じ cancelled フラグ定石。
 */
export function useLicenseStateListener() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    // イベントは validate 試行後にのみ届く — license_stale なら「確認済み」
    // として制限を発動させる（§3 前方ジャンプ対策の確認経路）。
    void listen<LicenseStateDto>("license:state_changed", (payload) => {
      useLicenseStore.getState().applyValidatedState(payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // listen 失敗は fail-soft（store は get_license_state の初期値のまま）
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
