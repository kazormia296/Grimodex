import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/lib/dialog";
import { useWorkspaceStore } from "./store";
import type { RecentWorkspace } from "./store";
import { cn } from "@/lib/utils";
import { TitleBar } from "@/components/TitleBar";
import { GrimodexLogo } from "@/components/GrimodexLogo";

export function LauncherScreen() {
  const { t } = useTranslation();
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const openRecentWorkspace = useWorkspaceStore((s) => s.openRecentWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const [opening, setOpening] = useState<string | null>(null);

  const recentWorkspaces = globalSettings?.recentWorkspaces ?? [];

  async function handleOpenRecent(path: string) {
    clearError();
    setOpening(path);
    await openRecentWorkspace(path);
    setOpening(null);
  }

  async function handleBrowse() {
    clearError();
    const path = await openFolderDialog();
    if (path) {
      setOpening(path);
      await openWorkspace(path);
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
            className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t("launcher.openFolder")}
          </button>
          <button
            type="button"
            onClick={handleBrowse}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("launcher.newWorkspace")}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceItem({
  workspace,
  isOpening,
  onOpen,
}: {
  workspace: RecentWorkspace;
  isOpening: boolean;
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
        isOpening && "opacity-50",
      )}
      onClick={isOpening ? undefined : onOpen}
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
