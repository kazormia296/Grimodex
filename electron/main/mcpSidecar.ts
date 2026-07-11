/**
 * Resolve the standalone `grimodex-mcp` executable used by the Electron shell.
 * Resolution only inspects executable regular files; process spawning belongs
 * to the external MCP client described by the generated `.mcp.json`.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import { IPC_BACKEND_UNAVAILABLE_MARKER } from "../shared/ipcContract.js";
import type {
  NapiBackendLike,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";

interface SidecarCandidateMetadata {
  mtimeMs: number;
}

type SidecarCandidateProbe = (
  candidate: string,
  platform: NodeJS.Platform,
) => Promise<SidecarCandidateMetadata | null>;

export interface McpSidecarResolution {
  /** Explicit operator/test override. Invalid overrides fail without fallback. */
  overridePath?: string;
  isPackaged: boolean;
  resourcesPath: string;
  /** Directory containing the bundled Electron main entry (`dist-electron`). */
  mainDir: string;
  platform: NodeJS.Platform;
  probeCandidate?: SidecarCandidateProbe;
}

async function defaultProbeCandidate(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<SidecarCandidateMetadata | null> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return null;
    if (platform !== "win32") {
      await access(candidate, constants.X_OK);
    }
    return { mtimeMs: metadata.mtimeMs };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EACCES" ||
      code === "EPERM"
    ) {
      return null;
    }
    throw error;
  }
}

function defaultResolution(): McpSidecarResolution {
  return {
    overridePath: process.env.GRIMODEX_MCP_PATH,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
    platform: process.platform,
    probeCandidate: defaultProbeCandidate,
  };
}

/**
 * Resolve an absolute executable regular-file sidecar path. POSIX candidates
 * must pass `X_OK`; Windows relies on the `.exe` suffix and regular-file check.
 *
 * Order:
 * 1. `GRIMODEX_MCP_PATH` (strict override; never silently ignored)
 * 2. packaged `<resources>/bin/grimodex-mcp[.exe]`
 * 3. dev `<repo>/src-tauri/target/{debug,release}/grimodex-mcp[.exe]`
 */
export async function resolveMcpSidecarPath(
  resolution: McpSidecarResolution = defaultResolution(),
): Promise<string> {
  const {
    overridePath,
    isPackaged,
    resourcesPath,
    mainDir,
    platform,
    probeCandidate = defaultProbeCandidate,
  } = resolution;
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (overridePath !== undefined) {
    if (!pathApi.isAbsolute(overridePath)) {
      throw new Error("GRIMODEX_MCP_PATH must be an absolute path");
    }
    if (!(await probeCandidate(overridePath, platform))) {
      throw new Error(
        `GRIMODEX_MCP_PATH must point to an existing executable regular file: ${overridePath}`,
      );
    }
    return overridePath;
  }

  const executableName =
    platform === "win32" ? "grimodex-mcp.exe" : "grimodex-mcp";
  const candidates = isPackaged
    ? [pathApi.join(resourcesPath, "bin", executableName)]
    : [
        pathApi.join(
          mainDir,
          "..",
          "src-tauri",
          "target",
          "debug",
          executableName,
        ),
        pathApi.join(
          mainDir,
          "..",
          "src-tauri",
          "target",
          "release",
          executableName,
        ),
      ];

  let selected: { path: string; mtimeMs: number } | null = null;
  for (const candidate of candidates) {
    if (!pathApi.isAbsolute(candidate)) {
      throw new Error(`MCP sidecar candidate must be absolute: ${candidate}`);
    }
    const metadata = await probeCandidate(candidate, platform);
    if (
      metadata !== null &&
      (selected === null || metadata.mtimeMs > selected.mtimeMs)
    ) {
      selected = { path: candidate, mtimeMs: metadata.mtimeMs };
    }
  }

  if (selected !== null) return selected.path;

  throw new Error(`MCP sidecar not found; checked: ${candidates.join(", ")}`);
}

export interface McpConfigInfo {
  command: string;
  workspace: string;
  argsPrefix: readonly string[];
}

type McpSidecarPathResolver = () => Promise<string>;

/**
 * Main-process implementation of `get_mcp_config`. Workspace identity remains
 * native-owned; only the executable-path decision belongs to Electron main.
 */
export function buildMcpConfigShellHandlers(
  backend: NapiBackendLike | null,
  licenseFilePath: string,
  resolveSidecar: McpSidecarPathResolver = () => resolveMcpSidecarPath(),
): ShellCommandHandlers {
  return {
    get_mcp_config: async () => {
      if (!backend) {
        throw new Error(`${IPC_BACKEND_UNAVAILABLE_MARKER} get_mcp_config`);
      }
      const getWorkspace = backend.getActiveWorkspacePath;
      if (typeof getWorkspace !== "function") {
        throw new Error(
          `${IPC_BACKEND_UNAVAILABLE_MARKER} native method getActiveWorkspacePath`,
        );
      }
      if (!path.isAbsolute(licenseFilePath)) {
        throw new Error(
          `MCP license file path must be absolute: ${licenseFilePath}`,
        );
      }

      // Resolve the potentially slow filesystem candidate first, then capture
      // native workspace identity as the final await. This gives the command a
      // clear linearization point and avoids returning an old workspace after
      // a switch that completed while probing a network-mounted override.
      const command = await resolveSidecar();
      const workspace = await getWorkspace.call(backend);
      if (!path.isAbsolute(workspace)) {
        throw new Error(`Active workspace path must be absolute: ${workspace}`);
      }
      return {
        command,
        workspace,
        // This prefix is owned by Electron main, not renderer input. The
        // sidecar therefore evaluates the exact license file used by the
        // active Electron userData directory even when it differs from the
        // historical Tauri app-data location.
        argsPrefix: ["--license-file", licenseFilePath],
      } satisfies McpConfigInfo;
    },
  };
}
