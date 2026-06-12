import { Check } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/lib/dialog";
import { useWorkspaceStore } from "./store";

export function WorkspaceMenu() {
  const { t } = useTranslation();
  const activeWorkspaceName = useWorkspaceStore((s) => s.activeWorkspaceName);
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);
  const requestOpenWorkspace = useWorkspaceStore((s) => s.requestOpenWorkspace);
  const openRecentWorkspace = useWorkspaceStore((s) => s.openRecentWorkspace);
  const showLauncher = useWorkspaceStore((s) => s.showLauncher);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);

  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const recentWorkspaces = (globalSettings?.recentWorkspaces ?? [])
    .filter((ws) => ws.path !== activeWorkspacePath)
    .slice(0, 4);

  async function handleOpenOther() {
    setIsOpen(false);
    const path = await openFolderDialog();
    if (path) {
      await requestOpenWorkspace(path);
    }
  }

  function handleShowLauncher() {
    setIsOpen(false);
    showLauncher();
  }

  function folderName(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
      >
        <span className="max-w-40 truncate">
          {activeWorkspaceName ?? t("workspaceMenu.fallback")}
        </span>
        <span className="text-xs">▾</span>
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-popover py-1 shadow-lg">
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground">
            <Check
              className="h-3.5 w-3.5 shrink-0"
              strokeWidth={3}
              aria-hidden
            />
            <span className="truncate font-medium text-foreground">
              {activeWorkspaceName}
            </span>
          </div>

          {recentWorkspaces.map((ws) => (
            <button
              key={ws.path}
              type="button"
              onClick={() => {
                setIsOpen(false);
                openRecentWorkspace(ws.path);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span className="w-4" />
              <span className="truncate">{folderName(ws.path)}</span>
            </button>
          ))}

          <div className="my-1 border-t border-border" />

          <button
            type="button"
            onClick={handleOpenOther}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <span className="w-4" />
            {t("workspaceMenu.openOther")}
          </button>
          <button
            type="button"
            onClick={handleOpenOther}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <span className="w-4" />
            {t("workspaceMenu.newWorkspace")}
          </button>

          <div className="my-1 border-t border-border" />

          <button
            type="button"
            onClick={handleShowLauncher}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <span className="w-4" />
            {t("workspaceMenu.startScreen")}
          </button>
        </div>
      )}
    </div>
  );
}
