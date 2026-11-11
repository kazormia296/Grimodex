import { Folder } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "./store";
import { WorkspaceMenuTrigger } from "./WorkspaceMenuTrigger";
import { WorkspaceMenuOtherSection } from "./WorkspaceMenuOtherSection";
import { useWorkspaceMenuKeyboard } from "./useWorkspaceMenuKeyboard";
import {
  useCurrentProject,
  useProjectStore,
} from "@/features/project/projectStore";
import {
  ProjectMenuSection,
  useProjectMenu,
} from "@/features/project/ProjectMenu";
import { ProjectMenuDialogs } from "@/features/project/ProjectMenuDialogs";
import {
  ProjectMenuCommands,
  hasProjectMenuCommands,
} from "@/features/project/ProjectMenuCommands";

export interface WorkspaceMenuProps {
  onOpenImport?: () => void;
  onOpenExport?: () => void;
  onOpenSnapshot?: () => void;
}

/**
 * ヘッダー左の統合メニュー。ワークスペース（フォルダ）とプロジェクトを
 * 1 本のトリガー「フォルダ名 / 題名」と 1 枚のパネルで扱う。
 * パネルは上から「このワークスペース」（プロジェクト）、プロジェクトの操作、
 * 「別のワークスペース」の順。
 */
export function WorkspaceMenu({
  onOpenImport,
  onOpenExport,
  onOpenSnapshot,
}: WorkspaceMenuProps) {
  const { t } = useTranslation();
  const activeWorkspaceName = useWorkspaceStore((s) => s.activeWorkspaceName);
  const workspaceOpenRevision = useWorkspaceStore(
    (s) => s.workspaceOpenRevision,
  );
  const workspaceOpenRequestInProgress = useWorkspaceStore(
    (s) => s.workspaceOpenRequestInProgress,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (s) => s.workspaceSwitchInProgress,
  );
  const currentProject = useCurrentProject();
  const projectLoadStatus = useProjectStore((s) => s.projectLoadStatus);
  // 一覧の読み込みはメニューの mount 時。閉じている間も一覧を最新にする。
  const projectMenu = useProjectMenu();

  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const currentHeadingId = useId();
  const panelId = useId();

  const workspaceBusy =
    workspaceOpenRequestInProgress || workspaceSwitchInProgress;
  const workspaceLabel = activeWorkspaceName ?? t("workspaceMenu.fallback");
  const projectTitle = currentProject?.title ?? t("project.menu.fallback");
  const commands = { onOpenImport, onOpenExport, onOpenSnapshot };

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const keyboard = useWorkspaceMenuKeyboard({
    isOpen,
    setIsOpen,
    triggerRef,
    panelRef,
  });

  return (
    <>
      {/* ヘッダーの左のレールが足りないとき、ロゴや後ろのボタンではなく、
          このメニューが先に縮んで名前が省略される（shrink-[1000]）。最小幅は
          トリガーの左右の padding（16px）。それより狭くすると button が root から
          はみ出して隣の「元に戻す」に重なるので、その先は後ろのボタンが縮む。 */}
      <div
        ref={rootRef}
        data-tour-target="workspace-menu"
        className="relative min-w-4 max-w-80 shrink-[1000]"
        onKeyDown={keyboard.onRootKeyDown}
      >
        <WorkspaceMenuTrigger
          triggerRef={triggerRef}
          workspaceLabel={workspaceLabel}
          projectTitle={projectTitle}
          degradedLabel={
            projectLoadStatus === "degraded" ? t("project.loadDegraded") : null
          }
          isOpen={isOpen}
          panelId={panelId}
          busy={workspaceBusy}
          workspaceOpenRevision={workspaceOpenRevision}
          onToggle={() => setIsOpen((open) => !open)}
          onKeyDown={keyboard.onTriggerKeyDown}
        />

        {isOpen && (
          // Electron ではヘッダーがウィンドウのドラッグ領域。パネルの中の
          // 見出しや補足まで drag にならないよう、パネルごと除外する。
          <div
            ref={panelRef}
            id={panelId}
            data-testid="workspace-menu-dropdown"
            data-tauri-drag-region="false"
            className="absolute left-0 top-full z-50 mt-1 max-h-[calc(100vh-4rem)] w-80 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            <div role="group" aria-labelledby={currentHeadingId}>
              <div
                id={currentHeadingId}
                data-workspace-menu-heading
                className="flex items-center gap-2 px-3 py-1.5 text-sm"
              >
                <span
                  className="inline-flex w-4 shrink-0 justify-center"
                  aria-hidden
                >
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
                <span className="min-w-0 truncate font-medium">
                  {workspaceLabel}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {t("workspaceMenu.currentSection")}
                </span>
              </div>
              <ProjectMenuSection
                onClose={close}
                onRequestCreate={projectMenu.openCreate}
                onRequestDelete={projectMenu.requestDelete}
              />
            </div>

            {hasProjectMenuCommands(commands) && (
              <>
                <div className="my-1 border-t border-border" />
                <ProjectMenuCommands onClose={close} {...commands} />
              </>
            )}

            <div className="my-1 border-t border-border" />
            <WorkspaceMenuOtherSection busy={workspaceBusy} onClose={close} />
          </div>
        )}
      </div>

      <ProjectMenuDialogs state={projectMenu} restoreFocusRef={triggerRef} />
    </>
  );
}
