import i18next from "@/lib/i18n";

/**
 * The strings of the profile activation's AI terminals (D-10 (a), DR-DA2-34),
 * keyed under `profileEgressAiStop` and read by `aiFailureText`
 * (`profileEgressAiStop.ts`). The chat panel imports this module, so the
 * strings are part of its lazy chunk and not of the startup JS graph
 * (DR-DA2-30).
 *
 * Unlike the status display these are not behind
 * `PROFILE_ACTIVATION_UI_ENABLED`: the codes reach the renderer only after an
 * activation began in this process, which the product cannot start while
 * Native's gate is closed, and when they do arrive (the CI seam) a fixed
 * sentence replaces the raw marker. Draft wording for Session C-1.
 */
export const PROFILE_EGRESS_AI_STOP_TRANSLATIONS = {
  ja: {
    stopped:
      "外部送信の制限を有効にする処理が始まったため、AI の処理を止めました。",
    discarded: "外部送信の制限が始まった後に完了した AI の結果は返しません。",
  },
  en: {
    stopped:
      "The AI request was stopped because the external sending restriction is being turned on.",
    discarded:
      "An AI result completed after the external sending restriction began is not returned.",
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureProfileEgressAiStopTranslations(): void {
  if (installed) return;
  for (const [language, profileEgressAiStop] of Object.entries(
    PROFILE_EGRESS_AI_STOP_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(
      language,
      "translation",
      { profileEgressAiStop },
      true,
      true,
    );
  }
  installed = true;
}
