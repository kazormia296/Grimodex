/**
 * Build the `.mcp.json` snippet an external MCP client (Claude Code / Claude
 * Desktop / Hermes Agent) needs to use this Grimodex install as its MCP
 * server. Tauri uses the installed app executable plus its `mcp` subcommand;
 * Electron uses a standalone `grimodex-mcp` sidecar and a main-owned
 * `--license-file` prefix pointing at the active Electron userData directory.
 *
 * Pure / side-effect-free so the arg ordering is unit-testable.
 */
export interface McpConfigInfo {
  /** Absolute app-binary or standalone-sidecar path from `get_mcp_config`. */
  command: string;
  /** Open workspace directory (the `--workspace` value). */
  workspace: string;
  /**
   * Arguments that must precede the common MCP flags. Tauri omits this field
   * for backward compatibility and therefore defaults to `["mcp"]`. Electron
   * returns `["--license-file", absolutePath]`; the renderer only appends the
   * common workspace/scope flags and cannot choose the license authority.
   */
  argsPrefix?: readonly string[];
}

export interface McpConfigParams extends McpConfigInfo {
  /**
   * Current project id. Pinning `--project` avoids the server falling back to
   * the first project in a multi-project workspace. Omitted when falsy or when
   * `allProjects` is set.
   */
  projectId?: string | null;
  /** Add `--readonly` (cloud-safe default: disables the write tools). */
  readonly?: boolean;
  /**
   * Emit `--all-projects` instead of pinning `--project`: one entry that can
   * switch between every project via `select_project`. Widens scope to the
   * whole DB — local/trusted clients only. Takes precedence over `projectId`.
   */
  allProjects?: boolean;
}

export function buildMcpConfigJson({
  command,
  workspace,
  argsPrefix,
  projectId,
  readonly = true,
  allProjects = false,
}: McpConfigParams): string {
  const args = [...(argsPrefix ?? ["mcp"]), "--workspace", workspace];
  if (allProjects) {
    args.push("--all-projects");
  } else if (projectId) {
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
