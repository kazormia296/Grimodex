import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { invoke } from "@/lib/tauri";
import { useWorkspaceStore } from "@/features/workspace/store";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { buildMcpConfigJson } from "../mcpConfig";

interface McpConfigInfo {
  command: string;
  workspace: string;
}

/**
 * Settings affordance that copies a ready-to-paste `.mcp.json` snippet for
 * pointing an external MCP client at this Grimodex install. The app binary
 * doubles as the MCP server (`Grimodex mcp …`), so the snippet's `command`
 * is the OS-specific absolute path resolved by the `get_mcp_config` command.
 *
 * Two buttons rather than a toggle: each button *is* a concrete copy action
 * (it changes only the copied text), so neither implies a persistent app-mode
 * change. "This project" is the safe pinned default; "All projects" emits
 * `--all-projects` for local/trusted clients (whole-DB scope).
 */
export function McpIntegrationSection() {
  const { t } = useTranslation();
  const workspaceOpen = useWorkspaceStore((s) => s.activeWorkspacePath != null);

  async function handleCopy(allProjects: boolean) {
    try {
      const info = await invoke<McpConfigInfo>("get_mcp_config");
      const json = buildMcpConfigJson({
        command: info.command,
        workspace: info.workspace,
        projectId: getCurrentProjectId(),
        readonly: true,
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

  return (
    <SettingSection title={t("settings.ai.mcp.title")}>
      <SettingRow
        label={t("settings.ai.mcp.label")}
        description={t("settings.ai.mcp.description")}
        disabled={!workspaceOpen}
      >
        <div className="flex flex-shrink-0 gap-2">
          <button
            type="button"
            disabled={!workspaceOpen}
            className={buttonClass}
            onClick={() => handleCopy(false)}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("settings.ai.mcp.copyProject")}
          </button>
          <button
            type="button"
            disabled={!workspaceOpen}
            className={buttonClass}
            onClick={() => handleCopy(true)}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("settings.ai.mcp.copyAllProjects")}
          </button>
        </div>
      </SettingRow>
    </SettingSection>
  );
}
