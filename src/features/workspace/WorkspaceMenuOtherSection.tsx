import { Folder } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/lib/dialog";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { useWorkspaceStore } from "./store";

const ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground";

/** 最近のワークスペースは、現在を除く先頭からこの件数まで。 */
const RECENT_LIMIT = 4;

function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

interface WorkspaceMenuOtherSectionProps {
  busy: boolean;
  onClose: () => void;
}

/**
 * 統合メニューの「別のワークスペース」の区画。最近のワークスペース、
 * 「フォルダを開く…」（作成もここ）、「スタート画面」を出す。
 */
export function WorkspaceMenuOtherSection({
  busy,
  onClose,
}: WorkspaceMenuOtherSectionProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const hintId = useId();
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const requestOpenWorkspace = useWorkspaceStore((s) => s.requestOpenWorkspace);
  const openRecentWorkspace = useWorkspaceStore((s) => s.openRecentWorkspace);
  const showLauncher = useWorkspaceStore((s) => s.showLauncher);

  const recentWorkspaces = (globalSettings?.recentWorkspaces ?? [])
    .filter((ws) => ws.path !== activeWorkspacePath)
    .slice(0, RECENT_LIMIT);

  async function handleOpenFolder() {
    if (busy) return;
    onClose();
    try {
      const path = await openFolderDialog();
      if (path) await requestOpenWorkspace(path, "folder-picker");
    } catch (error) {
      debugLog.error(
        "workspaceMenu",
        "workspace picker request failed",
        errorDetail(error),
      );
    }
  }

  function handleShowLauncher() {
    if (busy) return;
    onClose();
    showLauncher();
  }

  return (
    <div role="group" aria-labelledby={headingId}>
      <div
        id={headingId}
        className="px-3 pb-0.5 pt-1 text-xs text-muted-foreground"
      >
        {t("workspaceMenu.otherSection")}
      </div>

      {recentWorkspaces.map((ws) => (
        // accessible name はフォルダ名だけ（journey が name で探す）。path は title に。
        <button
          key={ws.path}
          type="button"
          title={ws.path}
          disabled={busy}
          onClick={() => {
            onClose();
            void openRecentWorkspace(ws.path, "workspace-menu-recent");
          }}
          className={ITEM_CLASS}
        >
          <span className="inline-flex w-4 shrink-0 justify-center" aria-hidden>
            <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <span className="truncate">{folderName(ws.path)}</span>
        </button>
      ))}

      <button
        type="button"
        onClick={() => void handleOpenFolder()}
        disabled={busy}
        aria-describedby={hintId}
        className={ITEM_CLASS}
      >
        <span className="w-4 shrink-0" />
        {t("workspaceMenu.openOther")}
      </button>
      <p id={hintId} className="pb-1 pl-9 pr-3 text-xs text-muted-foreground">
        {t("workspaceMenu.openFolderHint")}
      </p>

      <button
        type="button"
        onClick={handleShowLauncher}
        disabled={busy}
        className={ITEM_CLASS}
      >
        <span className="w-4 shrink-0" />
        {t("workspaceMenu.startScreen")}
      </button>
    </div>
  );
}
