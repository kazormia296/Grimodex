import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LayerBreakdown } from "../contextBuilder";
import { estimateInputCost, formatCost } from "../modelPricing";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { cn } from "@/lib/utils";

interface PromptPreviewModalProps {
  systemPrompt: string;
  layers: LayerBreakdown[];
  totalTokens: number;
  /** 現在のモデル ID。コスト推定に使う。未指定 / 未登録モデルではコスト行を省略 */
  model?: string;
  /** モデルのコンテキストウィンドウ (tokens)。0 / 省略時は fill bar 行も省略 */
  contextWindow?: number;
  /** 直近の実送信プロンプト（related_scenes など送信時のみ計算される内容を
   * 含む）。null = 未送信。存在するとライブ/前回送信の切替が出る。 */
  sentSystemPrompt?: string | null;
  sentLayers?: LayerBreakdown[];
  sentTokens?: number;
  onClose: () => void;
}

export function PromptPreviewModal({
  systemPrompt,
  layers,
  totalTokens,
  model,
  contextWindow,
  sentSystemPrompt,
  sentLayers,
  sentTokens,
  onClose,
}: PromptPreviewModalProps) {
  const { t } = useTranslation();
  // related_scenes（意味検索）はメッセージ依存で送信時のみ計算されるため、
  // ライブプレビューには映らない。実際に送信した内容を確認できるよう、
  // 前回送信のスナップショットがあれば切替を出す。
  const hasSent = sentSystemPrompt != null;
  const [showSent, setShowSent] = useState(false);
  const viewingSent = hasSent && showSent;

  const displaySystemPrompt = viewingSent
    ? (sentSystemPrompt ?? "")
    : systemPrompt;
  const displayLayers = viewingSent ? (sentLayers ?? []) : layers;
  const displayTotalTokens = viewingSent ? (sentTokens ?? 0) : totalTokens;
  const estimatedCost =
    model && displayTotalTokens > 0
      ? estimateInputCost(model, displayTotalTokens)
      : null;
  const costLabel = estimatedCost !== null ? formatCost(estimatedCost) : null;
  const fillPct =
    contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((displayTotalTokens / contextWindow) * 100))
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
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ライブ / 前回送信 の切替。送信したことがある場合のみ表示。
            related_scenes（意味検索）は送信時のみ計算されライブには映らない。 */}
        {hasSent && (
          <div>
            <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setShowSent(false)}
                className={cn(
                  "rounded px-2 py-1",
                  !showSent
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {t("chat.context.promptViewLive", "ライブ")}
              </button>
              <button
                type="button"
                onClick={() => setShowSent(true)}
                className={cn(
                  "rounded px-2 py-1",
                  showSent
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {t("chat.context.promptViewLastSent", "前回送信")}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {viewingSent
                ? t(
                    "chat.context.promptViewLastSentHint",
                    "実際に送信したプロンプト。related_scenes（意味検索）はこの送信時のメッセージに基づきます。",
                  )
                : t(
                    "chat.context.promptViewLiveHint",
                    "現在の文脈のプレビュー。related_scenes は送信時に追加されるためここには出ません。",
                  )}
            </p>
          </div>
        )}
        {/* レイヤー別内訳テーブル */}
        {displayLayers.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
              {t("chat.context.layerBreakdown")}
            </h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-1 pr-4">{t("chat.context.layerColumn")}</th>
                  <th className="pb-1 pr-4 text-right">
                    {t("chat.context.usedTokens")}
                  </th>
                  <th className="pb-1">{t("chat.context.usageRate")}</th>
                </tr>
              </thead>
              <tbody>
                {displayLayers.map((layer) => {
                  const pct =
                    displayTotalTokens > 0
                      ? Math.round((layer.used / displayTotalTokens) * 100)
                      : 0;
                  return (
                    <tr key={layer.layer} className="border-b border-border/40">
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
                  <td className="py-1 pr-4">{t("chat.context.totalRow")}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">
                    {displayTotalTokens.toLocaleString()}
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
            {displaySystemPrompt || t("chat.context.emptyPrompt")}
          </pre>
        </div>
      </div>
    </AnimatedOverlay>
  );
}
