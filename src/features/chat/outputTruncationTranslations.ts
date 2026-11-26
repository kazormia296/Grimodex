import i18next from "@/lib/i18n";

/**
 * 出力の打ち切りの注記と「続行」の説明。打ち切られたときにしか出ないので、起動時の
 * 辞書（`src/locales/*.json`）に入れず、ChatPanel の遅延 chunk で登録する。
 */
export const OUTPUT_TRUNCATION_TRANSLATIONS = {
  ja: {
    chat: {
      outputTruncated: "応答が途中で打ち切られました（出力の上限など）。",
      agentContinueOutputHint:
        "続けると、必要な情報を読み直して残りを実行します。",
    },
  },
  en: {
    chat: {
      outputTruncated:
        "The response was cut off partway (output limit or similar).",
      agentContinueOutputHint:
        "Continuing reads the needed information again and does the rest.",
    },
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureOutputTruncationTranslations(): void {
  if (installed) return;
  for (const [language, resources] of Object.entries(
    OUTPUT_TRUNCATION_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(language, "translation", resources, true, false);
  }
  installed = true;
}

ensureOutputTruncationTranslations();
