import { useState } from "react";
import { BookmarkPlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LayerBreakdown } from "../contextBuilder";
import { estimateInputCost, formatCost } from "../modelPricing";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { usePromptLibraryStore } from "@/features/prompt-library/promptLibraryStore";
import { PromptTemplateEditorDialog } from "@/features/prompt-library/PromptTemplateEditorDialog";

interface PromptPreviewModalProps {
  systemPrompt: string;
  layers: LayerBreakdown[];
  totalTokens: number;
  /** 現在のモデル ID。コスト推定に使う。未指定 / 未登録モデルではコスト行を省略 */
  model?: string;
  /** モデルのコンテキストウィンドウ (tokens)。0 / 省略時は fill bar 行も省略 */
  contextWindow?: number;
  /** related_scenes 込みのプレビュー再構築中。true の間はプレースホルダを出す。 */
  loading?: boolean;
  /** Exact prompt construction failed. Estimated live cache must not be shown or saved. */
  unavailable?: boolean;
  /** 「これから送る入力メッセージ」。空 / 未指定なら送信メッセージ行を描画しない。 */
  userMessage?: string;
  onClose: () => void;
}

export function PromptPreviewModal({
  systemPrompt,
  layers,
  totalTokens,
  model,
  contextWindow,
  loading = false,
  unavailable = false,
  userMessage,
  onClose,
}: PromptPreviewModalProps) {
  const { t } = useTranslation();
  const createTemplate = usePromptLibraryStore((s) => s.create);
  // テンプレート保存ダイアログ。保存対象は「これから送る入力メッセージ」が
  // あればそれ（再利用したい指示文）、無ければプロンプト全文。
  const [saveOpen, setSaveOpen] = useState(false);
  const saveTarget = unavailable
    ? ""
    : userMessage && userMessage.trim()
      ? userMessage
      : systemPrompt;
  const estimatedCost =
    model && totalTokens > 0 ? estimateInputCost(model, totalTokens) : null;
  const costLabel = estimatedCost !== null ? formatCost(estimatedCost) : null;
  const fillPct =
    contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((totalTokens / contextWindow) * 100))
      : null;
  const fillTone =
    fillPct === null
      ? null
      : fillPct >= 80
        ? "bg-destructive"
        : fillPct >= 50
          ? "bg-amber-500"
          : "bg-primary";
  return (
    <AnimatedOverlay
      open
      onClose={onClose}
      className="relative flex max-h-[80vh] w-[600px] max-w-[90vw] flex-col rounded-lg bg-background shadow-lg"
      data-tour-target="prompt-preview-modal"
    >
      {/* ヘッダー */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {t("chat.context.promptPreviewTitle")}
        </h2>
        <div className="flex items-center gap-1">
          {!loading && !unavailable && saveTarget.trim() && (
            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("promptLibrary.saveFromPreview.title")}
            >
              <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
              {t("promptLibrary.saveFromPreview.label")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {saveOpen && (
        <PromptTemplateEditorDialog
          heading={t("promptLibrary.editor.headingNew")}
          initialTitle=""
          initialContent={saveTarget}
          onSubmit={async (title, content) => {
            await createTemplate(title, content);
            setSaveOpen(false);
          }}
          onClose={() => setSaveOpen(false)}
        />
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("chat.context.promptPreviewLoading")}
          </p>
        ) : unavailable ? (
          <p
            className="py-8 text-center text-sm text-muted-foreground"
            role="status"
          >
            {t("chat.context.promptPreviewUnavailable")}
          </p>
        ) : (
          <>
            {/* レイヤー別内訳テーブル */}
            {layers.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
                  {t("chat.context.layerBreakdown")}
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="pb-1 pr-4">
                        {t("chat.context.layerColumn")}
                      </th>
                      <th className="pb-1 pr-4 text-right">
                        {t("chat.context.usedTokens")}
                      </th>
                      <th className="pb-1">{t("chat.context.usageRate")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {layers.map((layer) => {
                      const pct =
                        totalTokens > 0
                          ? Math.round((layer.used / totalTokens) * 100)
                          : 0;
                      return (
                        <tr
                          key={layer.layer}
                          className="border-b border-border/40"
                        >
                          <td className="py-1 pr-4">
                            <span className="font-mono text-muted-foreground">
                              {layer.layer}
                            </span>{" "}
                            {layer.label}
                          </td>
                          <td className="py-1 pr-4 text-right tabular-nums">
                            {layer.used.toLocaleString()}
                          </td>
                          <td className="py-1 w-32">
                            <div className="flex items-center gap-1">
                              <div className="h-1.5 flex-1 rounded-full bg-muted">
                                <div
                                  className="h-1.5 rounded-full bg-primary"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="tabular-nums text-muted-foreground">
                                {pct}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="font-semibold">
                      <td className="py-1 pr-4">
                        {t("chat.context.totalRow")}
                      </td>
                      <td className="py-1 pr-4 text-right tabular-nums">
                        {totalTokens.toLocaleString()}
                      </td>
                      <td />
                    </tr>
                    {costLabel && (
                      <tr className="text-muted-foreground">
                        <td className="py-1 pr-4 text-xs">
                          {t("chat.context.costRow")}
                        </td>
                        <td className="py-1 pr-4 text-right text-xs tabular-nums">
                          ~{costLabel}
                        </td>
                        <td className="py-1 text-xs">
                          {t("chat.context.costNote")}
                        </td>
                      </tr>
                    )}
                    {fillPct !== null && fillTone && (
                      <tr className="text-muted-foreground">
                        <td className="py-1 pr-4 text-xs">
                          {t("chat.context.windowFillRow")}
                        </td>
                        <td className="py-1 pr-4 text-right text-xs tabular-nums">
                          {fillPct}%
                        </td>
                        <td className="py-1 w-32">
                          <div
                            className="h-1.5 rounded-full bg-muted"
                            role="progressbar"
                            aria-valuenow={fillPct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={t("chat.context.windowFill", {
                              pct: fillPct,
                            })}
                          >
                            <div
                              className={`h-1.5 rounded-full transition-all ${fillTone}`}
                              style={{ width: `${fillPct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* プロンプト全文 */}
            <div>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
                {t("chat.context.fullPrompt")}
              </h3>
              <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs text-foreground">
                {systemPrompt || t("chat.context.emptyPrompt")}
              </pre>
            </div>

            {/* これから送る入力メッセージ */}
            {userMessage && userMessage.trim() && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
                  {t("chat.context.outgoingMessage")}
                </h3>
                <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs text-foreground">
                  {userMessage}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </AnimatedOverlay>
  );
}
