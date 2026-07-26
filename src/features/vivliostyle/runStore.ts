import { create } from "zustand";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  abortVivliostyleBuild,
  onVivliostylePreviewExited,
  runVivliostyleBuild,
  startVivliostylePreview,
  stopVivliostylePreview,
} from "./api";
import type { VivliostyleBuildFile, VivliostyleFormat } from "./types";

/**
 * runStore.ts — Vivliostyle ビルド/プレビュー実行状態のグローバル追跡。
 *
 * ExportDialog の「本の書き出し」タブはタブ切替で unmount されるため、
 * 状態をコンポーネントローカルに持つと隣のタブを一瞬見ただけで実行中
 * ビルドの進捗・中止手段・プレビューの停止手段が消える
 * （post-effect/runStore.ts と同じ教訓）。プロセスの生存は Rust 側が正
 * なので、FE 側の写像もグローバル store に置く。
 *
 * ビルドは同時 1 本（UI 上 running 中は開始ボタンが無効）。プレビューは
 * Rust 側 singleton なので runId を持たない。
 *
 * 終端状態（done/error）はアプリセッション中は保持する（タブ非表示中に
 * 完了したビルドの保存ボタンを、タブへ戻ったときに出すため）。次回の
 * startBuild が初期化する。ただしプロジェクトを跨いでは見せない —
 * build には開始時の projectId をタグ付けし、別プロジェクトでセクションを
 * 開いたときは resetBuild で破棄する（前プロジェクトの成果物を誤って
 * 保存させないため。post-effect runStore の projectId タグと同趣旨）。
 */

/** 保持するログ行数の上限（表示は末尾数行のみだが、無限成長を防ぐ）。 */
const MAX_LOG_LINES = 200;

export type VivliostyleBuildPhase =
  | { phase: "idle" }
  | { phase: "running"; runId: string }
  | { phase: "done"; outputToken: string }
  | { phase: "error"; message: string };

// ── モジュールスコープの実行時ハンドル（React ライフサイクル非依存）──
/** 進行中 run のイベント購読解除。done/error/中止/次回開始で破棄する。 */
let buildCleanup: (() => void) | null = null;
let buildRunId: string | null = null;
/** startBuild の invoke 解決前（= running 遷移前）の再入を弾くフラグ。 */
let buildStarting = false;
/** プレビュー自然終了イベントの購読（初回プレビュー開始時に一度だけ張る）。 */
let previewExitedUnlisten: (() => void) | null = null;
let previewExitedSubscribing = false;

function disposeBuildSubscription() {
  buildCleanup?.();
  buildCleanup = null;
  buildRunId = null;
}

async function ensurePreviewExitedSubscription() {
  if (previewExitedUnlisten || previewExitedSubscribing) return;
  previewExitedSubscribing = true;
  try {
    previewExitedUnlisten = await onVivliostylePreviewExited(() => {
      useVivliostyleRunStore.setState({ previewRunning: false });
    });
  } catch {
    // listen 失敗時は exited を検知できないだけ（stop は引き続き可能）
  } finally {
    previewExitedSubscribing = false;
  }
}

interface VivliostyleRunState {
  build: VivliostyleBuildPhase;
  /** build を開始したプロジェクト（idle のときは null）。 */
  buildProjectId: string | null;
  logs: string[];
  previewRunning: boolean;
  startBuild: (params: {
    files: VivliostyleBuildFile[];
    format: VivliostyleFormat;
    binaryPath?: string | null;
  }) => Promise<void>;
  abortBuild: () => Promise<void>;
  /**
   * ビルド状態を破棄する（実行中でも購読ごと破棄。プロセス自体は Rust 側で
   * 継続し得るが、UI からは追跡しない — 旧ダイアログの「開いた時リセット」
   * と同じ扱い）。プロジェクト切替後の stale 表示の掃除に使う。
   */
  resetBuild: () => void;
  startPreview: (params: {
    files: VivliostyleBuildFile[];
    binaryPath?: string | null;
  }) => Promise<void>;
  stopPreview: () => Promise<void>;
}

