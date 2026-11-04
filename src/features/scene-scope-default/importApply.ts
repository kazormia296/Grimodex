/**
 * The import screen's "apply the default to the imported scenes" (SDEF/1 R14,
 * DR-SDEF-31). Only when the author turned it on, after the import has
 * finished, the existing A1 writer is looped over the imported Scenes that are
 * still `unknown`. Native never lets an import inherit the default (R10).
 */
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  applyScopeDefaultToScenes,
  type ScopeApplyResult,
} from "./applyScopeDefault";
// Registers this feature's lazy strings (DR-SDEF-52).
import "./sceneScopeDefaultTranslations";

/**
 * The import screen's choice: off, or on with the version of the default the
 * screen showed ("当てる値"). A default changed since then is not applied.
 */
export type ScopeDefaultImportChoice =
  | false
  | undefined
  | { expectedVersion: number };

export async function applyScopeDefaultAfterImport(
  choice: ScopeDefaultImportChoice,
  sceneIds: readonly string[],
): Promise<ScopeApplyResult | null> {
  if (!choice || sceneIds.length === 0) return null;
  const workspacePath = useWorkspaceStore.getState().activeWorkspacePath;
  if (!workspacePath) return null;
  try {
    const result = await applyScopeDefaultToScenes({
      workspacePath,
      projectId: getCurrentProjectId(),
      sceneIds,
      target: "unknown",
      expectedVersion: choice.expectedVersion,
    });
    if (result.status === "default-changed") {
      toast.error(i18next.t("import.sceneScopeApplyChanged"));
    } else if (result.status !== "done") {
      toast.error(i18next.t("settings.project.sceneScopeApplyNoDefault"));
    } else {
      (result.failed > 0 ? toast.warning : toast.success)(
        i18next.t("settings.project.sceneScopeApplyResult", {
          applied: result.applied,
          failed: result.failed,
        }),
      );
    }
    return result;
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause));
    return null;
  }
}
