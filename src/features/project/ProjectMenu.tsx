import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  useProjectStore,
  useCurrentProjectId,
  useCurrentProject,
} from "./projectStore";
import { CreateProjectDialog } from "./CreateProjectDialog";

export function ProjectMenu() {
  const { t } = useTranslation();
  const currentProjectId = useCurrentProjectId();
  const currentProject = useCurrentProject();
  const projects = useProjectStore((s) => s.projects);
  const loadProject = useProjectStore((s) => s.loadProject);
  const createNewProject = useProjectStore((s) => s.createNewProject);
  const deleteProjectById = useProjectStore((s) => s.deleteProjectById);
  const refreshProjects = useProjectStore((s) => s.refreshProjects);

  const [isOpen, setIsOpen] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
  }) {
    try {
      await createNewProject({
        title: data.title,
        genre: data.genre || undefined,
        language: data.language || undefined,
      });
      toast.success(t("project.create.success"));
    } catch {
      toast.error(t("project.create.failed"));
      throw new Error("create failed");
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
          type="button"
          data-testid="project-menu-trigger"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          <span className="max-w-40 truncate">{displayTitle}</span>
          <span className="text-xs">▾</span>
        </button>

        {isOpen && (
          <div
            data-testid="project-menu-dropdown"
            className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-popover py-1 shadow-lg"
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
                  <span className="w-4 shrink-0">
                    {project.id === currentProjectId ? "✓" : ""}
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
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span className="w-4" />
              {t("project.create.action")}
            </button>
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreate={handleCreate}
      />

      {pendingDeleteId && (
        <div
          data-testid="project-delete-confirm"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
        >
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg">
            <h3 className="mb-2 text-sm font-semibold">
              {t("project.delete.confirmTitle")}
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {t("project.delete.confirmBody", {
                title:
                  projects.find((p) => p.id === pendingDeleteId)?.title ?? "",
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteId(null)}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-testid="project-delete-confirm-btn"
                onClick={() => void handleConfirmDelete()}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground"
              >
                {t("common.deleteConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
