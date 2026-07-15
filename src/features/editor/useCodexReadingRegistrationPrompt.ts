import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useCodexStore } from "@/features/codex/codexStore";
import { resolveUnsetReadingTargetForSurface } from "@/features/codex/reading";
import { useSettingBoolean } from "@/features/settings/useSettingControl";

export const CODEX_READING_PROMPT_SETTING_KEY =
  "editor.promptCodexReadingOnRuby";

const CODEX_READING_PROMPT_TOAST_ID = "codex-reading-registration-prompt";

async function registerReadingIfStillUnset(
  targetId: string,
  surface: string,
  reading: string,
): Promise<void> {
  const store = useCodexStore.getState();
  const latest = resolveUnsetReadingTargetForSurface(
    surface,
    store.completionTargets,
  );
  // トースト表示後の改名・alias 削除・衝突・別経路の読み保存を上書きしない。
  if (!latest || latest.id !== targetId) return;
  await store.registerRubyReading(latest.id, surface, reading);
}

/** 手動ルビを一意な Codex 表記の未設定読みとして保存する確認を提示する。 */
export function useCodexReadingRegistrationPrompt(): (
  surface: string,
  annotation: string,
) => void {
  const { t } = useTranslation();
  const { value: promptEnabled, setValue: setPromptEnabled } =
    useSettingBoolean(CODEX_READING_PROMPT_SETTING_KEY, true);

  return useCallback(
    (surface: string, annotation: string) => {
      const reading = annotation.trim();
      if (!promptEnabled || !surface || !reading) return;

      const target = resolveUnsetReadingTargetForSurface(
        surface,
        useCodexStore.getState().completionTargets,
      );
      if (!target) return;

      toast(t("editor.toolbar.codexReadingPromptTitle", { surface }), {
        id: CODEX_READING_PROMPT_TOAST_ID,
        description: t("editor.toolbar.codexReadingPromptDescription", {
          surface,
          reading,
        }),
        duration: 12000,
        closeButton: true,
        action: {
          label: t("editor.toolbar.codexReadingPromptRegister"),
          onClick: () =>
            registerReadingIfStillUnset(target.id, surface, reading),
        },
        cancel: {
          label: t("editor.toolbar.codexReadingPromptDisable"),
          onClick: () => {
            setPromptEnabled(false);
            toast.dismiss(CODEX_READING_PROMPT_TOAST_ID);
          },
        },
      });
    },
    [promptEnabled, setPromptEnabled, t],
  );
}
