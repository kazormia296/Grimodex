import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProjectStore, useCurrentProjectId } from "./projectStore";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { isLicenseRestrictedError } from "@/features/license/gate";
import { ResponsiveAlertDialog } from "@/components/ui/responsive-alert-dialog";
import { DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";
import type { ProjectMenuState } from "./ProjectMenu";

interface ProjectMenuDialogsProps {
  state: ProjectMenuState;
  /** 削除の確認を閉じたときに focus を戻す先（統合メニューのトリガー）。 */
  restoreFocusRef: RefObject<HTMLElement | null>;
}

/** 統合メニューから開く、プロジェクトの作成ダイアログと削除の確認ダイアログ。 */
export function ProjectMenuDialogs({
  state,
  restoreFocusRef,
}: ProjectMenuDialogsProps) {
  const { t } = useTranslation();
  const currentProjectId = useCurrentProjectId();
  const projects = useProjectStore((s) => s.projects);
  const createNewProject = useProjectStore((s) => s.createNewProject);
  const deleteProjectById = useProjectStore((s) => s.deleteProjectById);
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
  const { createOpen, closeCreate, pendingDeleteId, cancelDelete } = state;
  // 作成ダイアログは初めて開くときに mount し、以後は閉じる動きのために残す。
  // ヘッダーの描画のたびに重いフォームを mount しない。
  const [createMounted, setCreateMounted] = useState(createOpen);
  if (createOpen && !createMounted) setCreateMounted(true);

  async function handleCreate(data: {
    title: string;
    genre: string;
    language: string;
    timelapseEnabled: boolean;
    seedFromProjectId?: string;
    seedTypeSlugs: string[];
    sceneScopeMainLine: boolean;
  }) {
    try {
      await createNewProject({
        title: data.title,
        genre: data.genre || undefined,
        language: data.language || undefined,
        timelapseEnabled: data.timelapseEnabled,
        seedFromProjectId: data.seedFromProjectId,
        seedTypeSlugs: data.seedTypeSlugs,
        sceneScopeMainLine: data.sceneScopeMainLine,
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
    cancelDelete();
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

  return (
    <>
      {createMounted && (
        <CreateProjectDialog
          open={createOpen}
          onClose={closeCreate}
          projects={projects}
          defaultSourceProjectId={currentProjectId}
          onCreate={handleCreate}
        />
      )}

      <ResponsiveAlertDialog
        open={pendingDeleteId !== null}
        onClose={cancelDelete}
        title={t("project.delete.confirmTitle")}
        description={t("project.delete.confirmBody", {
          title:
            projects.find((project) => project.id === pendingDeleteId)?.title ??
            "",
        })}
        className="max-w-sm"
        testId="project-delete-confirm"
        restoreFocusRef={restoreFocusRef}
      >
        <DialogFooter className={cn(phoneWorkspace && "grid grid-cols-1")}>
          <button
            type="button"
            onClick={cancelDelete}
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
