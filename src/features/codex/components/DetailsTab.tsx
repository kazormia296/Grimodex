import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, ExternalLink, Wand2 } from "lucide-react";
import type { CodexEntry } from "../api";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";
import { PhaseIndicator } from "./PhaseIndicator";
import { extractPlainText } from "../prosemirrorTextExtractor";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { useTabStore } from "@/features/editor/tabStore";
import { usePhaseStore } from "../phaseStore";
import { useCodexStore } from "../codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveCodexState } from "../phaseResolver";
import { useAutoSave } from "@/hooks/useAutoSave";

interface DetailsTabProps {
  entry: CodexEntry;
  summary: string;
  onSummaryChange: (value: string) => void;
  onContentChange: (content: string) => void;
  onExternalSync?: (content: string) => void;
}

export function DetailsTab({
  entry,
  summary,
  onSummaryChange,
  onContentChange,
  onExternalSync,
}: DetailsTabProps) {
  const { t } = useTranslation();
  const emptyContent = !entry.content || entry.content === "{}";
  const [isGenerating, setIsGenerating] = useState(false);

  // プレビューフェーズ管理（codexStore にリフトアップ済み — wide mode の中央 EditorPane と共有）
  const previewPhaseId = useCodexStore(
    (s) => s.previewPhaseByEntry[entry.id] ?? null,
  );
  const setPreviewPhase = useCodexStore((s) => s.setPreviewPhase);
  const setPreviewPhaseId = useCallback(
    (phaseId: string | null) => setPreviewPhase(entry.id, phaseId),
    [entry.id, setPreviewPhase],
  );
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const phases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const updatePhase = usePhaseStore((s) => s.updatePhase);

  // アクティブシーン変更時にプレビューをリセット
  useEffect(() => {
    setPreviewPhase(entry.id, null);
  }, [activeSceneId, entry.id, setPreviewPhase]);

  // シーン順でソートされたフェーズ
  const sortedPhases = useMemo(() => {
    if (!phases) return [];
    return [...phases]
      .filter(
        (p) => p.anchorNodeId != null && globalSceneOrder.has(p.anchorNodeId),
      )
      .sort(
        (a, b) =>
          globalSceneOrder.get(a.anchorNodeId!)! -
          globalSceneOrder.get(b.anchorNodeId!)!,
      );
  }, [phases, globalSceneOrder]);

  // 現在のアクティブフェーズ（シーン基準で自動解決）
  const activePhase = useMemo(() => {
    if (!activeSceneId) return null;
    const currentOrder = globalSceneOrder.get(activeSceneId);
    if (currentOrder === undefined) return null;
    const applicable = sortedPhases.filter(
      (p) => globalSceneOrder.get(p.anchorNodeId!)! <= currentOrder,
    );
    return applicable[applicable.length - 1] ?? null;
  }, [sortedPhases, globalSceneOrder, activeSceneId]);

  // プレビュー用の解決済み状態を計算（プレビューモード時のみ）
  const previewResolvedState = useMemo(() => {
    if (previewPhaseId == null || !phases) return null;

    let previewSceneId: string | null;
    if (previewPhaseId === "__base__") {
      previewSceneId = null;
    } else {
      const targetPhase = phases.find((p) => p.id === previewPhaseId);
      previewSceneId = targetPhase?.anchorNodeId ?? null;
    }

    const phaseDetailsMap = new Map(
      phases.map((p) => [p.id, detailOverrides[p.id] ?? []]),
    );

    return resolveCodexState(
      {
        summary: entry.summary ?? null,
        content: entry.content ?? "{}",
        contextMode: entry.contextMode ?? "mentioned",
      },
      phases,
      phaseDetailsMap,
      new Map(),
      previewSceneId,
      globalSceneOrder,
    );
  }, [
    previewPhaseId,
    phases,
    detailOverrides,
    globalSceneOrder,
    entry.summary,
    entry.content,
    entry.contextMode,
  ]);

  // モードフラグ
  const isPreviewMode = previewPhaseId != null;
  const isActivePhaseSummaryMode =
    !isPreviewMode && (activePhase?.summaryOverride ?? null) !== null;
  const isActivePhaseContentMode =
    !isPreviewMode && (activePhase?.contentOverride ?? null) !== null;

  // フェーズsummaryのローカル状態（入力ラグ防止）
  const [phaseSummaryLocal, setPhaseSummaryLocal] = useState(
    activePhase?.summaryOverride ?? "",
  );
  const phaseSummaryRef = useRef(phaseSummaryLocal);
  phaseSummaryRef.current = phaseSummaryLocal;

  // アクティブフェーズが変わったときにローカル状態を同期
  useEffect(() => {
    setPhaseSummaryLocal(activePhase?.summaryOverride ?? "");
    // intentional: sync only when phase identity changes, not on value update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhase?.id]);

  // Phase summaryの自動保存（1秒デバウンス）
  const { schedule: schedulePhaseSummarySave } = useAutoSave(
    useCallback(
      async () => {
        if (!activePhase) return;
        await updatePhase(activePhase.id, {
          summaryOverride: phaseSummaryRef.current,
        });
      },
      // intentional: phaseSummaryRef used for latest value, identity tracked via .id
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [activePhase?.id, updatePhase],
    ),
    1000,
  );

  // Base contentを表示の折りたたみ状態
  const [showBaseContent, setShowBaseContent] = useState(false);

  // プレビューsummary（プレビューモードのみ）
  const previewSummary =
    isPreviewMode && previewResolvedState != null
      ? previewResolvedState.summary
      : null;
  const hasPreviewSummary =
    previewSummary != null && previewSummary !== (entry.summary ?? "");

  // Contentエディタのkeyとinitial content
  // - activePhaseContentMode: フェーズのcontentOverrideで初期化、フェーズ変更時に再マウント
  // - previewMode: ベースcontentで初期化、externalContentでオーバーライド
  // - base: entry.content
  const contentEditorKey = isActivePhaseContentMode
    ? `phase-${activePhase?.id ?? "none"}`
    : isPreviewMode
      ? `preview-${previewPhaseId}`
      : "base";

  const contentForEditor = isActivePhaseContentMode
    ? (activePhase?.contentOverride ?? "")
    : emptyContent
      ? ""
      : entry.content;

  // externalContentはプレビューモードのみ使用
  const contentExternalContent =
    isPreviewMode &&
    previewResolvedState != null &&
    previewResolvedState.content !== (entry.content ?? "{}")
      ? previewResolvedState.content
      : null;

  // Summary変更ハンドラ
  const handleSummaryChange = (value: string) => {
    if (isPreviewMode) return;
    if (isActivePhaseSummaryMode && activePhase) {
      setPhaseSummaryLocal(value);
      schedulePhaseSummarySave();
    } else {
      onSummaryChange(value);
    }
  };

  // Content変更ハンドラ
  const handleContentChange = (newContent: string) => {
    if (isPreviewMode) return;
    if (isActivePhaseContentMode && activePhase) {
      void updatePhase(activePhase.id, { contentOverride: newContent });
    } else {
      onContentChange(newContent);
    }
  };

  // ContentエディタのentryId（フェーズ/プレビューモード時はsceneContentStore連携を無効化）
  const contentEntryId =
    isActivePhaseContentMode || isPreviewMode ? undefined : entry.id;

  // ContentのexternalSync（フェーズ/プレビューモード時は無効化）
  const contentExternalSync =
    isActivePhaseContentMode || isPreviewMode ? undefined : onExternalSync;

  return (
    <div className="space-y-3">
      <PhaseIndicator
        entry={entry}
        previewPhaseId={previewPhaseId}
        onPreviewChange={setPreviewPhaseId}
      />

      {/* Summary */}
      <div>
        <label className="mb-1 block text-xs font-medium">
          {t("codex.detail.summaryLabel")}
        </label>
        {hasPreviewSummary ? (
          // フェーズプレビュー中: 解決済み値を読み取り専用表示
          <div className="border-l-2 border-primary pl-2">
            <p className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground">
              {previewSummary || (
                <span className="text-muted-foreground">
                  {t("codex.detail.empty")}
                </span>
              )}
            </p>
            {entry.summary && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Base: {entry.summary}
              </p>
            )}
          </div>
        ) : isActivePhaseSummaryMode ? (
          // アクティブフェーズがsummaryを上書き中: フェーズ値を編集可能表示
          <div className="border-l-2 border-primary pl-2">
            <textarea
              value={phaseSummaryLocal}
              onChange={(e) => handleSummaryChange(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              placeholder={t("codex.detail.phaseSummaryPlaceholder")}
            />
            {entry.summary && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Base: {entry.summary}
              </p>
            )}
          </div>
        ) : (
          <textarea
            data-testid="codex-detail-summary"
            value={summary}
            onChange={(e) => handleSummaryChange(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            placeholder="Short description..."
          />
        )}
        {/* S5: hint when summary is empty but content exists */}
        {summary === "" &&
          !emptyContent &&
          !isActivePhaseSummaryMode &&
          !isPreviewMode && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("codex.detail.summaryHint")}
            </p>
          )}
        {/* M4: AI auto-generate button */}
        {summary === "" &&
          !emptyContent &&
          !isActivePhaseSummaryMode &&
          !isPreviewMode && (
            <button
              type="button"
              data-testid="codex-generate-summary"
              disabled={isGenerating}
              onClick={async () => {
                // On-demand AI generation of persisted text → bodyWrite gate
                // (same generateSynopsisFromContent primitive as scene synopsis).
                if (blockIfPolicyOff("bodyWrite")) return;
                setIsGenerating(true);
                try {
                  const plainText = extractPlainText(entry.content ?? "{}");
                  const generated = await generateSynopsisFromContent(
                    entry.name,
                    plainText,
                  );
                  onSummaryChange(generated);
                } catch {
                  toast.error(t("codex.detail.aiSummaryFailed"));
                } finally {
                  setIsGenerating(false);
                }
              }}
              className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              <Wand2 className="h-3 w-3" />
              {isGenerating
                ? t("codex.detail.generating")
                : t("codex.detail.generateAiSummary")}
            </button>
          )}
      </div>

      {/* Content (TipTap) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium">
            {t("codex.detail.contentLabel")}
          </label>
          <button
            type="button"
            onClick={() =>
              useTabStore
                .getState()
                .openCodexTab(
                  entry.id,
                  isPreviewMode ? previewPhaseId : undefined,
                )
            }
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            title={t("codex.detail.openInEditor")}
          >
            <ExternalLink className="h-3 w-3" />
            {t("codex.detail.openInEditor")}
          </button>
        </div>
        {/* フェーズによるcontentOverrideがある場合は左ボーダーで強調 */}
        <div
          className={
            isActivePhaseContentMode || contentExternalContent != null
              ? "border-l-2 border-primary pl-2"
              : ""
          }
        >
          <CodexContentEditor
            key={contentEditorKey}
            content={contentForEditor}
            onContentChange={isPreviewMode ? () => {} : handleContentChange}
            entryId={contentEntryId}
            onExternalSync={contentExternalSync}
            externalContent={contentExternalContent}
          />
        </div>

        {/* アクティブフェーズがcontentを上書き中: Base contentを折りたたみ表示 */}
        {isActivePhaseContentMode && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowBaseContent((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {showBaseContent ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {t("codex.detail.showBaseContent")}
            </button>
            {showBaseContent && (
              <div className="mt-1 rounded-md border border-input bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                {emptyContent ? (
                  <span className="italic">{t("codex.detail.empty")}</span>
                ) : (
                  extractPlainText(entry.content ?? "{}")
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Custom Details */}
      <DetailsSection entry={entry} />
    </div>
  );
}
