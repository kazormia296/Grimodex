import { Check } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  useProjectStore,
  useCurrentProjectId,
  useCurrentProject,
} from "./projectStore";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { isLicenseRestrictedError } from "@/features/license/gate";
import { ResponsiveAlertDialog } from "@/components/ui/responsive-alert-dialog";
import { DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";

export function ProjectMenu({
  onOpenImport,
  onOpenExport,
  onOpenSnapshot,
  onOpenWebEditorHandoff,
}: {
  onOpenImport?: () => void;
  onOpenExport?: () => void;
  onOpenSnapshot?: () => void;
  onOpenWebEditorHandoff?: () => void;
}) {
  const { t } = useTranslation();
  const currentProjectId = useCurrentProjectId();
  const currentProject = useCurrentProject();
  const projects = useProjectStore((s) => s.projects);
  const loadProject = useProjectStore((s) => s.loadProject);
  const createNewProject = useProjectStore((s) => s.createNewProject);
  const deleteProjectById = useProjectStore((s) => s.deleteProjectById);
  const refreshProjects = useProjectStore((s) => s.refreshProjects);
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";

  const [isOpen, setIsOpen] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

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

  async function handleSwitch(projectId: string) {
    if (projectId === currentProjectId) {
      setIsOpen(false);
      return;
    }
    setIsOpen(false);
    try {
      await loadProject(projectId);
    } catch {
      toast.error(t("project.switchFailed"));
    }
  }

  async function handleCreate(data: {
    title: string;
    genre: string;
    language: string;
    timelapseEnabled: boolean;
    seedFromProjectId?: string;
    seedTypeSlugs: string[];
  }) {
    try {
      await createNewProject({
        title: data.title,
        genre: data.genre || undefined,
        language: data.language || undefined,
        timelapseEnabled: data.timelapseEnabled,
        seedFromProjectId: data.seedFromProjectId,
        seedTypeSlugs: data.seedTypeSlugs,
      });
      toast.success(t("project.create.success"));
    } catch (e) {
      // ライセンス制限の拒否は gate 側が理由 toast を表示済み。
      // 「失敗しました」を重ねると編集ロックを障害と誤認させるため出さない。
      if (!isLicenseRestrictedError(e)) {
        toast.error(t("project.create.failed"));
      }
      throw new Error("create failed", { cause: e });
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await deleteProjectById(id);
      toast.success(t("project.delete.success"));
    } catch (e) {
      const message =
        e instanceof Error && /last project/i.test(e.message)
          ? t("project.delete.lastProject")
          : t("project.delete.failed");
      toast.error(message);
    }
  }

  const displayTitle = currentProject?.title ?? t("project.menu.fallback");

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          data-testid="project-menu-trigger"
          onClick={() => setIsOpen(!isOpen)}
          className="flex w-44 items-center justify-between gap-1 rounded px-2 py-1 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          <span className="min-w-0 truncate">{displayTitle}</span>
          <span className="shrink-0 text-xs">▾</span>
        </button>

        {isOpen && (
          <div
            data-testid="project-menu-dropdown"
            className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            {projects.map((project) => (
              <div
                key={project.id}
                className="group flex items-center hover:bg-accent"
              >
                <button
                  type="button"
                  data-testid={`project-switch-${project.id}`}
                  onClick={() => void handleSwitch(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-sm hover:text-accent-foreground"
                >
                  <span className="inline-flex w-4 shrink-0 items-center">
                    {project.id === currentProjectId && (
                      <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                    )}
                  </span>
                  <span className="truncate">{project.title}</span>
                </button>
                {projects.length > 1 && (
                  <button
                    type="button"
                    data-testid={`project-delete-${project.id}`}
                    title={t("project.delete.action")}
                    onClick={() => {
                      setIsOpen(false);
                      setPendingDeleteId(project.id);
                    }}
                    className="mr-2 hidden rounded px-1.5 py-0.5 text-xs text-muted-foreground group-hover:inline hover:bg-destructive/10 hover:text-destructive"
                  >
                    {t("common.delete")}
                  </button>
                )}
              </div>
            ))}

            <div className="my-1 border-t border-border" />

            <button
              type="button"
              data-testid="project-create-open"
              onClick={() => {
                setIsOpen(false);
                setShowCreateDialog(true);
              }}
              className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span className="w-4" />
              {t("project.create.action")}
            </button>
            {onOpenImport && (
              <button
                type="button"
                data-testid="project-import-open"
                onClick={() => {
                  setIsOpen(false);
                  onOpenImport();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="w-4" />
                {t("project.import.action")}
              </button>
            )}
            {onOpenExport && (
              <button
                type="button"
                data-testid="project-export-open"
                onClick={() => {
                  setIsOpen(false);
                  onOpenExport();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="w-4" />
                {t("project.export.action")}
              </button>
            )}
            {onOpenSnapshot && (
              <button
                type="button"
                data-testid="project-snapshot-open"
                onClick={() => {
                  setIsOpen(false);
                  onOpenSnapshot();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="w-4" />
                {t("project.snapshot.action")}
              </button>
            )}
            {onOpenWebEditorHandoff && (
              <button
                type="button"
                data-testid="web-editor-handoff-open"
                onClick={() => {
                  setIsOpen(false);
                  onOpenWebEditorHandoff();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="w-4" />
                {t("hostedEditor.desktopImport.action")}
              </button>
            )}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        projects={projects}
        defaultSourceProjectId={currentProjectId}
        onCreate={handleCreate}
      />

      <ResponsiveAlertDialog
        open={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        title={t("project.delete.confirmTitle")}
        description={t("project.delete.confirmBody", {
          title:
            projects.find((project) => project.id === pendingDeleteId)?.title ??
            "",
        })}
        className="max-w-sm"
        testId="project-delete-confirm"
        restoreFocusRef={triggerRef}
      >
        <DialogFooter className={cn(phoneWorkspace && "grid grid-cols-1")}>
          <button
            type="button"
            onClick={() => setPendingDeleteId(null)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent",
              phoneWorkspace && "min-h-11 w-full",
            )}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="project-delete-confirm-btn"
            onClick={() => void handleConfirmDelete()}
            className={cn(
              "rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground",
              phoneWorkspace && "min-h-11 w-full",
            )}
          >
            {t("common.deleteConfirm")}
          </button>
        </DialogFooter>
      </ResponsiveAlertDialog>
    </>
  );
}
