import { Download, Search, Settings, Smartphone, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PhoneHistoryActions } from "./PhoneHistoryActions";

interface PhoneMoreSurfaceProps {
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenImport?: () => void;
  onOpenExport?: () => void;
  onContinueInGrimodex?: () => void;
  workspaceControls?: ReactNode;
}

export function PhoneMoreSurface({
  onOpenSearch,
  onOpenSettings,
  onOpenImport,
  onOpenExport,
  onContinueInGrimodex,
  workspaceControls,
}: PhoneMoreSurfaceProps) {
  const { t } = useTranslation();
  const actions = [
    {
      id: "search",
      label: t("mobileWorkspace.surfaces.more.search"),
      icon: Search,
      onClick: onOpenSearch,
    },
    {
      id: "settings",
      label: t("app.settingsLabel"),
      icon: Settings,
      onClick: onOpenSettings,
    },
    ...(onOpenImport
      ? [
          {
            id: "import",
            label: t("project.import.action"),
            icon: Upload,
            onClick: onOpenImport,
          },
        ]
      : []),
    ...(onOpenExport
      ? [
          {
            id: "export",
            label: t("app.exportLabel"),
            icon: Download,
            onClick: onOpenExport,
          },
        ]
      : []),
    ...(onContinueInGrimodex
      ? [
          {
            id: "handoff",
            label: t("hostedEditor.trial.continueInGrimodex"),
            icon: Smartphone,
            onClick: onContinueInGrimodex,
          },
        ]
      : []),
  ];

  return (
    <section
      aria-label={t("mobileWorkspace.navigation.more")}
      data-phone-more-surface
      className="grid content-start gap-4 p-4"
    >
      <p className="text-sm text-muted-foreground">
        {t("mobileWorkspace.surfaces.more.description")}
      </p>
      {workspaceControls}
      <PhoneHistoryActions />
      <div className="grid gap-2">
        {actions.map(({ id, label, icon: Icon, onClick }) => (
          <button
            key={id}
            type="button"
            className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-card px-4 text-left text-sm font-medium"
            onClick={onClick}
          >
            <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
