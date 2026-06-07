/**
 * Build the `.mcp.json` snippet an external MCP client (Claude Code / Claude
 * Desktop / Hermes Agent) needs to use this Grimodex install as its MCP
 * server. Since the MCP server is unified into the app binary, `command` is
 * the installed app executable and the `mcp` subcommand leads the args.
 *
 * Pure / side-effect-free so the arg ordering is unit-testable.
 */
export interface McpConfigParams {
  /** Absolute path to the app binary (from the `get_mcp_config` command). */
  command: string;
  /** Open workspace directory (the `--workspace` value). */
  workspace: string;
  /**
   * Current project id. Pinning `--project` avoids the server falling back to
   * the first project in a multi-project workspace. Omitted when falsy.
   */
  projectId?: string | null;
  /** Add `--readonly` (cloud-safe default: disables the write tools). */
  readonly?: boolean;
}

export function buildMcpConfigJson({
  command,
  workspace,
  projectId,
  readonly = true,
}: McpConfigParams): string {
  const args = ["mcp", "--workspace", workspace];
  if (projectId) {
    args.push("--project", projectId);
  }
  if (readonly) {
    args.push("--readonly");
  }
  const config = {
    mcpServers: {
      grimodex: {
        command,
        args,
        env: {},
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
