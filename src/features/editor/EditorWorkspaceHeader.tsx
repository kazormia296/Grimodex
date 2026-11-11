import { FileOutput, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import type { PanelId } from "@/features/layout/panelIds";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { UpdateDot } from "@/features/updater/UpdateDot";
import { useUpdatePending } from "@/features/updater/updaterStore";
import { HistoryButtons } from "@/features/history/HistoryButtons";
import { HeaderBarLayout } from "@/components/HeaderBarLayout";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { WorkPulse } from "@/features/work-layer/WorkPulse";

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
          {/* ロゴは縮めない。窓幅 1680px 未満は本の記号だけにして、幅をメニューに回す。 */}
          <GrimodexLogo
            height={24}
            variant="mark"
            className="shrink-0 text-foreground min-[1680px]:hidden"
          />
          <GrimodexLogo
            height={24}
            className="hidden shrink-0 text-foreground min-[1680px]:block"
          />
          {/* ロゴの後ろの 3 つ（統合メニュー・元に戻す／やり直す・書き出し）を
              名前付きの container（header-menu）にまとめる。メニューの後ろの固定分は
              132px（12+32+12+32+12+32）で一定なので、この内容幅が 288px 未満のとき
              （メニューに残る幅が、フォルダ名を出すトリガーの最小幅 約 147px を切るとき）
              はメニューがフォルダ名を隠す。並びは左詰めのままで見た目は変わらない。 */}
          <div
            data-tauri-drag-region
            data-header-menu-group
            className="@container/header-menu flex min-w-0 flex-1 items-center gap-3"
          >
            <WorkspaceMenu
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
            />
            <HistoryButtons />
            {runtimeCapabilities.genericProjectTransfer && (
              // どの幅でもアイコンだけ。名前は aria-label、ショートカットは title に。
              <button
                type="button"
                data-tour-target="export-button"
                aria-label={t("app.exportLabel")}
                title={t("app.exportTitle")}
                onClick={onToggleExport}
                className="flex h-8 shrink-0 items-center rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FileOutput className="h-4 w-4 shrink-0" />
              </button>
            )}
          </div>
        </>
      }
      center={<WorkPulse />}
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
