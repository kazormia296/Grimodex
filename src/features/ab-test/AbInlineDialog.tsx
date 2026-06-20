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
import { AbComparePanel } from "./AbComparePanel";
import { useAbComparison } from "./useAbComparison";
import { createInlineAbDispatcher } from "./abDispatchers";
import { deriveAbConfigs, isAbConfigMeaningful, type AbMode } from "./abConfig";
import type { AbConfig, AbMessage } from "./abHarness";

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
 * インライン / ビート A/B 比較モーダル (③)。inline-ai streaming を 2 構成
 * (モデル / プロンプト) で並列に走らせ、採用本文を onAdopt 経由で挿入させる。
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

  const [mode, setMode] = useState<AbMode>("model");
  const [configB, setConfigB] = useState<AbConfig>(() => ({
    model: settingsStore.get("abTest.defaultModelB", "") || undefined,
    promptVariant:
      settingsStore.get("abTest.defaultPromptVariantB", "") || undefined,
  }));

  const dispatch = useMemo(
    () => createInlineAbDispatcher(projectId),
    [projectId],
  );
  const { state, run, adopt, reset, clearSideB } = useAbComparison({
    surface: "inline",
    projectId,
    dispatch,
  });

  const { configA, configB: resolvedB } = useMemo(
    () => deriveAbConfigs(mode, configB),
    [mode, configB],
  );
  const meaningful = isAbConfigMeaningful(mode, configB);
  const hasResult = state.resultA !== null || state.resultB !== null;

  // ダイアログを開くたびに前回結果をクリアする。
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  // mode 切替で B の構成が変わると表示中の B 応答が stale になる → 破棄。
  // A は構成不変なので残し、次の実行で使い回す。
  const handleModeChange = useCallback(
    (next: AbMode) => {
      if (next === mode) return;
      setMode(next);
      clearSideB();
    },
    [mode, clearSideB],
  );

  const handleRun = useCallback(() => {
    void run({ messages }, configA, resolvedB);
  }, [run, messages, configA, resolvedB]);

  const handleAdopt = useCallback(
    async (side: "a" | "b") => {
      const text = await adopt(side);
      if (text !== null) {
        onAdopt(text);
        onOpenChange(false);
      }
    },
    [adopt, onAdopt, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("abTest.inlineTitle")}</DialogTitle>
          <DialogDescription>{t("abTest.inlineDescription")}</DialogDescription>
        </DialogHeader>

        <AbConfigForm
          mode={mode}
          onModeChange={handleModeChange}
          defaultModel={defaultModel}
          configB={configB}
          onConfigBChange={setConfigB}
          disabled={state.running}
        />

        {hasResult && (
          <div className="flex min-h-[10rem] flex-1 overflow-hidden">
            <AbComparePanel
              configA={configA}
              configB={resolvedB}
              resultA={state.resultA}
              resultB={state.resultB}
              running={state.running}
              chosen={state.chosen}
              onAdopt={handleAdopt}
            />
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={handleRun}
            disabled={state.running || !meaningful}
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {state.running ? t("abTest.running") : t("abTest.run")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
