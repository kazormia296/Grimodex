import { Check } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore, useCurrentProjectId } from "./projectStore";
import { runProjectLoadWithFailureToast } from "./projectLoadFailure";

/**
 * ヘッダーの統合メニュー（`WorkspaceMenu`）が使う、プロジェクト側の状態。
 * 作成ダイアログと削除の確認ダイアログの開閉を持ち、mount 時に一覧を読む。
 * メニューを閉じている間も一覧を最新にしておくため、メニューの root で呼ぶ。
 */
export interface ProjectMenuState {
  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;
  pendingDeleteId: string | null;
  requestDelete: (projectId: string) => void;
  cancelDelete: () => void;
}

export function useProjectMenu(): ProjectMenuState {
  const refreshProjects = useProjectStore((s) => s.refreshProjects);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  return {
    createOpen,
    openCreate: useCallback(() => setCreateOpen(true), []),
    closeCreate: useCallback(() => setCreateOpen(false), []),
    pendingDeleteId,
    requestDelete: useCallback((id: string) => setPendingDeleteId(id), []),
    cancelDelete: useCallback(() => setPendingDeleteId(null), []),
  };
}

interface ProjectMenuSectionProps {
  /** 項目を選んだときにメニューを閉じる。 */
  onClose: () => void;
  onRequestCreate: () => void;
  onRequestDelete: (projectId: string) => void;
}

/**
 * 統合メニューの「このワークスペース」の区画の中身。読み込みの警告、
 * プロジェクトの一覧（切り替えと削除）、「新規プロジェクト…」を描く。
 * トリガーとドロップダウンの枠は `WorkspaceMenu` が持つ。
 */
export function ProjectMenuSection({
  onClose,
  onRequestCreate,
  onRequestDelete,
}: ProjectMenuSectionProps) {
  const { t } = useTranslation();
  const currentProjectId = useCurrentProjectId();
  const projects = useProjectStore((s) => s.projects);
  const projectLoadStatus = useProjectStore((s) => s.projectLoadStatus);
  const degradedParticipants = useProjectStore((s) => s.degradedParticipants);
  const loadProject = useProjectStore((s) => s.loadProject);

  async function handleSwitch(projectId: string) {
    onClose();
    if (projectId === currentProjectId) return;
    await runProjectLoadWithFailureToast(() => loadProject(projectId));
  }

  return (
    <>
      {projectLoadStatus === "degraded" && (
        <div
          role="status"
          data-testid="project-load-degraded"
          className="mx-2 mb-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-2 text-xs"
        >
          <p>{t("project.loadDegraded")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {t("project.loadDegradedCount", {
              count: degradedParticipants.length,
            })}
          </p>
          <button
            type="button"
            className="mt-1 font-medium text-foreground underline underline-offset-2"
            onClick={() => {
              onClose();
              void runProjectLoadWithFailureToast(() =>
                loadProject(currentProjectId),
              );
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
      {projectLoadStatus === "recovering" && (
        <div
          role="alert"
          className="mx-2 mb-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-2 text-xs"
        >
          {t("project.recovering")}
        </div>
      )}
      {/* 6 行（1 行 32px）を超えたら、一覧の中だけをスクロールさせる。 */}
      <div data-project-menu-list className="max-h-48 overflow-y-auto">
        {projects.map((project) => {
          const current = project.id === currentProjectId;
          return (
            <div
              key={project.id}
              className="group flex items-center hover:bg-accent"
            >
              <button
                type="button"
                data-testid={`project-switch-${project.id}`}
                aria-current={current ? "true" : undefined}
                title={project.title}
                onClick={() => void handleSwitch(project.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm hover:text-accent-foreground"
              >
                <span className="inline-flex w-4 shrink-0 items-center">
                  {current && (
                    <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                  )}
                </span>
                <span className="truncate">{project.title}</span>
              </button>
              {projects.length > 1 && (
                // 行のボタンとは兄弟のまま。キーボードで行に来たときにも出し、
                // Tab で届く（上下キーの移動先には入れない：data-menu-secondary）。
                <button
                  type="button"
                  data-testid={`project-delete-${project.id}`}
                  data-menu-secondary
                  title={t("project.delete.action")}
                  onClick={() => {
                    onClose();
                    onRequestDelete(project.id);
                  }}
                  className="mr-2 hidden shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground group-focus-within:inline group-hover:inline hover:bg-destructive/10 hover:text-destructive"
                >
                  {t("common.delete")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        data-testid="project-create-open"
        onClick={() => {
          onClose();
          onRequestCreate();
        }}
        className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
      >
        <span className="w-4 shrink-0" />
        {t("project.create.action")}
      </button>
    </>
  );
}
