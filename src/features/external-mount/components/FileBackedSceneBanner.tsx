import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";

export function FileBackedSceneBanner() {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground"
      data-testid="file-backed-scene-banner"
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span>{t("externalMount.banner")}</span>
    </div>
  );
}
