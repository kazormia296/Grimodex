import { useState } from "react";
import { openFolderDialog } from "@/lib/dialog";
import { useWorkspaceStore } from "./store";
import type { RecentWorkspace } from "./store";
import { cn } from "@/lib/utils";
import { TitleBar } from "@/components/TitleBar";

export function LauncherScreen() {
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const [opening, setOpening] = useState<string | null>(null);

  const recentWorkspaces = globalSettings?.recentWorkspaces ?? [];

  async function handleOpen(path: string) {
    clearError();
    setOpening(path);
    await openWorkspace(path);
    setOpening(null);
  }

  async function handleBrowse() {
    clearError();
    const path = await openFolderDialog();
    if (path) {
      await handleOpen(path);
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background text-foreground">
      <TitleBar />
      <div className="flex w-full max-w-lg flex-col gap-6 px-8">
        <h1 className="text-2xl font-bold">Grimodex</h1>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
            最近のワークスペース
          </h2>
          {recentWorkspaces.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              ワークスペースがありません
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {recentWorkspaces.map((ws) => (
                <WorkspaceItem
                  key={ws.path}
                  workspace={ws}
                  isOpening={opening === ws.path}
                  onOpen={() => handleOpen(ws.path)}
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
            フォルダを開く
          </button>
          <button
            type="button"
            onClick={handleBrowse}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            新規作成
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
