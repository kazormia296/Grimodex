import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAiSettingsStore } from "@/features/chat/store";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { AbConfigForm } from "./AbConfigForm";
import { AbComparePanel, type AbCompareColumnView } from "./AbComparePanel";
import { useAbComparison } from "./useAbComparison";
import { createInlineAbDispatcher } from "./abDispatchers";
import {
  createBaselineSlot,
  createVariantSlot,
  canRunComparison,
  normalizeAbConfig,
  type AbSlot,
} from "./abConfig";
import type { AbMessage } from "./abHarness";

interface AbInlineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** インライン AI のプロンプト messages (system + user)。generateInlineAi と同形。 */
  messages: AbMessage[];
  /** 採用された本文を呼び出し側で挿入する (editor へのアクセスは持たせない)。 */
  onAdopt: (text: string) => void;
}

/**
 * インライン / ビート A/B 比較モーダル (③)。inline-ai streaming を N 枠で**逐次**に
 * 走らせ、採用本文を onAdopt 経由で挿入させる。inline はモデル / プロンプト追記の
 * 上書きのみ (プロバイダ上書きは chat 専用)。
 */
export function AbInlineDialog({
  open,
  onOpenChange,
  projectId,
  messages,
  onAdopt,
}: AbInlineDialogProps) {
  const { t } = useTranslation();
  const defaultModel = useAiSettingsStore((s) => s.settings?.model ?? "");
  const settingsStore = useSettingsStore();

  const [slots, setSlots] = useState<AbSlot[]>(() => [
    createBaselineSlot(),
    createVariantSlot({
      model: settingsStore.get("abTest.defaultModelB", "") || undefined,
      promptVariant:
        settingsStore.get("abTest.defaultPromptVariantB", "") || undefined,
    }),
  ]);

  const dispatch = useMemo(
    () => createInlineAbDispatcher(projectId),
    [projectId],
  );
  const { state, run, adopt, reset, invalidate } = useAbComparison({
    surface: "inline",
    projectId,
    dispatch,
  });

  const runnable = canRunComparison(slots);
  const hasResult = Object.values(state.results).some((r) => r !== null);

  // ダイアログを開くたびに前回結果をクリアする。
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const columns = useMemo<AbCompareColumnView[]>(
    () =>
      slots.map((slot, i) => ({
        id: slot.id,
        label: slot.baseline
          ? t("abTest.baseline")
          : t("abTest.slotLabel", { n: i + 1 }),
        providerLabel: null,
        modelLabel: slot.baseline ? defaultModel : (slot.config.model ?? null),
        promptVariant: slot.baseline
          ? null
          : (slot.config.promptVariant ?? null),
        result: state.results[slot.id] ?? null,
      })),
    [slots, state.results, t, defaultModel],
  );

  const handleRun = useCallback(() => {
    void run(
      { messages },
      slots.map((s) => ({
        id: s.id,
        config: normalizeAbConfig(s.config, false),
      })),
    );
  }, [run, messages, slots]);

  const handleAdopt = useCallback(
    async (slotId: string) => {
      const text = await adopt(slotId);
      if (text !== null) {
        onAdopt(text);
        onOpenChange(false);
      }
    },
    [adopt, onAdopt, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("abTest.inlineTitle")}</DialogTitle>
          <DialogDescription>{t("abTest.inlineDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <AbConfigForm
            slots={slots}
            onChange={setSlots}
            defaultModel={defaultModel}
            allowProviderOverride={false}
            disabled={state.running}
            onInvalidateSlot={invalidate}
          />

          {hasResult && (
            <div className="mt-3 flex min-h-[10rem]">
              <AbComparePanel
                columns={columns}
                running={state.running}
                chosenId={state.chosenId}
                onAdopt={handleAdopt}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={handleRun}
            disabled={state.running || !runnable}
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {state.running ? t("abTest.running") : t("abTest.run")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
