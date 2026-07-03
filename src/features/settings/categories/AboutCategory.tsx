import { useTranslation } from "react-i18next";
import { AppInfoHeader } from "./about/AppInfoHeader";
import { CollapsibleDocSection } from "./about/CollapsibleDocSection";
import { LicensesSection } from "./about/LicensesSection";

export function AboutCategory() {
  const { t, i18n } = useTranslation();

  // 規約表示は UI 言語に合わせて英訳/日本語版を切り替える（EULA ダイアログと一貫）。
  // 英訳は参考訳で、法的正本は日本語版（TERMS_ja.md）。
  const termsSrc = i18n.language?.startsWith("en")
    ? "TERMS_en.md"
    : "TERMS_ja.md";

  return (
    <div className="flex h-full flex-col">
      <AppInfoHeader />
      <div className="flex-1 overflow-y-auto p-4">
        <CollapsibleDocSection
          title={t("settings.about.terms.title")}
          description={t("settings.about.terms.description")}
          src={termsSrc}
        />
        <CollapsibleDocSection
          title={t("settings.about.developerMessage.title")}
          description={t("settings.about.developerMessage.description")}
          src="DEVELOPER_MESSAGE_ja.md"
        />
        <LicensesSection />
      </div>
    </div>
  );
}
