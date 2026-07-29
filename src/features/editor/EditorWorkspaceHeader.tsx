import { FileOutput, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import type { PanelId } from "@/features/layout/panelIds";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { ProjectMenu } from "@/features/project/ProjectMenu";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { UpdateDot } from "@/features/updater/UpdateDot";
import { useUpdatePending } from "@/features/updater/updaterStore";
import { HistoryButtons } from "@/features/history/HistoryButtons";
import { HeaderBarLayout } from "@/components/HeaderBarLayout";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { WindowControls } from "@/components/WindowControls";
import { requestWebEditorHandoffImport } from "@/features/import/webEditorHandoffRequest";
import { cn } from "@/lib/utils";

interface EditorWorkspaceHeaderProps {
  runtimeCapabilities: RuntimeCapabilities;
  screenshotPanelId: PanelId | null;
  panelWindow: boolean;
  phoneWorkspace: boolean;
  editorZenMode: boolean;
  mac: boolean;
  onOpenTransfer: (tab: TransferTab) => void;
  onOpenSnapshot: () => void;
  onToggleExport: () => void;
  onOpenSettings: () => void;
}

export function EditorWorkspaceHeader({
  runtimeCapabilities,
  screenshotPanelId,
  panelWindow,
  phoneWorkspace,
  editorZenMode,
  mac,
  onOpenTransfer,
  onOpenSnapshot,
  onToggleExport,
  onOpenSettings,
}: EditorWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const updatePending = useUpdatePending();

  if (editorZenMode || phoneWorkspace) return null;

  return panelWindow ? (
    <header
      data-header-bar
      className="flex h-9 shrink-0 items-center border-b border-border"
    >
      <div data-tauri-drag-region className="h-full flex-1" />
      {!mac && <WindowControls />}
    </header>
  ) : (
    <HeaderBarLayout
      mac={mac}
      className={cn(screenshotPanelId && "no-screenshot")}
      left={
        <>
          <GrimodexLogo height={24} className="text-foreground" />
          <WorkspaceMenu />
          <ProjectMenu
            onOpenImport={
              runtimeCapabilities.localFileImport
                ? () => onOpenTransfer("import")
                : undefined
            }
            onOpenExport={
              runtimeCapabilities.genericProjectTransfer
                ? () => onOpenTransfer("zip")
                : undefined
            }
            onOpenSnapshot={onOpenSnapshot}
            onOpenWebEditorHandoff={
              runtimeCapabilities.genericProjectTransfer
                ? requestWebEditorHandoffImport
                : undefined
            }
          />
          <HistoryButtons />
          {runtimeCapabilities.genericProjectTransfer && (
            <button
              type="button"
              data-tour-target="export-button"
              aria-label={t("app.exportLabel")}
              title={t("app.exportTitle")}
              onClick={onToggleExport}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileOutput className="h-4 w-4 shrink-0" />
              <span className="hidden whitespace-nowrap text-sm xl:inline">
                {t("app.exportLabel")}
              </span>
            </button>
          )}
        </>
      }
      center={null}
      right={
        <>
          <LayoutPresetDropdown />
          <PanelToggleDropdown />
          <button
            type="button"
            aria-label={
              updatePending
                ? t("app.settingsLabelUpdateAvailable", {
                    defaultValue: "設定（更新があります）",
                  })
                : t("app.settingsLabel")
            }
            title={t("app.settingsTitle")}
            onClick={onOpenSettings}
            className="relative flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings className="h-4 w-4 shrink-0" />
            <span className="hidden whitespace-nowrap text-sm xl:inline">
              {t("app.settingsLabel")}
            </span>
            <UpdateDot className="absolute right-1 top-1" />
          </button>
          {!mac && (
            <>
              <div className="h-4 w-px bg-border" />
              <WindowControls />
            </>
          )}
        </>
      }
    />
  );
}
