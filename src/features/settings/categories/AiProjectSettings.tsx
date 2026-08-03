import { useTranslation } from "react-i18next";
import { useProjectSettings } from "../hooks/useProjectSettings";
import { useSettingBoolean } from "../useSettingControl";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingTextarea } from "../components/SettingTextarea";
import { parseAiPolicy, serializeAiPolicy } from "@/features/ai-policy/parse";
import { expandPreset, inferPreset } from "@/features/ai-policy/preset";
import type { AiFeature, AiPolicyPreset } from "@/features/ai-policy/types";
import { resolveSemanticRerankerCapability } from "@/features/chat/semanticRerankerMode";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";

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
  const runtimeCapabilities = useRuntimeCapabilities();
  const autoAcceptBody = useSettingBoolean("ai.autoAcceptBodyProposals", false);
  const semanticRecall = useSettingBoolean("ai.semanticRecall", true);
  const hybridRecall = useSettingBoolean("ai.hybridRecall", true);
  const semanticReranker = useSettingBoolean("ai.semanticReranker", false);
  const chatRecall = useSettingBoolean("ai.chatRecall", true);

  if (isLoading || !project) return null;

  const currentPolicy = parseAiPolicy(project.aiPolicy);
  const rerankerCapability = resolveSemanticRerankerCapability({
    language: project.language,
    electronRuntime:
      runtimeCapabilities.localAi && !runtimeCapabilities.browserDirectAi,
    resourcesAvailable: runtimeCapabilities.localSemanticReranker,
  });
  const rerankerDisabled =
    !semanticRecall.value ||
    !hybridRecall.value ||
    !rerankerCapability.available;

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
            "settings.project.aiSemanticReranker",
            "Semantic reranking（実験的）",
          )}
          description={
            rerankerCapability.available
              ? t(
                  "settings.project.aiSemanticRerankerDesc",
                  "関連シーン候補をローカルモデルで再順位付けします。処理に時間がかかる場合は従来の検索結果を使用します。",
                )
              : t(
                  "settings.project.aiSemanticRerankerUnavailableDesc",
                  "現在は日本語・英語のデスクトップ版でのみ利用できます。",
                )
          }
          disabled={rerankerDisabled}
        >
          <input
            type="checkbox"
            checked={semanticReranker.value}
            disabled={rerankerDisabled}
            onChange={(e) => semanticReranker.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input disabled:cursor-not-allowed disabled:opacity-50"
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.project.aiChatRecall",
            "過去の対話の自動注入（エピソード記憶）",
          )}
          description={t(
            "settings.project.aiChatRecallDesc",
            "チャット送信時に、いま書いている内容と意味的に関連する過去の対話（チャット履歴）を検索してAIの文脈に自動注入する。関連シーンの注入とは独立して切り替えられ、オフにするとシーンの注入は残したまま過去対話の注入だけを止められる。進行中のセッションは対象外。",
          )}
        >
          <input
            type="checkbox"
            checked={chatRecall.value}
            onChange={(e) => chatRecall.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        {/* 意味検索インデックスの状態表示・全件再構築は Data タブ（SemanticIndexSection）へ
            移設した。FTS 再構築 / VACUUM と同族の索引保守のため。 */}
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
