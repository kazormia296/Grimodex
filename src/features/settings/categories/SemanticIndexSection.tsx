import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  semanticDebugDump,
  semanticIndexStatus,
  type SemanticIndexStatus,
} from "@/features/semantic-search/api";
import {
  runSearchEvalCompare,
  formatEvalCompare,
} from "@/features/semantic-search/searchEval";
import { useReindexProgressStore } from "@/features/semantic-search/reindexProgressStore";
import { runSemanticReindex } from "@/features/semantic-search/reindexActions";
import { SettingSection } from "../components/SettingSection";

/**
 * 意味検索インデックスの状態表示＋全件再構築。以前は AI タブ（AiProjectSettings）に
 * あったが、インデックス保守は FTS 再構築 / VACUUM と同族なので Data タブへ移設した。
 * i18n キーは互換のため `settings.project.*` のまま（翻訳の移設は別途）。
 */
export function SemanticIndexSection() {
  const { t } = useTranslation();
  // 多重起動ガードはグローバル store（設定パネルの開閉/カテゴリ切替の再マウントで
  // 外れないよう）。running が true→false へ落ちたら（＝どこ起点でも再構築完了）状態再取得。
  const reindexRunning = useReindexProgressStore((s) => s.running);

  const [indexStatus, setIndexStatus] = useState<SemanticIndexStatus | null>(
    null,
  );
  const refreshIndexStatus = useCallback(() => {
    semanticIndexStatus(getCurrentProjectId())
      .then(setIndexStatus)
      .catch(() => setIndexStatus(null));
  }, []);
  useEffect(() => {
    refreshIndexStatus();
  }, [refreshIndexStatus]);

  const prevRunning = useRef(reindexRunning);
  useEffect(() => {
    if (prevRunning.current && !reindexRunning) refreshIndexStatus();
    prevRunning.current = reindexRunning;
  }, [reindexRunning, refreshIndexStatus]);

  return (
    <SettingSection
      title={t(
        "settings.project.semanticReindex",
        "意味検索インデックスの再構築",
      )}
    >
      <div className="rounded px-1 py-1.5">
        <div className="mb-2 text-xs text-muted-foreground">
          {t(
            "settings.project.semanticReindexDesc",
            "プロジェクト内の全シーンを再インデックスする。インデックスはシーン保存時にしか更新されないため、既存プロジェクトで初めて関連シーン注入を使うときはここから構築する。進行状況は画面右下に表示される。",
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {indexStatus && (
            <span className="text-xs text-muted-foreground">
              {t("settings.project.semanticIndexStatus", {
                defaultValue: "{{scenes}} シーン / {{chunks}} チャンク",
                scenes: indexStatus.indexedSceneCount,
                chunks: indexStatus.indexedChunkCount,
              })}
            </span>
          )}
          {indexStatus && indexStatus.staleChunkCount > 0 && (
            // 言語変更等でモデル/次元/チャンカが変わると既存チャンクが stale 化し
            // 関連シーン注入が無言で空になる。再構築を促す。
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t("settings.project.semanticIndexStale", {
                defaultValue: "{{count}} チャンクが再構築待ち",
                count: indexStatus.staleChunkCount,
              })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void runSemanticReindex()}
            disabled={reindexRunning}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reindexRunning
              ? t("settings.project.semanticReindexRunning", "再構築中…")
              : t("settings.project.semanticReindexButton", "再構築")}
          </button>
          {import.meta.env.DEV && (
            // 開発専用: index 済み scene_chunks をコンソールにダンプして
            // セマンティック検索のデバッグ（何が・どのモデルで index されたか）に使う。
            <button
              type="button"
              onClick={async () => {
                try {
                  const dump = await semanticDebugDump({
                    projectId: getCurrentProjectId(),
                  });
                  console.log(
                    `[semantic-debug] ${dump.returnedChunks}/${dump.totalChunks} chunks · ` +
                      `lang=${dump.language} · model=${dump.currentModelId} · ` +
                      `dim=${dump.currentEmbeddingDim} · chunker=${dump.currentChunkerVersion}`,
                  );
                  console.table(dump.chunks);
                } catch (e) {
                  console.error("[semantic-debug] dump failed", e);
                }
              }}
              className="rounded-md border border-dashed border-border px-3 py-1 text-sm text-muted-foreground hover:bg-accent"
              title={t("settings.project.semanticDebugDumpTitle")}
            >
              {t("settings.project.semanticDebugDumpButton")}
            </button>
          )}
          {import.meta.env.DEV && (
            // 開発専用: query→期待シーンの eval set を実機 semantic_search に流し、
            // dense 単独 vs hybrid(dense+sparse RRF) の Recall@1/@3/MRR・差分・miss/junk を
            // コンソールへ。検索品質の回帰検知と「sparse 融合の効き目」計測用。
            <button
              type="button"
              onClick={async () => {
                try {
                  const cmp = await runSearchEvalCompare();
                  console.log(formatEvalCompare(cmp));
                  console.table(
                    cmp.hybrid.results.map((r) => ({
                      query: r.query,
                      rank: r.rank,
                      expectedScore: r.expectedScore,
                      topScore: r.topScore,
                      top: r.scenes[0]?.sceneTitle,
                    })),
                  );
                  console.table(cmp.hybrid.junk);
                } catch (e) {
                  console.error("[semantic-eval] failed", e);
                }
              }}
              className="rounded-md border border-dashed border-border px-3 py-1 text-sm text-muted-foreground hover:bg-accent"
              title={t("settings.project.semanticEvalTitle")}
            >
              {t("settings.project.semanticEvalButton")}
            </button>
          )}
        </div>
      </div>
    </SettingSection>
  );
}
