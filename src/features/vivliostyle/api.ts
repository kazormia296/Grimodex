/**
 * api.ts — Vivliostyle CLI 連携の Tauri コマンド/イベントラッパー。
 * 流儀は post-effect/api.ts（listen ラッパー + 購読一括起動）に合わせる。
 */

import { invoke, listen } from "@/lib/tauri";
import type {
  VivliostyleBuildFile,
  VivliostyleDetectResult,
  VivliostyleDoneEvent,
  VivliostyleErrorEvent,
  VivliostyleFormat,
  VivliostyleLogEvent,
} from "./types";

// ---------------------------------------------------------------------------
// invoke ラッパー
// ---------------------------------------------------------------------------

/** PATH 上の Vivliostyle CLI を検出する。null = 未検出。 */
export async function detectVivliostyle(): Promise<VivliostyleDetectResult | null> {
  return invoke<VivliostyleDetectResult | null>("vivliostyle_detect");
}

/** ビルドを起動し runId を即返しする（進捗/完了はイベントで届く）。 */
export async function startVivliostyleBuild(params: {
  files: VivliostyleBuildFile[];
  format: VivliostyleFormat;
  binaryPath?: string | null;
}): Promise<string> {
  return invoke<string>("vivliostyle_build", {
    files: params.files,
    format: params.format,
    binaryPath: params.binaryPath ?? null,
  });
}

/** 実行中ビルドを中止する。 */
export async function abortVivliostyleBuild(runId: string): Promise<void> {
  return invoke<void>("vivliostyle_abort_build", { runId });
}

/**
 * done イベントの outputToken を渡して保存ダイアログを開き成果物を保存する。
 * 戻り値は保存先パス、ユーザーキャンセル時は null。
 */
export async function saveVivliostyleOutput(
  outputToken: string,
): Promise<string | null> {
  return invoke<string | null>("vivliostyle_save_output", { outputToken });
}

// ---------------------------------------------------------------------------
// イベント購読ラッパー
// ---------------------------------------------------------------------------

export async function onVivliostyleLog(
  handler: (e: VivliostyleLogEvent) => void,
): Promise<() => void> {
  return listen<VivliostyleLogEvent>("vivliostyle:log", handler);
}

export async function onVivliostyleDone(
  handler: (e: VivliostyleDoneEvent) => void,
): Promise<() => void> {
  return listen<VivliostyleDoneEvent>("vivliostyle:done", handler);
}

export async function onVivliostyleError(
  handler: (e: VivliostyleErrorEvent) => void,
): Promise<() => void> {
  return listen<VivliostyleErrorEvent>("vivliostyle:error", handler);
}

// ---------------------------------------------------------------------------
// Convenience: 起動 + 購読を一括で行う（runPostEffect と同じ自動 cleanup 仕様）
// ---------------------------------------------------------------------------

export interface VivliostyleBuildCallbacks {
  onLog?: (e: VivliostyleLogEvent) => void;
  onDone?: (e: VivliostyleDoneEvent) => void;
  onError?: (e: VivliostyleErrorEvent) => void;
}

/**
 * vivliostyle_build を起動し、runId でフィルタしたイベント購読を設定する。
 *
 * ## runId フィルタとバッファリング
 * listen 登録 → invoke 解決の間に届いたイベントは runId 未確定のため一旦
 * バッファし、runId 確定後にフィルタして flush する（早すぎる done の取り
 * こぼし対策。post-effect の TDZ race と同系の罠）。前回 run の残骸イベント
 * は runId 不一致で破棄される。
 *
 * ## 自動 cleanup
 * done / error 受信時に全リスナーを自動解除する。返り値の cleanup は
 * 中止・アンマウント時の早期解除用。
 */
export async function runVivliostyleBuild(
  params: {
    files: VivliostyleBuildFile[];
    format: VivliostyleFormat;
    binaryPath?: string | null;
  },
  callbacks: VivliostyleBuildCallbacks,
): Promise<{ runId: string; cleanup: () => void }> {
  const unlisteners: Array<() => void> = [];
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const u of unlisteners) {
      try {
        u();
      } catch {
        /* listen 解除失敗は無視 */
      }
    }
  };

  let runId: string | null = null;
  const pending: Array<() => void> = [];

  // runId 確定前はバッファ、確定後は一致するイベントのみ dispatch する。
  const gated =
    <T extends { runId: string }>(fn: (e: T) => void) =>
    (e: T) => {
      const dispatch = () => {
        if (e.runId === runId) fn(e);
      };
      if (runId === null) {
        pending.push(dispatch);
      } else {
        dispatch();
      }
    };

  const wrapTerminal =
    <T extends { runId: string }>(fn: ((e: T) => void) | undefined) =>
    (e: T) => {
      try {
        fn?.(e);
      } catch (err) {
        console.error("vivliostyle terminal handler error", err);
      } finally {
        cleanup();
      }
    };

  const registered = await Promise.all([
    callbacks.onLog
      ? onVivliostyleLog(gated(callbacks.onLog))
      : Promise.resolve(() => {}),
    onVivliostyleDone(gated(wrapTerminal(callbacks.onDone))),
    onVivliostyleError(gated(wrapTerminal(callbacks.onError))),
  ]);
  unlisteners.push(...registered);

  try {
    const id = await startVivliostyleBuild(params);
    runId = id;
    // runId 確定前に届いたイベントを（フィルタ付きで）順に流す。
    for (const dispatch of pending.splice(0)) dispatch();
    return { runId: id, cleanup };
  } catch (e) {
    cleanup(); // 起動自体が失敗したらリスナーをリークさせない
    throw e;
  }
}
