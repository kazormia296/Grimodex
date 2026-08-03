import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/lib/dialog";
import { useWorkspaceStore } from "./store";
import type { RecentWorkspace } from "./store";
import { cn } from "@/lib/utils";
import { TitleBar } from "@/components/TitleBar";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { requestWebEditorHandoffImport } from "@/features/import/webEditorHandoffRequest";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { recordActiveWorkspaceLauncherPaint } from "./workspaceOpenTrace";

export function LauncherScreen() {
  const { t } = useTranslation();
  const runtimeCapabilities = useRuntimeCapabilities();
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);
  const requestOpenWorkspace = useWorkspaceStore((s) => s.requestOpenWorkspace);
  const openRecentWorkspace = useWorkspaceStore((s) => s.openRecentWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const workspaceOpenRequestInProgress = useWorkspaceStore(
    (s) => s.workspaceOpenRequestInProgress,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (s) => s.workspaceSwitchInProgress,
  );
  const [opening, setOpening] = useState<string | null>(null);

  const recentWorkspaces = globalSettings?.recentWorkspaces ?? [];
  const workspaceBusy =
    workspaceOpenRequestInProgress || workspaceSwitchInProgress;

  useEffect(() => {
    let paintedFrame: number | null = null;
    const committedFrame = requestAnimationFrame(() => {
      paintedFrame = requestAnimationFrame(() => {
        recordActiveWorkspaceLauncherPaint();
      });
    });
    return () => {
      cancelAnimationFrame(committedFrame);
      if (paintedFrame !== null) cancelAnimationFrame(paintedFrame);
    };
  }, []);

  async function handleOpenRecent(path: string) {
    if (workspaceBusy) return;
    clearError();
    setOpening(path);
    try {
      await openRecentWorkspace(path, "launcher-card");
    } catch (error) {
      debugLog.error(
        "workspaceLauncher",
        "recent workspace request failed",
        errorDetail(error),
      );
    } finally {
      setOpening(null);
    }
  }

  async function handleBrowse() {
    if (workspaceBusy) return;
    clearError();
    try {
      const path = await openFolderDialog();
      if (!path) return;
      setOpening(path);
      await requestOpenWorkspace(path, "folder-picker");
    } catch (error) {
      debugLog.error(
        "workspaceLauncher",
        "workspace picker request failed",
        errorDetail(error),
      );
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background text-foreground">
      <TitleBar />
      <div className="flex w-full max-w-lg flex-col gap-6 px-8">
        <GrimodexLogo height={32} className="text-foreground" />

        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
            {t("launcher.recentWorkspaces")}
          </h2>
          {recentWorkspaces.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("launcher.noWorkspaces")}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {recentWorkspaces.map((ws) => (
                <WorkspaceItem
                  key={ws.path}
                  workspace={ws}
                  isOpening={opening === ws.path}
                  disabled={workspaceBusy}
                  onOpen={() => handleOpenRecent(ws.path)}
                />
              ))}
            </ul>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleBrowse}
            disabled={workspaceBusy}
            className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t("launcher.openFolder")}
          </button>
          <button
            type="button"
            onClick={handleBrowse}
            disabled={workspaceBusy}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("launcher.newWorkspace")}
          </button>
        </div>
        {runtimeCapabilities.genericProjectTransfer && (
          <button
            type="button"
            onClick={requestWebEditorHandoffImport}
            className="self-center text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("hostedEditor.desktopImport.action")}
          </button>
        )}
      </div>
    </div>
  );
}

function WorkspaceItem({
  workspace,
  isOpening,
  disabled,
  onOpen,
}: {
  workspace: RecentWorkspace;
  isOpening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  function folderName(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  }

  return (
    <li
      className={cn(
        "flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/50",
        (isOpening || disabled) && "opacity-50",
      )}
      aria-disabled={disabled || undefined}
      onClick={isOpening || disabled ? undefined : onOpen}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {folderName(workspace.path)}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {workspace.path}
        </p>
      </div>
    </li>
  );
}
