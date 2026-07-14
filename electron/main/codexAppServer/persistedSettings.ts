import type { NapiBackendLike } from "../../shared/ipcContract.js";

export interface PersistedCodexAppServerSettings {
  binaryPath: string | null;
  allowApprovals: boolean;
}

const DEFAULT_SETTINGS: PersistedCodexAppServerSettings = {
  binaryPath: null,
  allowApprovals: false,
};

/** Reads the authoritative native settings snapshot without renderer input. */
export async function readPersistedCodexAppServerSettings(
  backend: Pick<NapiBackendLike, "getAiSettings"> | null,
): Promise<PersistedCodexAppServerSettings> {
  if (!backend) return DEFAULT_SETTINGS;
  try {
    const raw = JSON.parse(await backend.getAiSettings()) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return DEFAULT_SETTINGS;
    }
    const settings = raw as Record<string, unknown>;
    const cli = settings.cli;
    if (
      settings.provider !== "cli" ||
      typeof cli !== "object" ||
      cli === null ||
      Array.isArray(cli)
    ) {
      return DEFAULT_SETTINGS;
    }
    const cliSettings = cli as Record<string, unknown>;
    if (cliSettings.kind !== "codex") return DEFAULT_SETTINGS;
    const binaryPath =
      typeof cliSettings.binaryPath === "string" &&
      cliSettings.binaryPath.trim() !== ""
        ? cliSettings.binaryPath.trim()
        : null;
    return {
      binaryPath,
      allowApprovals: cliSettings.codexAllowApprovals === true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