export const useVivliostyleRunStore = create<VivliostyleRunState>()(
  (set, get) => ({
    build: { phase: "idle" },
    buildProjectId: null,
    logs: [],
    previewRunning: false,

    startBuild: async (params) => {
      // 再入ガード: invoke（プロセス spawn 込み）解決までの窓での二度押しと、
      // running 中の呼び出しを弾く（二重 spawn + 購読リークの防止）。
      if (buildStarting || get().build.phase === "running") return;
      buildStarting = true;
      // 前回 run の購読・終端状態（done/error）が残っていれば破棄してから始める
      // （done を残したままだと下の「早着イベントを上書きしない」ガードが
      // 前回の done を今回の run の早着と誤認して running 表示にならない）。
      disposeBuildSubscription();
      set({
        logs: [],
        build: { phase: "idle" },
        buildProjectId: getCurrentProjectId(),
      });

      try {
        const { runId, cleanup } = await runVivliostyleBuild(params, {
          onLog: (e) => {
            set((s) => {
              const next = [...s.logs, e.line];
              return {
                logs:
                  next.length > MAX_LOG_LINES
                    ? next.slice(next.length - MAX_LOG_LINES)
                    : next,
              };
            });
          },
          onDone: (e) => {
            disposeBuildSubscription();
            set({ build: { phase: "done", outputToken: e.outputToken } });
          },
          onError: (e) => {
            disposeBuildSubscription();
            set({ build: { phase: "error", message: e.message } });
          },
        });
        buildCleanup = cleanup;
        buildRunId = runId;
        // done/error が invoke 解決より先に届いた場合は上書きしない
        // （updater の「Finished 先行発火」と同系の罠）。
        set((s) =>
          s.build.phase === "done" || s.build.phase === "error"
            ? s
            : { build: { phase: "running", runId } },
        );
      } catch (e) {
        disposeBuildSubscription();
        set({
          build: {
            phase: "error",
            message: e instanceof Error ? e.message : String(e),
          },
        });
      } finally {
        buildStarting = false;
      }
    },

    resetBuild: () => {
      disposeBuildSubscription();
      set({ build: { phase: "idle" }, buildProjectId: null, logs: [] });
    },

    abortBuild: async () => {
      const runId = buildRunId;
      disposeBuildSubscription();
      set({ build: { phase: "idle" }, buildProjectId: null });
      if (runId) {
        try {
          await abortVivliostyleBuild(runId);
        } catch (e) {
          // 中止失敗（既に終了済み等）は UI 上 idle に戻す以上のことはしない。
          console.warn("vivliostyle abort failed", e);
        }
      }
    },

    startPreview: async (params) => {
      await ensurePreviewExitedSubscription();
      // 即死クラッシュで exited イベントが invoke 解決より先に届く race でも
      // running が立ちっぱなしにならないよう、invoke 前に楽観的に立てて
      // 失敗時のみ戻す（この時点ではプロセス未 spawn なので exited は来ない。
      // updater の「Finished 先行発火」と同系の罠への対処）。
      set({ previewRunning: true });
      try {
        await startVivliostylePreview(params);
      } catch (e) {
        set({ previewRunning: false });
        throw e;
      }
    },

    stopPreview: async () => {
      set({ previewRunning: false });
      try {
        await stopVivliostylePreview();
      } catch (e) {
        // 停止失敗（既に終了済み等）は UI 上 idle に戻す以上のことはしない。
        console.warn("vivliostyle preview stop failed", e);
      }
    },
  }),
);

/** テスト用: 状態とモジュールスコープの購読ハンドルを初期化する。 */
export function resetVivliostyleRunStoreForTests() {
  disposeBuildSubscription();
  buildStarting = false;
  previewExitedUnlisten?.();
  previewExitedUnlisten = null;
  previewExitedSubscribing = false;
  useVivliostyleRunStore.setState({
    build: { phase: "idle" },
    buildProjectId: null,
    logs: [],
    previewRunning: false,
  });
}
