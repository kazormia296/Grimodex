/**
 * One-shot legacy Tauri keyring -> Electron safeStorage migration.
 *
 * Plaintext crosses only the in-process N-API/main boundary and is immediately
 * encrypted by `SecretsBridge.importLegacyApiKeys`. Renderer IPC has no command
 * mapping for the native export method. The legacy keyring is never deleted,
 * preserving rollback to the final Tauri release.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import type { LegacyApiKeyEntry, SecretsBridge } from "./keyStore.js";

const MIGRATION_VERSION = 1;
export const LEGACY_KEYRING_MIGRATION_MARKER =
  "legacy-keyring-migration-v1.json";

interface LegacyKeyExport {
  available: boolean;
  entries: LegacyApiKeyEntry[];
}

export type CredentialMigrationResult =
  | { status: "already-complete" }
  | { status: "unavailable" }
  | { status: "migrated"; imported: number; skippedExisting: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyKeyExport(raw: string): LegacyKeyExport {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error("Legacy keyring export is not valid JSON", { cause });
  }
  if (
    !isRecord(value) ||
    typeof value.available !== "boolean" ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Legacy keyring export has an invalid envelope");
  }
  const entries = value.entries.map((entry): LegacyApiKeyEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.provider !== "string" ||
      (entry.endpointId !== null && typeof entry.endpointId !== "string") ||
      typeof entry.key !== "string"
    ) {
      throw new Error("Legacy keyring export has an invalid entry");
    }
    return {
      provider: entry.provider,
      endpointId: entry.endpointId,
      key: entry.key,
    };
  });
  return { available: value.available, entries };
}

function markerIsComplete(markerPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw new Error("Credential migration marker cannot be read", { cause });
  }
  let marker: unknown;
  try {
    marker = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error("Credential migration marker is corrupt", { cause });
  }
  if (!isRecord(marker) || marker.version !== MIGRATION_VERSION) {
    throw new Error("Credential migration marker has an unsupported format");
  }
  return true;
}

function writeMarker(
  markerPath: string,
  result: { imported: number; skippedExisting: number },
  now: Date,
): void {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tmp, "wx", 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify(
        {
          version: MIGRATION_VERSION,
          completedAt: now.toISOString(),
          imported: result.imported,
          skippedExisting: result.skippedExisting,
        },
        null,
        2,
      ),
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tmp, markerPath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(tmp, { force: true });
  }
}

/** Run before any renderer window is created. Failures leave no marker. */
export async function migrateLegacyKeyringToSafeStorage(
  backend: NapiBackendLike | null,
  keyStore: SecretsBridge,
  userDataDir: string,
  now: Date = new Date(),
): Promise<CredentialMigrationResult> {
  const markerPath = path.join(userDataDir, LEGACY_KEYRING_MIGRATION_MARKER);
  if (markerIsComplete(markerPath)) return { status: "already-complete" };

  const exportKeys = backend?.readLegacyApiKeysForMigration;
  if (typeof exportKeys !== "function") return { status: "unavailable" };
  const exported = parseLegacyKeyExport(await exportKeys.call(backend));
  if (!exported.available) return { status: "unavailable" };

  const result =
    exported.entries.length === 0
      ? { imported: 0, skippedExisting: 0 }
      : keyStore.importLegacyApiKeys(exported.entries);
  writeMarker(markerPath, result, now);
  return { status: "migrated", ...result };
}
