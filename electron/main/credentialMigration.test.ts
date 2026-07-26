import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  LEGACY_KEYRING_MIGRATION_MARKER,
  migrateLegacyKeyringToSafeStorage,
} from "./credentialMigration.js";
import { createKeyStore, type SafeStorageLike } from "./keyStore.js";

function storage(
  backend: ReturnType<
    SafeStorageLike["getSelectedStorageBackend"]
  > = "gnome_libsecret",
): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (encrypted) =>
      encrypted.toString("utf8").replace(/^enc:/, ""),
  };
}

function nativeExport(entries: unknown[], available = true): NapiBackendLike {
  return {
    readLegacyApiKeysForMigration: vi.fn(async () =>
      JSON.stringify({ available, entries }),
    ),
  } as unknown as NapiBackendLike;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "grimodex-credential-migration-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("migrateLegacyKeyringToSafeStorage", () => {
  it("atomically imports keys, writes a non-secret marker, and is idempotent", async () => {
    const backend = nativeExport([
      { provider: "openai", endpointId: null, key: "sk-openai" },
      {
        provider: "openai-compatible",
        endpointId: "endpoint-a",
        key: "sk-compatible",
      },
    ]);
    const keyStore = createKeyStore(root, storage());
    const now = new Date("2026-07-11T00:00:00.000Z");

    await expect(
      migrateLegacyKeyringToSafeStorage(backend, keyStore, root, now),
    ).resolves.toEqual({
      status: "migrated",
      imported: 2,
      skippedExisting: 0,
    });
    const marker = readFileSync(
      path.join(root, LEGACY_KEYRING_MIGRATION_MARKER),
      "utf8",
    );
    expect(marker).toContain("2026-07-11T00:00:00.000Z");
    expect(marker).not.toContain("sk-openai");
    expect(
      keyStore.resolveApiKeyForRequest(
        { provider: "openai" },
        undefined,
        undefined,
      ),
    ).toBe("sk-openai");

    await expect(
      migrateLegacyKeyringToSafeStorage(backend, keyStore, root, now),
    ).resolves.toEqual({ status: "already-complete" });
    expect(backend.readLegacyApiKeysForMigration).toHaveBeenCalledTimes(1);
  });

  it("keeps existing safeStorage values instead of overwriting them", async () => {
    const keyStore = createKeyStore(root, storage());
    keyStore.saveApiKey("anthropic", null, "safe-new");
    const backend = nativeExport([
      { provider: "anthropic", endpointId: null, key: "keyring-old" },
    ]);

    await expect(
      migrateLegacyKeyringToSafeStorage(backend, keyStore, root),
    ).resolves.toMatchObject({
      status: "migrated",
      imported: 0,
      skippedExisting: 1,
    });
    expect(
      keyStore.resolveApiKeyForRequest(
        { provider: "anthropic" },
        undefined,
        undefined,
      ),
    ).toBe("safe-new");
  });

  it("does not write a marker when the native release feature is unavailable", async () => {
    const backend = nativeExport([], false);
    await expect(
      migrateLegacyKeyringToSafeStorage(
        backend,
        createKeyStore(root, storage()),
        root,
      ),
    ).resolves.toEqual({ status: "unavailable" });
    expect(existsSync(path.join(root, LEGACY_KEYRING_MIGRATION_MARKER))).toBe(
      false,
    );
  });

  it("leaves the marker absent when secure storage is weak or import fails", async () => {
    const backend = nativeExport([
      { provider: "openai", endpointId: null, key: "secret" },
    ]);
    await expect(
      migrateLegacyKeyringToSafeStorage(
        backend,
        createKeyStore(root, storage("basic_text"), "linux"),
        root,
      ),
    ).rejects.toThrow(/password store|safeStorage|OS/i);
    expect(existsSync(path.join(root, LEGACY_KEYRING_MIGRATION_MARKER))).toBe(
      false,
    );
  });

  it("rejects malformed native output without creating files", async () => {
    const backend = {
      readLegacyApiKeysForMigration: vi.fn(async () =>
        JSON.stringify({ available: true, entries: [{ key: 42 }] }),
      ),
    } as unknown as NapiBackendLike;
    await expect(
      migrateLegacyKeyringToSafeStorage(
        backend,
        createKeyStore(root, storage()),
        root,
      ),
    ).rejects.toThrow(/invalid entry/);
    expect(existsSync(path.join(root, "ai-keys.json"))).toBe(false);
    expect(existsSync(path.join(root, LEGACY_KEYRING_MIGRATION_MARKER))).toBe(
      false,
    );
  });
});
