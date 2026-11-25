import i18next from "@/lib/i18n";

/**
 * 終了や切替の前の確認の文。出るときにしか要らないので、起動時の辞書
 * （`src/locales/*.json`）に入れず、確認の遅延 chunk で登録する。
 */
export const CHAT_STOP_CONFIRM_TRANSLATIONS = {
  ja: {
    chatStop: {
      title: "応答を生成中です",
      closeDescription:
        "中断して終了しますか？途中までの応答は「停止」として保存します。",
      closeConfirm: "中断して終了",
      switchDescription:
        "中断して切り替えますか？途中までの応答は「停止」として保存します。",
      switchConfirm: "中断して切り替える",
    },
  },
  en: {
    chatStop: {
      title: "A response is still being generated",
      closeDescription:
        "Stop it and close? The partial response is saved as stopped.",
      closeConfirm: "Stop and close",
      switchDescription:
        "Stop it and switch? The partial response is saved as stopped.",
      switchConfirm: "Stop and switch",
    },
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureChatStopConfirmTranslations(): void {
  if (installed) return;
  for (const [language, resources] of Object.entries(
    CHAT_STOP_CONFIRM_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(language, "translation", resources, true, false);
  }
  installed = true;
}

ensureChatStopConfirmTranslations();
