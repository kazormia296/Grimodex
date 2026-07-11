import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { invoke } from "@/lib/tauri";
import { useWorkspaceStore } from "@/features/workspace/store";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { buildMcpConfigJson, type McpConfigInfo } from "../mcpConfig";

/**
 * Settings affordance that copies a ready-to-paste `.mcp.json` snippet for
 * pointing an external MCP client at this Grimodex install. The shell resolves
 * both the OS-specific command and its argument prefix: Tauri uses
 * `Grimodex mcp …`, while Electron uses the standalone `grimodex-mcp …`
 * sidecar.
 *
 * Each button *is* a concrete copy action (changes only the copied text), so
 * none implies a persistent app-mode change. Two axes:
 * - scope (row): "this project" (pinned, `--project`) vs "all projects"
 *   (`--all-projects`, whole-DB scope, local/trusted only).
 * - write permission (button): "read-only" (`--readonly`, cloud-safe) vs
 *   "per policy" (no `--readonly`; writes governed by the project's AI policy
 *   `knowledgeWrite`/`bodyWrite`, same as the in-app AI).
 */
export function McpIntegrationSection() {
  const { t } = useTranslation();
  const workspaceReady = useWorkspaceStore(
    (s) =>
      s.activeWorkspacePath != null &&
      s.workspaceHydrated &&
      !s.workspaceSwitchInProgress,
  );

  async function handleCopy(allProjects: boolean, readonly: boolean) {
    try {
      const before = useWorkspaceStore.getState();
      const workspacePath = before.activeWorkspacePath;
      const workspaceRevision = before.workspaceOpenRevision;
      const projectId = getCurrentProjectId();
      if (
        workspacePath == null ||
        !before.workspaceHydrated ||
        before.workspaceSwitchInProgress
      ) {
        throw new Error("Workspace is not ready for MCP config export");
      }

      const info = await invoke<McpConfigInfo>("get_mcp_config");
      const after = useWorkspaceStore.getState();
      if (
        !after.workspaceHydrated ||
        after.workspaceSwitchInProgress ||
        after.activeWorkspacePath !== workspacePath ||
        after.workspaceOpenRevision !== workspaceRevision ||
        getCurrentProjectId() !== projectId ||
        info.workspace !== workspacePath
      ) {
        throw new Error("Workspace changed while building MCP config");
      }

      const json = buildMcpConfigJson({
        command: info.command,
        workspace: info.workspace,
        argsPrefix: info.argsPrefix,
        projectId,
        readonly,
        allProjects,
      });
      await navigator.clipboard.writeText(json);
      toast.success(t("settings.ai.mcp.copySuccess"));
    } catch {
      toast.error(t("settings.ai.mcp.copyFail"));
    }
  }

  const buttonClass =
    "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

  const copyButtons = (allProjects: boolean) => (
    <div className="flex flex-shrink-0 gap-2">
      <button
        type="button"
        disabled={!workspaceReady}
        className={buttonClass}
        onClick={() => handleCopy(allProjects, true)}
      >
        <Copy className="h-3.5 w-3.5" />
        {t("settings.ai.mcp.copyReadonly")}
      </button>
      <button
        type="button"
        disabled={!workspaceReady}
        className={buttonClass}
        onClick={() => handleCopy(allProjects, false)}
      >
        <Copy className="h-3.5 w-3.5" />
        {t("settings.ai.mcp.copyPolicy")}
      </button>
    </div>
  );

  return (
    <SettingSection title={t("settings.ai.mcp.title")}>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("settings.ai.mcp.description")}
      </p>
      <SettingRow
        label={t("settings.ai.mcp.scopeProject")}
        description={t("settings.ai.mcp.scopeProjectDesc")}
        disabled={!workspaceReady}
      >
        {copyButtons(false)}
      </SettingRow>
      <SettingRow
        label={t("settings.ai.mcp.scopeAll")}
        description={t("settings.ai.mcp.scopeAllDesc")}
        disabled={!workspaceReady}
      >
        {copyButtons(true)}
      </SettingRow>
    </SettingSection>
  );
}
