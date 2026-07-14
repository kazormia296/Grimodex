import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_AUTH_JSON_BYTES = 4 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const GRIMODEX_CODEX_CONFIG = `approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
apps = false
hooks = false
multi_agent = false
plugins = false
remote_plugin = false
shell_tool = false
skill_mcp_dependency_install = false
unified_exec = false
`;

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

async function assertRegularOrMissing(candidate: string): Promise<void> {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing unsafe Codex home file: ${candidate}`);
    }
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
}

async function writePrivateFile(
  destination: string,
  contents: string | Buffer,
): Promise<void> {
  await assertRegularOrMissing(destination);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(temporary, PRIVATE_FILE_MODE);
    try {
      await rename(temporary, destination);
    } catch (cause) {
      // Windows cannot atomically replace an existing file. The destination
      // was verified above and this directory is private to Grimodex.
      if (
        typeof cause !== "object" ||
        cause === null ||
        !("code" in cause) ||
        (cause.code !== "EEXIST" && cause.code !== "EPERM")
      ) {
        throw cause;
      }
      await assertRegularOrMissing(destination);
      await rm(destination, { force: true });
      await rename(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function removePrivateFileIfPresent(candidate: string): Promise<void> {
  await assertRegularOrMissing(candidate);
  await rm(candidate, { force: true });
}

function normalizeHome(candidate: string, name: string): string {
  const trimmed = candidate.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${name} must be absolute`);
  }
  return path.resolve(trimmed);
}

export function resolveUserCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, ".codex");
}

export interface PrepareIsolatedCodexHomeOptions {
  codexHomeDir: string;
  sourceCodexHomeDir?: string;
}

/**
 * Prepares the only Codex home visible to the app-server process. No user
 * config, project trust, plugins, hooks, skills, or MCP declarations cross
 * this boundary; auth.json is the sole synchronized file.
 */
export async function prepareIsolatedCodexHome(
  options: PrepareIsolatedCodexHomeOptions,
): Promise<string> {
  const codexHomeDir = normalizeHome(options.codexHomeDir, "Codex home");
  const sourceCodexHomeDir = normalizeHome(
    options.sourceCodexHomeDir ?? resolveUserCodexHome(),
    "Source Codex home",
  );
  if (codexHomeDir === sourceCodexHomeDir) {
    throw new Error("Grimodex Codex home must be isolated from the user home");
  }

  await mkdir(codexHomeDir, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const homeInfo = await lstat(codexHomeDir);
  if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
    throw new Error("Grimodex Codex home is not a private directory");
  }
  await chmod(codexHomeDir, PRIVATE_DIRECTORY_MODE);

  await writePrivateFile(
    path.join(codexHomeDir, "config.toml"),
    GRIMODEX_CODEX_CONFIG,
  );

  const sourceAuth = path.join(sourceCodexHomeDir, "auth.json");
  const destinationAuth = path.join(codexHomeDir, "auth.json");
  let sourceInfo;
  try {
    sourceInfo = await lstat(sourceAuth);
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
    await removePrivateFileIfPresent(destinationAuth);
    return codexHomeDir;
  }
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error("User Codex auth.json is not a regular file");
  }
  if (sourceInfo.size > MAX_AUTH_JSON_BYTES) {
    throw new Error("User Codex auth.json exceeds the size limit");
  }
  const sourceHandle = await open(
    sourceAuth,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let auth: Buffer;
  try {
    const openedInfo = await sourceHandle.stat();
    if (!openedInfo.isFile()) {
      throw new Error("User Codex auth.json is not a regular file");
    }
    if (openedInfo.size > MAX_AUTH_JSON_BYTES) {
      throw new Error("User Codex auth.json exceeds the size limit");
    }
    const buffer = Buffer.allocUnsafe(MAX_AUTH_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_AUTH_JSON_BYTES) {
      throw new Error("User Codex auth.json exceeds the size limit");
    }
    auth = buffer.subarray(0, offset);
  } finally {
    await sourceHandle.close();
  }
  await writePrivateFile(destinationAuth, auth);
  return codexHomeDir;
}
