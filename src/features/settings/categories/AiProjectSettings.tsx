import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProjectSettings } from "../hooks/useProjectSettings";
import { useSettingBoolean } from "../useSettingControl";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingTextarea } from "../components/SettingTextarea";
import { parseAiPolicy, serializeAiPolicy } from "@/features/ai-policy/parse";
import { expandPreset, inferPreset } from "@/features/ai-policy/preset";
import type { AiFeature, AiPolicyPreset } from "@/features/ai-policy/types";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  semanticDebugDump,
  semanticIndexStatus,
  semanticReindexAll,
  type SemanticIndexStatus,
} from "@/features/semantic-search/api";
import {
  runSearchEvalCompare,
  formatEvalCompare,
} from "@/features/semantic-search/searchEval";
import { useReindexProgressStore } from "@/features/semantic-search/reindexProgressStore";

/**
 * AI タブの「プロジェクト」スコープに表示する、プロジェクト固有の AI 設定。
 * = AI 使用ポリシー（preset/個別トグル/本文自動適用/関連シーン自動注入）と
 *   AI 作品設定（あらすじ・対象読者・文体・AI への指示）。
 *
 * いずれも project_settings / project レコード由来（project スコープ）。以前は
 * Project タブにあったが、Provider/モデル/コンテキスト予算など他の AI 設定と
 * 同じ AI タブに集約した（保存先はキー単位なので、タブ移動で挙動は変わらない）。
 * i18n キーは互換のため `settings.project.*` のまま（翻訳の移設は別途）。
 */
