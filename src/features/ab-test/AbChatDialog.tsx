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
import { AbConfigForm } from "./AbConfigForm";
import { AbComparePanel } from "./AbComparePanel";
import { useAbComparison } from "./useAbComparison";
import { createChatAbDispatcher } from "./abDispatchers";
import { deriveAbConfigs, isAbConfigMeaningful, type AbMode } from "./abConfig";
import type { AbConfig } from "./abHarness";

interface AbChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /**
   * 比較にかける基底プロンプト。ChatPanel 側で buildPromptForCopy(draft) などで
   * 組み立てて渡す。ライブストリームには一切触れず、この文字列を 1 user
   * メッセージとして 2 構成へ並列送信する。
   */
  basePrompt: string;
}

/**
 * チャット A/B 比較モーダル (③)。**ライブ ChatPanel のストリーム描画は不可侵**。
 * 同一プロンプトをモデル/プロンプト 2 構成へ非ストリーミングで並列送信し、
 * 2 カラムで見比べて採用を記録する専用サーフェス。
 */
export function AbChatDialog({
  open,
  onOpenChange,
  projectId,
  basePrompt,
}: AbChatDialogProps) {
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
    () => createChatAbDispatcher(projectId),
    [projectId],
  );
  const { state, run, adopt, reset } = useAbComparison({
    surface: "chat",
    projectId,
    dispatch,
  });

  const { configA, configB: resolvedB } = deriveAbConfigs(mode, configB);
  const meaningful = isAbConfigMeaningful(mode, configB);
  const hasResult = state.resultA !== null || state.resultB !== null;

  const handleRun = useCallback(() => {
    if (!basePrompt.trim()) {
      toast.error(t("abTest.emptyPrompt"));
      return;
    }
    void run(
      { messages: [{ role: "user", content: basePrompt }] },
      configA,
      resolvedB,
    );
  }, [basePrompt, run, configA, resolvedB, t]);

  const handleAdopt = useCallback(
    async (side: "a" | "b") => {
      const text = await adopt(side);
      if (text !== null) {
        await navigator.clipboard?.writeText(text).catch(() => {});
        toast.success(t("abTest.adoptedToClipboard"));
      }
    },
    [adopt, t],
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
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("abTest.chatTitle")}</DialogTitle>
          <DialogDescription>{t("abTest.chatDescription")}</DialogDescription>
        </DialogHeader>

        <AbConfigForm
          mode={mode}
          onModeChange={setMode}
          defaultModel={defaultModel}
          configB={configB}
          onConfigBChange={setConfigB}
        />

        {hasResult && (
          <div className="flex min-h-[10rem] flex-1 overflow-hidden">
            <AbComparePanel
              configA={configA}
              configB={resolvedB}
              resultA={state.resultA}
              resultB={state.resultB}
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
