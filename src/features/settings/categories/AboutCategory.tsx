import { useTranslation } from "react-i18next";
import { AppInfoHeader } from "./about/AppInfoHeader";
import { CollapsibleDocSection } from "./about/CollapsibleDocSection";
import { LicensesSection } from "./about/LicensesSection";

export function AboutCategory() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <AppInfoHeader />
      <div className="flex-1 overflow-y-auto p-4">
        <CollapsibleDocSection
          title={t("settings.about.terms.title")}
          description={t("settings.about.terms.description")}
          src="TERMS_ja.md"
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
