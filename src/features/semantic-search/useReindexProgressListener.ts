import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import {
  useReindexProgressStore,
  type ReindexProgressPayload,
} from "./reindexProgressStore";

const EVENT_NAME = "semantic:reindex_progress";

/**
 * Rust 側 `semantic_reindex_all` が emit する progress event を購読し、
 * `reindexProgressStore` に流し込む。App.tsx に 1 度だけマウントする想定。
 *
 * Tauri 未起動環境 (browser-mock) では listen は CustomEvent fallback に
 * 落ちるが、本機能は実機でしか走らせないので問題ない。
 */
export function useReindexProgressListener(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<ReindexProgressPayload>(EVENT_NAME, (payload) => {
      // payload が undefined になる経路 (custom event の detail 不在) は
      // 安全に無視する。
      if (!payload) return;
      useReindexProgressStore.getState().setProgress(payload);
    }).then((stop) => {
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
