import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProjectSettings } from "../hooks/useProjectSettings";
import {
  useSettingControl,
  useSettingBoolean,
  useSettingNumber,
} from "../useSettingControl";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingTextarea } from "../components/SettingTextarea";
import { TimelapseSettings } from "./TimelapseSettings";
import { getAllProjectSettings } from "../api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { PhaseResolutionMode } from "@/features/codex/phaseResolver";
import { parseAiPolicy, serializeAiPolicy } from "@/features/ai-policy/parse";
import { expandPreset, inferPreset } from "@/features/ai-policy/preset";
import type { AiFeature, AiPolicyPreset } from "@/features/ai-policy/types";
import { useWorkspaceStore } from "@/features/workspace/store";
import { PROJECT_ID } from "@/features/project/constants";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  semanticDebugDump,
  semanticIndexStatus,
  semanticReindexAll,
  type SemanticIndexStatus,
} from "@/features/semantic-search/api";
import {
  runSearchEval,
  formatEvalReport,
} from "@/features/semantic-search/searchEval";
import { useReindexProgressStore } from "@/features/semantic-search/reindexProgressStore";
import { GENRE_VALUES } from "@/features/project/genreOptions";

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ko", label: "한국어" },
];

export function ProjectCategory() {
  const { t } = useTranslation();
  const { project, isLoading, updateField } = useProjectSettings();
  const folderNaming = useSettingControl("tree.folderNaming", "auto");
  const sceneNaming = useSettingControl(
    "tree.sceneNaming",
    t("tree.defaultScene"),
  );
  const noteNaming = useSettingControl(
    "tree.noteNaming",
    t("tree.defaultNote"),
  );
  const numberingScope = useSettingControl("tree.numberingScope", "project");
  const autoAcceptBody = useSettingBoolean("ai.autoAcceptBodyProposals", false);
  const semanticRecall = useSettingBoolean("ai.semanticRecall", true);
  const trashBinEnabled = useSettingBoolean("trashBin.enabled", true);
  const trashBinRetention = useSettingNumber("trashBin.retentionDays", 60);

  const TRASH_RETENTION_OPTIONS = [
    { value: "7", label: t("settings.project.trashRetention7", "7 日") },
    { value: "30", label: t("settings.project.trashRetention30", "30 日") },
    { value: "60", label: t("settings.project.trashRetention60", "60 日") },
    { value: "90", label: t("settings.project.trashRetention90", "90 日") },
    {
      value: "-1",
      label: t("settings.project.trashRetentionUnlimited", "無期限"),
    },
  ];

  const GENRE_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    ...GENRE_VALUES.map((value) => ({ value, label: value })),
  ];

  const POV_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    { value: "First person", label: t("settings.project.firstPerson") },
    {
      value: "Third person limited",
      label: t("settings.project.thirdLimited"),
    },
    {
      value: "Third person omniscient",
      label: t("settings.project.thirdOmniscient"),
    },
    { value: "Second person", label: t("settings.project.secondPerson") },
  ];

  const TENSE_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    { value: "Past tense", label: t("settings.project.pastTense") },
    { value: "Present tense", label: t("settings.project.presentTense") },
  ];

  const PHASE_RESOLUTION_OPTIONS = [
    { value: "reading", label: t("settings.project.phaseResolutionReading") },
    { value: "story", label: t("settings.project.phaseResolutionStory") },
    { value: "auto", label: t("settings.project.phaseResolutionAuto") },
  ];

  const FOLDER_NAMING_OPTIONS = [
    { value: "auto", label: t("settings.project.folderNamingAuto") },
    { value: "none", label: t("settings.project.folderNamingNone") },
  ];

  const NUMBERING_SCOPE_OPTIONS = [
    { value: "project", label: t("settings.project.numberingScopeProject") },
    { value: "folder", label: t("settings.project.numberingScopeFolder") },
  ];

  const updateProjectDefaults = useWorkspaceStore(
    (s) => s.updateProjectDefaults,
  );

  async function handleSaveAsDefaults() {
    const all = await getAllProjectSettings(PROJECT_ID);
    await updateProjectDefaults(all);
    toast.success(t("settings.project.saveAsDefaultsDone"));
  }

  // 多重起動ガードはグローバル store に置く — コンポーネントローカル state
  // だと設定パネルの閉じ開きやカテゴリ切替（再マウント）でガードが外れ、
  // 全件再構築を二重起動できてしまう。
  const reindexRunning = useReindexProgressStore((s) => s.running);
  const setReindexRunning = useReindexProgressStore((s) => s.setRunning);

  // インデックス状態（インデックス済みシーン数/チャンク数）。「再構築した
  // のに注入されない」の切り分けに必須 — 0 件ならインデックス側、非 0 なら
  // 検索/スコア側の問題と即断できる。Embedder ロード不要の軽量クエリ。
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

  if (isLoading || !project) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

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
    <div className="p-6">
      <SettingSection title={t("settings.project.basic")}>
        <SettingRow label={t("settings.project.title")}>
          <input
            type="text"
            value={project.title}
            onChange={(e) => updateField("title", e.target.value)}
            className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label={t("settings.project.genre")}>
          <select
            value={project.genre ?? ""}
            onChange={(e) => updateField("genre", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {GENRE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.project.pov")}>
          <select
            value={project.pov ?? ""}
            onChange={(e) => updateField("pov", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {POV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.project.tense")}>
          <select
            value={project.tense ?? ""}
            onChange={(e) => updateField("tense", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {TENSE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.project.language")}>
          <select
            value={project.language}
            onChange={(e) =>
              // 言語変更で embedding spec (model_id/dim/chunker) が変わり既存
              // チャンクが全 stale になる。DB 書込後に index status を取り直して
              // staleChunkCount を表面化する (下の再構築バナー)。
              updateField("language", e.target.value, refreshIndexStatus)
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.project.phaseResolutionMode")}
          description={t("settings.project.phaseResolutionModeDesc")}
        >
          <select
            value={project.phaseResolutionMode}
            onChange={(e) => {
              const mode = e.target.value as PhaseResolutionMode;
              updateField("phaseResolutionMode", mode);
              usePhaseStore.getState().setResolutionMode(mode);
            }}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {PHASE_RESOLUTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.namingRules")}>
        <SettingRow label={t("settings.project.folderNaming")}>
          <select
            value={folderNaming.value}
            onChange={(e) => folderNaming.setValue(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {FOLDER_NAMING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.project.sceneNamingPrefix")}
          description={
            sceneNaming.value
              ? t("settings.project.sceneNamingPrefixDesc", {
                  prefix: sceneNaming.value,
                })
              : t("settings.project.sceneNamingPrefixDescNone")
          }
        >
          <input
            type="text"
            value={sceneNaming.value}
            onChange={(e) => sceneNaming.setValue(e.target.value)}
            placeholder={t("settings.project.sceneNamingPlaceholder")}
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label={t("settings.project.noteNamingPrefix")}>
          <input
            type="text"
            value={noteNaming.value}
            onChange={(e) => noteNaming.setValue(e.target.value)}
            placeholder={t("settings.project.noteNamingPlaceholder")}
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label={t("settings.project.numberingScope")}>
          <select
            value={numberingScope.value}
            onChange={(e) => numberingScope.setValue(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {NUMBERING_SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.trashBin", "ゴミ箱")}>
        <SettingRow
          label={t("trashBin.enableLabel", "ゴミ箱を有効化")}
          description={t(
            "settings.project.trashBinDesc",
            "削除した文字片や構造アイテムをゴミ箱に保持します。",
          )}
        >
          <input
            type="checkbox"
            checked={trashBinEnabled.value}
            onChange={(e) => trashBinEnabled.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.trashRetention", "保持期間")}
          description={t(
            "settings.project.trashRetentionDesc",
            "保持期間を超えた屑は次回の起動 / 1 時間ごとの掃除で削除されます。",
          )}
        >
          <select
            value={String(trashBinRetention.value)}
            onChange={(e) => trashBinRetention.setValue(Number(e.target.value))}
            disabled={!trashBinEnabled.value}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none disabled:opacity-50"
          >
            {TRASH_RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <TimelapseSettings />

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
                title="開発専用: scene_chunks をコンソールにダンプ"
              >
                Dump chunks
              </button>
            )}
            {import.meta.env.DEV && (
              // 開発専用: query→期待シーンの eval set を実機 semantic_search に流し、
              // Recall@1/@3/MRR・閾値跨ぎ・miss/junk をコンソールへ。検索品質の回帰検知用。
              <button
                type="button"
                onClick={async () => {
                  try {
                    const report = await runSearchEval();
                    console.log(formatEvalReport(report));
                    console.table(
                      report.results.map((r) => ({
                        query: r.query,
                        rank: r.rank,
                        expectedScore: r.expectedScore,
                        topScore: r.topScore,
                        top: r.scenes[0]?.sceneTitle,
                      })),
                    );
                    console.table(report.junk);
                  } catch (e) {
                    console.error("[semantic-eval] failed", e);
                  }
                }}
                className="rounded-md border border-dashed border-border px-3 py-1 text-sm text-muted-foreground hover:bg-accent"
                title="開発専用: クエリ集を実機検索に流して Recall/閾値を計測"
              >
                Run search eval
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

      <SettingSection title={t("settings.project.defaults", "デフォルト雛形")}>
        <SettingRow
          label={t(
            "settings.project.saveAsDefaults",
            "現在の設定をデフォルト雛形として保存",
          )}
          description={t(
            "settings.project.saveAsDefaultsDesc",
            "ツリー・エクスポート・AI 予算等の作品設定を、今後新規作成するプロジェクトの初期値として保存します。",
          )}
        >
          <button
            type="button"
            onClick={handleSaveAsDefaults}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
          >
            {t("settings.project.saveAsDefaultsButton", "保存")}
          </button>
        </SettingRow>
      </SettingSection>
    </div>
  );
}
