import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import type { AiProvider } from "@/features/chat/types";
import { AbConfigForm } from "./AbConfigForm";
import { AbComparePanel, type AbCompareColumnView } from "./AbComparePanel";
import { useAbComparison } from "./useAbComparison";
import { createChatAbDispatcher } from "./abDispatchers";
import {
  createBaselineSlot,
  createVariantSlot,
  canRunComparison,
  normalizeAbConfig,
  AB_PROVIDER_LABELS,
  type AbSlot,
} from "./abConfig";

interface AbChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /**
   * 比較にかける基底プロンプト。ChatPanel 側で buildPromptForCopy(draft) などで
   * 組み立てて渡す。ライブストリームには一切触れず、この文字列を 1 user
   * メッセージとして全枠へ並列送信する。
   */
  basePrompt: string;
  /**
   * 採用ハンドラ。採用枠のテキストと解決済みモデルを呼び出し側へ渡す。
   * clipboard コピーは廃止し、呼び出し側 (ChatInput) がそのチャットの会話履歴へ
   * 1 往復として積む。
   */
  onAdopt: (result: {
    text: string;
    /** 採用枠の実モデル (未指定の既定なら null)。 */
    model: string | null;
  }) => void | Promise<void>;
}

/**
 * チャット A/B 比較モーダル (③)。**ライブ ChatPanel のストリーム描画は不可侵**。
 * 同一プロンプトを N 枠 (基準 + 任意数の変種) へ非ストリーミングで並列送信し、
 * 横並びで見比べて採用を記録する専用サーフェス。変種枠はプロバイダ / モデル /
 * プロンプト追記を各々自由に上書きできる。
 */
export function AbChatDialog({
  open,
  onOpenChange,
  projectId,
  basePrompt,
  onAdopt,
}: AbChatDialogProps) {
  const { t } = useTranslation();
  const defaultModel = useAiSettingsStore((s) => s.settings?.model ?? "");
  const defaultProvider = useAiSettingsStore((s) => s.settings?.provider);
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
    () => createChatAbDispatcher(projectId),
    [projectId],
  );
  const { state, run, adopt, reset, invalidate } = useAbComparison({
    surface: "chat",
    projectId,
    dispatch,
  });

  const runnable = canRunComparison(slots);
  const hasResult = Object.values(state.results).some((r) => r !== null);

  const defaultProviderLabel = defaultProvider
    ? AB_PROVIDER_LABELS[defaultProvider]
    : undefined;

  // 枠 → 比較列の表示データ。基準は既定 provider/model を、変種は枠の上書き値を見せる。
  const columns = useMemo<AbCompareColumnView[]>(
    () =>
      slots.map((slot, i) => {
        if (slot.baseline) {
          return {
            id: slot.id,
            label: t("abTest.baseline"),
            providerLabel: defaultProviderLabel,
            modelLabel: defaultModel,
            promptVariant: null,
            result: state.results[slot.id] ?? null,
          };
        }
        const provider = slot.config.provider?.trim() as AiProvider | undefined;
        return {
          id: slot.id,
          label: t("abTest.slotLabel", { n: i + 1 }),
          providerLabel: provider ? AB_PROVIDER_LABELS[provider] : null,
          modelLabel: slot.config.model ?? null,
          promptVariant: slot.config.promptVariant ?? null,
          result: state.results[slot.id] ?? null,
        };
      }),
    [slots, state.results, t, defaultProviderLabel, defaultModel],
  );

  const handleRun = useCallback(() => {
    if (!basePrompt.trim()) {
      toast.error(t("abTest.emptyPrompt"));
      return;
    }
    void run(
      { messages: [{ role: "user", content: basePrompt }] },
      slots.map((s) => ({
        id: s.id,
        config: normalizeAbConfig(s.config, true),
      })),
    );
  }, [basePrompt, run, slots, t]);

  const handleAdopt = useCallback(
    async (slotId: string) => {
      const text = await adopt(slotId);
      if (text === null) return;
      const slot = slots.find((s) => s.id === slotId);
      const cfg = slot?.config ?? {};
      // 採用枠の実モデルを解決 (基準 / model 未指定なら defaultModel)。
      const model = cfg.model?.trim() || defaultModel.trim() || null;
      await onAdopt({ text, model });
    },
    [adopt, onAdopt, slots, defaultModel],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("abTest.chatTitle")}</DialogTitle>
          <DialogDescription>{t("abTest.chatDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <AbConfigForm
            slots={slots}
            onChange={setSlots}
            defaultModel={defaultModel}
            defaultProviderLabel={defaultProviderLabel}
            allowProviderOverride
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
