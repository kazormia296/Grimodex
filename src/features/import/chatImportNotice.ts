import i18next from "@/lib/i18n";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";

/**
 * The notice of the conversations an import did not take in (K3/2 "chat の
 * 書込みの入口" 9: shown, never dropped silently; DR-DA2B-R7).
 *
 * The count and a neutral reason are shown whatever the constant: they name
 * no restriction (no Session C-1 wording) and appear only when the
 * conversation part was refused (restricted, or the activation in progress).
 * The restricted reason itself is D wording behind
 * `PROFILE_ACTIVATION_UI_ENABLED` (D-13 (a)), in the lazy
 * `profileEgressTranslations` chunk; while it is false the bundler drops the
 * branch and its dynamic import. The strings live in this lazy import chunk, not in
 * `src/locales/*.json` (DR-DA2-30).
 */
const CHAT_IMPORT_NOTICE = {
  ja: {
    notImported:
      "会話 {{count}} 件は取り込みませんでした。ほかの項目の取込みは完了しています。",
  },
  en: {
    notImported:
      "{{count}} conversation(s) were not imported. The other items were imported.",
  },
} as const;

let installed = false;

function ensureChatImportNotice(): void {
  if (installed) return;
  for (const [language, importChat] of Object.entries(CHAT_IMPORT_NOTICE)) {
    i18next.addResourceBundle(
      language,
      "translation",
      { importChat },
      true,
      true,
    );
  }
  installed = true;
}

async function restrictedNotice(count: number): Promise<string> {
  const { ensureProfileEgressTranslations } =
    await import("@/features/profile-egress/profileEgressTranslations");
  ensureProfileEgressTranslations();
  return i18next.t("profileEgress.import.chatsRestricted", { count });
}

function neutralNotice(count: number): string {
  ensureChatImportNotice();
  return i18next.t("importChat.notImported", { count });
}

export function chatImportNotice(count: number): Promise<string> {
  return PROFILE_ACTIVATION_UI_ENABLED
    ? restrictedNotice(count)
    : Promise.resolve(neutralNotice(count));
}
