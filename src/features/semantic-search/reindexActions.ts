import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { semanticReindexAll } from "./api";
import {
  createReindexRunId,
  useReindexProgressStore,
} from "./reindexProgressStore";
import {
  captureCurrentSemanticScope,
  ensureSemanticIndexesOnOpen,
  isSemanticScopeCurrent,
  resetIndexGuards,
} from "./autoIndex";

/**
 * 意味検索インデックス（シーン）の全件再構築。多重起動は reindexProgressStore の
 * running で相互排他。進行状況は Rust progress event → ReindexProgressToast が表示。
 * 設定 Data タブの「再構築」ボタンから使う共通導線（コンポーネント外でも呼べるよう
 * i18next を直接使う）。
 */
export async function runSemanticReindex(): Promise<void> {
  const scope = captureCurrentSemanticScope();
  if (!scope) return;
  const runId = createReindexRunId();
  if (
    !useReindexProgressStore
      .getState()
      .begin(
        scope.workspaceKey,
        scope.workspaceOpenRevision,
        scope.projectId,
        runId,
      )
  ) {
    return;
  }
  try {
    const chunks = await semanticReindexAll(scope.projectId, runId);
    if (!isSemanticScopeCurrent(scope)) return;
    toast.success(
      i18next.t("settings.project.semanticReindexDone", {
        defaultValue: "インデックスを再構築しました（{{count}} チャンク）",
        count: chunks,
      }),
    );
  } catch (e) {
    // A の遅延失敗で B の progress を消さないよう token 一致時だけ fail。
    useReindexProgressStore.getState().fail(runId);
    if (!isSemanticScopeCurrent(scope)) return;
    toast.error(
      i18next.t(
        "settings.project.semanticReindexFailed",
        "インデックスの再構築に失敗しました",
      ),
    );
    console.error("[semanticReindex]", e);
  } finally {
    useReindexProgressStore.getState().finish(runId);
  }
}

/**
 * 執筆言語が変わったとき（A案ハイブリッド）に呼ぶ。
 * - 埋め込みモデル/次元/チャンカ仕様が変わり既存チャンクは全 stale になる。
 * - **トグル時点では重い処理を走らせない**（誤操作トグルで DL/再構築が始まる驚きを避ける）。
 *   代わりに 1セッションガードを解除し、次の open / モデル DL 完了 / 下記トースト操作で
 *   再インデックスが走れるようにする。
 * - すぐ直したい人向けに、ワンクリックの確認トーストを出す。押すと
 *   `ensureSemanticIndexesOnOpen`（モデル DL＋codex/events/chat/scene の再インデックス、
 *   モデル未着は DL 完了後に自動継続）を起動する。
 */
export function notifyLanguageChangedReindex(projectId: string): void {
  if (!projectId) return;
  const scope = captureCurrentSemanticScope(projectId);
  if (!scope) return;
  // open 時オートインデックスと DL 完了リスナが「もう一度」走れるようにする。
  resetIndexGuards(projectId, scope.workspaceKey);
  toast(
    i18next.t(
      "settings.project.languageChangedReindexPrompt",
      "執筆言語を変更しました。既存の意味検索インデックスは再構築が必要です。",
    ),
    {
      duration: 12000,
      action: {
        label: i18next.t("settings.project.semanticReindexButton", "再構築"),
        onClick: () => {
          if (!isSemanticScopeCurrent(scope)) return;
          void ensureSemanticIndexesOnOpen(projectId, scope.workspaceKey);
        },
      },
    },
  );
}