export function AiProjectSettings() {
  const { t } = useTranslation();
  const { project, isLoading, updateField } = useProjectSettings();
  const autoAcceptBody = useSettingBoolean("ai.autoAcceptBodyProposals", false);
  const semanticRecall = useSettingBoolean("ai.semanticRecall", true);
  const hybridRecall = useSettingBoolean("ai.hybridRecall", true);

  // 多重起動ガードはグローバル store に置く — コンポーネントローカル state だと
  // 設定パネルの閉じ開きやカテゴリ切替（再マウント）でガードが外れ、全件再構築を
  // 二重起動できてしまう。
  const reindexRunning = useReindexProgressStore((s) => s.running);
  const setReindexRunning = useReindexProgressStore((s) => s.setRunning);

  // インデックス状態（インデックス済みシーン数/チャンク数）。「再構築したのに
  // 注入されない」の切り分けに必須 — 0 件ならインデックス側、非 0 なら検索/スコア
  // 側の問題と即断できる。Embedder ロード不要の軽量クエリ。
  const [indexStatus, setIndexStatus] = useState<SemanticIndexStatus | null>(
    null,
  );
  const refreshIndexStatus = useCallback(() => {
    semanticIndexStatus(getCurrentProjectId())
      .then(setIndexStatus)
      .catch(() => setIndexStatus(null));
  }, []);
  // プロジェクト未取得時は叩かない（プロジェクト確定後・タブ表示時に取得）。
  useEffect(() => {
    if (project) refreshIndexStatus();
  }, [project, refreshIndexStatus]);

  // 意味検索インデックスの全件再構築。インデックスへの投入は通常シーン保存時の
  // 逐次更新（scheduleSceneIndex）だけなので、機能追加前から存在する・編集して
  // いないシーンは未インデックスのまま＝関連シーン注入が一切効かない。
  // 進行状況は Rust 側 progress event → ReindexProgressToast（App.tsx 常設）が表示。
  async function handleSemanticReindex() {
    if (useReindexProgressStore.getState().running) return;
    setReindexRunning(true);
    try {
      const chunks = await semanticReindexAll(getCurrentProjectId());
      toast.success(
        t("settings.project.semanticReindexDone", {
          defaultValue: "インデックスを再構築しました（{{count}} チャンク）",
          count: chunks,
        }),
      );
    } catch (e) {
      // 失敗時は呼び出し側が progress 表示を片付ける契約（reindexProgressStore）
      useReindexProgressStore.getState().clear();
      toast.error(
        t(
          "settings.project.semanticReindexFailed",
          "インデックスの再構築に失敗しました",
        ),
      );
      console.error("[semanticReindex]", e);
    } finally {
      setReindexRunning(false);
      refreshIndexStatus();
    }
  }

  if (isLoading || !project) return null;

  const currentPolicy = parseAiPolicy(project.aiPolicy);

  const handlePresetChange = (preset: AiPolicyPreset) => {
    if (preset === "custom") return;
    const toggles = expandPreset(preset);
    updateField("aiPolicy", serializeAiPolicy({ preset, toggles }));
  };

  const handleToggleChange = (feature: AiFeature, checked: boolean) => {
    const newToggles = { ...currentPolicy.toggles, [feature]: checked };
    const newPreset = inferPreset(newToggles);
    updateField(
      "aiPolicy",
      serializeAiPolicy({ preset: newPreset, toggles: newToggles }),
    );
  };

  return (
    <>
      <SettingSection title={t("settings.project.aiPolicy", "AI使用ポリシー")}>
        <SettingRow
          label={t("settings.project.aiPolicyPreset", "プリセット")}
          description={t(
            "settings.project.aiPolicyPresetDesc",
            "AI機能の使用範囲を一括設定します。個別トグルを変更するとカスタムになります。",
          )}
        >
          <select
            value={currentPolicy.preset}
            onChange={(e) =>
              handlePresetChange(e.target.value as AiPolicyPreset)
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            <option value="full">
              {t("settings.project.aiPolicyFull", "Full — すべて有効")}
            </option>
            <option value="assist-off">
              {t(
                "settings.project.aiPolicyAssistOff",
                "Assist-off — 本文書き込みを除外",
              )}
            </option>
            <option value="review-only">
              {t(
                "settings.project.aiPolicyReviewOnly",
                "Review-only — 分析のみ",
              )}
            </option>
            <option value="off">
              {t("settings.project.aiPolicyOff", "Off — すべて無効")}
            </option>
            <option value="custom" disabled>
              {t("settings.project.aiPolicyCustom", "カスタム")}
            </option>
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyChat", "チャット")}
          description={t(
            "settings.project.aiPolicyChatDesc",
            "チャットパネル・Agent・CLI 連携",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.chat}
            onChange={(e) => handleToggleChange("chat", e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyBodyWrite", "本文書き込み")}
          description={t(
            "settings.project.aiPolicyBodyWriteDesc",
            "インライン AI・Beat 生成",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.bodyWrite}
            onChange={(e) => handleToggleChange("bodyWrite", e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyAnalysis", "分析")}
          description={t(
            "settings.project.aiPolicyAnalysisDesc",
            "整合性チェック・伏線 AI",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.analysis}
            onChange={(e) => handleToggleChange("analysis", e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyStructureWrite", "構成編集")}
          description={t(
            "settings.project.aiPolicyStructureWriteDesc",
            "AI による章/シーン構成の生成・再編",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.structureWrite}
            onChange={(e) =>
              handleToggleChange("structureWrite", e.target.checked)
            }
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyKnowledgeWrite", "知識書き込み")}
          description={t(
            "settings.project.aiPolicyKnowledgeWriteDesc",
            "AI による Codex・伏線・スニペットの自律的な作成・更新",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.knowledgeWrite}
            onChange={(e) =>
              handleToggleChange("knowledgeWrite", e.target.checked)
            }
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.project.aiAutoAcceptBody",
            "本文提案の自動適用（ヘッドレス）",
          )}
          description={t(
            "settings.project.aiAutoAcceptBodyDesc",
            "MCP/エージェントの本文提案を人間の承認なしで自動適用する。対象は末尾への追記と、一意なアンカー位置を指定した本文途中への挿入。置換とアンカー無しの挿入は常に手動レビューに回る。本文書き込みポリシーが ON のときのみ有効。",
          )}
        >
          <input
            type="checkbox"
            checked={autoAcceptBody.value}
            disabled={!currentPolicy.toggles.bodyWrite}
            onChange={(e) => autoAcceptBody.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input disabled:cursor-not-allowed disabled:opacity-50"
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.project.aiSemanticRecall",
            "関連シーンの自動注入（意味検索）",
          )}
          description={t(
            "settings.project.aiSemanticRecallDesc",
            "チャット送信時に、いま書いている内容と意味的に関連する過去シーンの抜粋を検索してAIの文脈に自動注入する。インデックス未作成のプロジェクトでは何も注入されない。",
          )}
        >
          <input
            type="checkbox"
            checked={semanticRecall.value}
            onChange={(e) => semanticRecall.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.project.aiHybridRecall",
            "固有名詞の語彙一致も併用（ハイブリッド検索）",
          )}
          description={t(
            "settings.project.aiHybridRecallDesc",
            "意味検索に全文検索（FTS5/bm25）を順位融合（RRF）し、人名・地名など固有名詞の語彙一致を手がかりに関連シーンを拾いやすくする。関連シーンの自動注入がオフのときは無効。",
          )}
        >
          <input
            type="checkbox"
            checked={hybridRecall.value}
            disabled={!semanticRecall.value}
            onChange={(e) => hybridRecall.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input disabled:cursor-not-allowed disabled:opacity-50"
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.project.semanticReindex",
            "意味検索インデックスの再構築",
          )}
          description={t(
            "settings.project.semanticReindexDesc",
            "プロジェクト内の全シーンを再インデックスする。インデックスはシーン保存時にしか更新されないため、既存プロジェクトで初めて関連シーン注入を使うときはここから構築する。進行状況は画面右下に表示される。",
          )}
        >
          <div className="flex items-center gap-3">
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
              onClick={handleSemanticReindex}
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
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.aiSettings")}>
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.outline")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.outlineDesc")}
          </div>
          <SettingTextarea
            value={project.outline ?? ""}
            onChange={(v) => updateField("outline", v || null)}
            placeholder={t("settings.project.outlinePlaceholder")}
            maxLength={8000}
            rows={8}
          />
        </div>
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.targetReaders")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.targetReadersDesc")}
          </div>
          <SettingTextarea
            value={project.targetReaders ?? ""}
            onChange={(v) => updateField("targetReaders", v || null)}
            placeholder={t("settings.project.targetReadersPlaceholder")}
            maxLength={2000}
            rows={4}
          />
        </div>
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.styleGuide")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.styleGuideDesc")}
          </div>
          <SettingTextarea
            value={project.styleGuide ?? ""}
            onChange={(v) => updateField("styleGuide", v || null)}
            placeholder={t("settings.project.styleGuidePlaceholder")}
            maxLength={2000}
            rows={4}
          />
        </div>
        <div>
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.aiInstructions")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.aiInstructionsDesc")}
          </div>
          <SettingTextarea
            value={project.aiInstructions ?? ""}
            onChange={(v) => updateField("aiInstructions", v || null)}
            placeholder={t("settings.project.aiInstructionsPlaceholder")}
            maxLength={4000}
            rows={5}
          />
        </div>
      </SettingSection>
    </>
  );
}
