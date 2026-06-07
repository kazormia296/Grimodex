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
 */
export function McpIntegrationSection() {
  const { t } = useTranslation();
  const workspaceOpen = useWorkspaceStore((s) => s.activeWorkspacePath != null);

  async function handleCopy() {
    try {
      const info = await invoke<McpConfigInfo>("get_mcp_config");
      const json = buildMcpConfigJson({
        command: info.command,
        workspace: info.workspace,
        projectId: getCurrentProjectId(),
        readonly: true,
      });
      await navigator.clipboard.writeText(json);
      toast.success(t("settings.data.mcp.copySuccess"));
    } catch {
      toast.error(t("settings.data.mcp.copyFail"));
    }
  }

  return (
    <SettingSection title={t("settings.data.mcp.title")}>
      <SettingRow
        label={t("settings.data.mcp.label")}
        description={t("settings.data.mcp.description")}
        disabled={!workspaceOpen}
      >
        <button
          type="button"
          disabled={!workspaceOpen}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleCopy}
        >
          <Copy className="h-3.5 w-3.5" />
          {t("settings.data.mcp.copy")}
        </button>
      </SettingRow>
    </SettingSection>
  );
}
