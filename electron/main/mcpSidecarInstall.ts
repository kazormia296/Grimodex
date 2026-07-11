/**
 * Materialize the packaged Linux MCP sidecar outside an AppImage mount.
 * The destination is content-addressed by comparison, but intentionally has a
 * stable path so copied `.mcp.json` files remain valid after the app exits.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename as renameFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const COPY_BUFFER_SIZE = 1024 * 1024;
const EXECUTABLE_MODE = 0o755;

export type McpSidecarMaterializer = (
  sourcePath: string,
  userDataDir: string,
) => Promise<string>;

export interface McpSidecarMaterializerDependencies {
  rename?: (temporaryPath: string, destinationPath: string) => Promise<void>;
  randomId?: () => string;
}

function sourceValidationError(sourcePath: string): Error {
  return new Error(
    `MCP sidecar source must be an executable regular non-symlink file: ${sourcePath}`,
  );
}

function openReadOnlyNoFollowFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

async function openValidatedSource(sourcePath: string): Promise<{
  handle: FileHandle;
  initial: Awaited<ReturnType<FileHandle["stat"]>>;
}> {
  let linkMetadata;
  try {
    linkMetadata = await lstat(sourcePath);
  } catch {
    throw sourceValidationError(sourcePath);
  }
  if (
    linkMetadata.isSymbolicLink() ||
    !linkMetadata.isFile() ||
    (linkMetadata.mode & 0o111) === 0
  ) {
    throw sourceValidationError(sourcePath);
  }

  let handle: FileHandle;
  try {
    handle = await open(sourcePath, openReadOnlyNoFollowFlags());
  } catch {
    throw sourceValidationError(sourcePath);
  }
  try {
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.dev !== linkMetadata.dev ||
      initial.ino !== linkMetadata.ino
    ) {
      throw sourceValidationError(sourcePath);
    }
    return { handle, initial };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copyAndHash(
  source: FileHandle,
  temporary: FileHandle,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await temporary.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function hashExistingDestination(
  destinationPath: string,
): Promise<{ handle: FileHandle; hash: string } | null> {
  let linkMetadata;
  try {
    linkMetadata = await lstat(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) return null;

  let handle: FileHandle;
  try {
    handle = await open(destinationPath, openReadOnlyNoFollowFlags());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== linkMetadata.dev ||
      openedMetadata.ino !== linkMetadata.ino
    ) {
      await handle.close();
      return null;
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { handle, hash: hash.digest("hex") };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sourceUnchanged(
  initial: Awaited<ReturnType<FileHandle["stat"]>>,
  final: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    initial.dev === final.dev &&
    initial.ino === final.ino &&
    initial.size === final.size &&
    initial.mtimeMs === final.mtimeMs &&
    initial.ctimeMs === final.ctimeMs
  );
}

/** Create an isolated materializer; the default export below owns app-wide singleflight. */
export function createMcpSidecarMaterializer(
  dependencies: McpSidecarMaterializerDependencies = {},
): McpSidecarMaterializer {
  const rename = dependencies.rename ?? renameFile;
  const randomId = dependencies.randomId ?? randomUUID;
  const inFlight = new Map<string, Promise<string>>();

  return (sourcePath, userDataDir) => {
    if (!path.isAbsolute(sourcePath)) {
      return Promise.reject(
        new Error(`MCP sidecar source path must be absolute: ${sourcePath}`),
      );
    }
    if (!path.isAbsolute(userDataDir)) {
      return Promise.reject(
        new Error(`MCP sidecar userData path must be absolute: ${userDataDir}`),
      );
    }
    const binDirectory = path.join(userDataDir, "bin");
    const destinationPath = path.join(binDirectory, "grimodex-mcp");
    const pending = inFlight.get(destinationPath);
    if (pending) return pending;

    const operation = (async () => {
      await mkdir(binDirectory, { recursive: true });
      const source = await openValidatedSource(sourcePath);
      const temporaryPath = path.join(
        binDirectory,
        `.grimodex-mcp-${process.pid}-${randomId()}.tmp`,
      );
      let temporary: FileHandle | null = null;
      try {
        temporary = await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        const sourceHash = await copyAndHash(source.handle, temporary);
        const finalSourceMetadata = await source.handle.stat();
        if (!sourceUnchanged(source.initial, finalSourceMetadata)) {
          throw new Error(
            `MCP sidecar source changed while being copied: ${sourcePath}`,
          );
        }
        await temporary.chmod(EXECUTABLE_MODE);
        await temporary.sync();
        await temporary.close();
        temporary = null;

        const existing = await hashExistingDestination(destinationPath);
        if (existing) {
          try {
            if (existing.hash === sourceHash) {
              await existing.handle.chmod(EXECUTABLE_MODE);
              await existing.handle.sync();
              return destinationPath;
            }
          } finally {
            await existing.handle.close();
          }
        }

        // POSIX rename in one directory atomically swaps the previous known-good
        // executable only after the complete replacement has been fsynced.
        await rename(temporaryPath, destinationPath);
        return destinationPath;
      } finally {
        await temporary?.close().catch(() => undefined);
        await source.handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    })();
    const tracked = operation.finally(() => {
      if (inFlight.get(destinationPath) === tracked) {
        inFlight.delete(destinationPath);
      }
    });
    inFlight.set(destinationPath, tracked);
    return tracked;
  };
}

export const materializeMcpSidecar = createMcpSidecarMaterializer();
