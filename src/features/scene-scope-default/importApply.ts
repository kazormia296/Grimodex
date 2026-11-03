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

export async function applyScopeDefaultAfterImport(
  enabled: boolean | undefined,
  sceneIds: readonly string[],
): Promise<ScopeApplyResult | null> {
  if (!enabled || sceneIds.length === 0) return null;
  const workspacePath = useWorkspaceStore.getState().activeWorkspacePath;
  if (!workspacePath) return null;
  try {
    const result = await applyScopeDefaultToScenes({
      workspacePath,
      projectId: getCurrentProjectId(),
      sceneIds,
      target: "unknown",
    });
    if (result.status !== "done") {
      // Without an expected version the default cannot have "changed"; both
      // non-done outcomes mean nothing was written.
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
