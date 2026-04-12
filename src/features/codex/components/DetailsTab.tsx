import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Wand2 } from "lucide-react";
import type { CodexEntry } from "../api";
import { AliasesField } from "./AliasesField";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";
import { PhaseIndicator } from "./PhaseIndicator";
import { extractPlainText } from "../prosemirrorTextExtractor";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { useTabStore } from "@/features/editor/tabStore";
import { usePhaseStore } from "../phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveCodexState } from "../phaseResolver";

interface DetailsTabProps {
  entry: CodexEntry;
  aliases: string[];
  summary: string;
  onAliasesChange: (aliases: string[]) => void;
  onSummaryChange: (value: string) => void;
  onContentChange: (content: string) => void;
  onExternalSync?: (content: string) => void;
}

export function DetailsTab({
  entry,
  aliases,
  summary,
  onAliasesChange,
  onSummaryChange,
  onContentChange,
  onExternalSync,
}: DetailsTabProps) {
  const emptyContent = !entry.content || entry.content === "{}";
  const [isGenerating, setIsGenerating] = useState(false);

  // プレビューフェーズ管理
  const [previewPhaseId, setPreviewPhaseId] = useState<string | null>(null);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const phases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);

  // アクティブシーン変更時にプレビューをリセット
  useEffect(() => {
    setPreviewPhaseId(null);
  }, [activeSceneId]);

  // エントリ変更時もリセット
  useEffect(() => {
    setPreviewPhaseId(null);
  }, [entry.id]);

  // プレビュー用の解決済み状態を計算
  const previewResolvedState = useMemo(() => {
    if (previewPhaseId == null || !phases) return null;

    // プレビュー対象のシーンIDを決定
    let previewSceneId: string | null;
    if (previewPhaseId === "__base__") {
      previewSceneId = null; // Base state
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

  // プレビュー中の summary（null = Base 値と同じ or プレビューなし）
  const previewSummary =
    previewResolvedState != null ? previewResolvedState.summary : null;
  const hasPreviewSummary =
    previewSummary != null && previewSummary !== (entry.summary ?? "");

  return (
    <div className="space-y-3">
      <PhaseIndicator
        entry={entry}
        previewPhaseId={previewPhaseId}
        onPreviewChange={setPreviewPhaseId}
      />
      {/* Aliases */}
      <AliasesField
        label="Aliases"
        aliases={aliases}
        onChange={onAliasesChange}
      />

      {/* Summary */}
      <div>
        <label className="mb-1 block text-xs font-medium">概要</label>
        {hasPreviewSummary ? (
          // フェーズプレビュー中: 解決済み値を読み取り専用表示
          <div className="border-l-2 border-primary pl-2">
            <p className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground">
              {previewSummary || (
                <span className="text-muted-foreground">(空)</span>
              )}
            </p>
            {entry.summary && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Base: {entry.summary}
              </p>
            )}
          </div>
        ) : (
          <textarea
            data-testid="codex-detail-summary"
            value={
              previewPhaseId != null && previewResolvedState != null
                ? (previewResolvedState.summary ?? "")
                : summary
            }
            onChange={(e) => {
              if (previewPhaseId == null) onSummaryChange(e.target.value);
            }}
            readOnly={previewPhaseId != null}
            rows={3}
            className={`w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm ${previewPhaseId != null ? "cursor-default opacity-70" : ""}`}
            placeholder="Short description..."
          />
        )}
        {/* S5: hint when summary is empty but content exists */}
        {summary === "" && !emptyContent && previewPhaseId == null && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Summaryを記入するとAIチャットでのトークン消費を抑えられます
          </p>
        )}
        {/* M4: AI auto-generate button */}
        {summary === "" && !emptyContent && previewPhaseId == null && (
          <button
            type="button"
            data-testid="codex-generate-summary"
            disabled={isGenerating}
            onClick={async () => {
              setIsGenerating(true);
              try {
                const plainText = extractPlainText(entry.content ?? "{}");
                const generated = await generateSynopsisFromContent(
                  entry.name,
                  plainText,
                );
                onSummaryChange(generated);
              } catch {
                toast.error("AI要約の生成に失敗しました");
              } finally {
                setIsGenerating(false);
              }
            }}
            className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <Wand2 className="h-3 w-3" />
            {isGenerating ? "生成中..." : "AI要約を生成"}
          </button>
        )}
      </div>

      {/* Content (TipTap) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium">Content</label>
          <button
            type="button"
            onClick={() => useTabStore.getState().openCodexTab(entry.id)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            title="エディタで開く"
          >
            <ExternalLink className="h-3 w-3" />
            エディタで開く
          </button>
        </div>
        {/* プレビュー中かつcontentOverrideがある場合は左ボーダーで強調 */}
        <div
          className={
            previewPhaseId != null &&
            previewResolvedState != null &&
            previewResolvedState.content !== (entry.content ?? "{}")
              ? "border-l-2 border-primary pl-2"
              : ""
          }
        >
          <CodexContentEditor
            content={emptyContent ? "" : entry.content}
            onContentChange={
              previewPhaseId == null ? onContentChange : () => {}
            }
            entryId={previewPhaseId == null ? entry.id : undefined}
            onExternalSync={previewPhaseId == null ? onExternalSync : undefined}
            externalContent={
              previewPhaseId != null && previewResolvedState != null
                ? previewResolvedState.content
                : null
            }
          />
        </div>
      </div>

      {/* Custom Details */}
      <DetailsSection entry={entry} />
    </div>
  );
}
