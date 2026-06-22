import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { AbSlotCard } from "./AbSlotCard";
import { createVariantSlot, type AbSlot } from "./abConfig";
import type { AbConfig } from "./abHarness";

interface AbConfigFormProps {
  slots: AbSlot[];
  onChange: (slots: AbSlot[]) => void;
  /** 基準 (A 側) のモデル名。表示専用。 */
  defaultModel: string;
  /** 基準のプロバイダ表示ラベル (chat のみ)。空なら非表示。 */
  defaultProviderLabel?: string;
  /** provider 上書きを許可するか (chat=true / inline=false)。 */
  allowProviderOverride: boolean;
  /** 枠の上限 (基準含む)。既定 5。 */
  maxSlots?: number;
  /**
   * 実行中などで構成変更を止めたいとき true。実行中に枠を編集/追加/削除すると
   * 完了した run が結果を上書きしてしまうのを防ぐ。
   */
  disabled?: boolean;
  /** 枠の構成が変わったとき、その枠の表示結果を破棄させる (stale 化対策)。 */
  onInvalidateSlot?: (id: string) => void;
}

/**
 * A/B の枠 (スロット) 一覧エディタ。
 * - 1 枠目 (基準): 現在の既定 (provider / model) を固定表示。編集不可・再生成は使い回し。
 * - 2 枠目以降 (変種): provider / model / プロンプト追記を各々自由に上書き。追加・削除可。
 */
export function AbConfigForm({
  slots,
  onChange,
  defaultModel,
  defaultProviderLabel,
  allowProviderOverride,
  maxSlots = 5,
  disabled = false,
  onInvalidateSlot,
}: AbConfigFormProps) {
  const { t } = useTranslation();
  const canAdd = slots.length < maxSlots;

  const updateSlot = (id: string, config: AbConfig) => {
    onChange(slots.map((s) => (s.id === id ? { ...s, config } : s)));
    // 構成が変わった枠の表示結果は stale → 破棄させる。
    onInvalidateSlot?.(id);
  };

  const removeSlot = (id: string) => {
    onChange(slots.filter((s) => s.id !== id));
    // 削除した枠の表示結果・採用記録 (recordId) も破棄する (stale な列/記録を残さない)。
    onInvalidateSlot?.(id);
  };

  const addSlot = () => {
    if (!canAdd) return;
    onChange([...slots, createVariantSlot({})]);
  };

  return (
    <div className="space-y-2">
      {/* 基準枠 (固定) */}
      <div className="rounded-lg border border-border bg-muted/30 p-2.5">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("abTest.baseline")}
        </div>
        <div className="text-sm text-foreground">
          {defaultProviderLabel ? (
            <span className="text-muted-foreground">
              {defaultProviderLabel} /{" "}
            </span>
          ) : null}
          {defaultModel.trim() || t("abTest.defaultModel")}
        </div>
      </div>

      {/* 変種枠 (2 枠目以降) */}
      {slots.map((slot, i) =>
        slot.baseline ? null : (
          <AbSlotCard
            key={slot.id}
            index={i + 1}
            config={slot.config}
            onChange={(config) => updateSlot(slot.id, config)}
            onRemove={() => removeSlot(slot.id)}
            allowProviderOverride={allowProviderOverride}
            disabled={disabled}
          />
        ),
      )}

      <button
        type="button"
        onClick={addSlot}
        disabled={disabled || !canAdd}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {canAdd
          ? t("abTest.addSlot")
          : t("abTest.maxSlotsReached", { max: maxSlots })}
      </button>
    </div>
  );
}
