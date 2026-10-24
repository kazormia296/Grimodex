import i18next from "@/lib/i18n";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";

/**
 * The notice of the conversations an import did not take in (K3/2 "chat の
 * 書込みの入口" 9: shown, never dropped silently; DR-DA2B-R7).
 *
 * The count is shown whatever the constant: it names no restriction (no
 * Session C-1 wording) and appears only when the conversation part was
 * refused (restricted, or the activation in progress). It says nothing about
 * the other items: their own errors, if any, are listed beside it.
 * The restricted reason itself is D wording behind
 * `PROFILE_ACTIVATION_UI_ENABLED` (D-13 (a)), in the lazy
 * `profileEgressTranslations` chunk; while it is false the bundler drops the
 * branch and its dynamic import. The strings live in this lazy import chunk, not in
 * `src/locales/*.json` (DR-DA2-30).
 */
const CHAT_IMPORT_NOTICE = {
  ja: {
    notImported: "会話 {{count}} 件は取り込みませんでした。",
  },
  en: {
    notImported: "{{count}} conversation(s) were not imported.",
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
