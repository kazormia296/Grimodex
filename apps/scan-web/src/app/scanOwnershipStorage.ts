import type { ScanHandle } from "../api/scanApiClient";

export const SCAN_OWNERSHIP_STORAGE_KEY = "grimodex.scan.ownership.v2";

const LEGACY_SCAN_OWNERSHIP_STORAGE_KEY = "grimodex.scan.ownership.v1";
const MAX_STORED_ACCOUNT_OWNERSHIPS = 8;

export type ScanOwnershipSubject = string | null;

interface StoredScanOwnershipEntry {
  subject: ScanOwnershipSubject;
  handle: ScanHandle;
}

interface StoredScanOwnership {
  version: 2;
  entries: StoredScanOwnershipEntry[];
}

function isScanHandle(value: unknown): value is ScanHandle {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const handle = value as Record<string, unknown>;
  return (
    typeof handle.scanId === "string" &&
    handle.scanId.length > 0 &&
    typeof handle.scanToken === "string" &&
    handle.scanToken.length > 0 &&
    (handle.mode === "quick" || handle.mode === "full")
  );
}

function isOwnershipSubject(value: unknown): value is ScanOwnershipSubject {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= 2_048)
  );
}

function isStoredOwnership(value: unknown): value is StoredScanOwnership {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const stored = value as Record<string, unknown>;
  if (stored.version !== 2 || !Array.isArray(stored.entries)) return false;
  if (stored.entries.length > MAX_STORED_ACCOUNT_OWNERSHIPS) return false;
  return stored.entries.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return false;
    const record = entry as Record<string, unknown>;
    return isOwnershipSubject(record.subject) && isScanHandle(record.handle);
  });
}

function readStoredOwnership(storage: Storage): StoredScanOwnership | null {
  const raw = storage.getItem(SCAN_OWNERSHIP_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isStoredOwnership(value)) return value;
  } catch {
    // Invalid capability records are removed below.
  }
  storage.removeItem(SCAN_OWNERSHIP_STORAGE_KEY);
  return null;
}

function takeLegacyOwnership(storage: Storage): ScanHandle | null {
  const raw = storage.getItem(LEGACY_SCAN_OWNERSHIP_STORAGE_KEY);
  if (!raw) return null;

  // v1 did not record the Access subject. Remove the unscoped capability
  // before parsing so a storage failure cannot leave it eligible for a later,
  // potentially different account.
  storage.removeItem(LEGACY_SCAN_OWNERSHIP_STORAGE_KEY);
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.version === 1 && isScanHandle(value.handle)
      ? value.handle
      : null;
  } catch {
    return null;
  }
}

function sameSubject(
  left: ScanOwnershipSubject,
  right: ScanOwnershipSubject,
): boolean {
  return left === right;
}

export function currentScanOwnershipStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readScanOwnership(
  storage: Storage | null,
  subject: ScanOwnershipSubject = null,
): ScanHandle | null {
  if (!storage) return null;
  try {
    const stored = readStoredOwnership(storage);
    const legacyHandle = takeLegacyOwnership(storage);
    const matchingEntry = stored?.entries.find((entry) =>
      sameSubject(entry.subject, subject),
    );
    if (matchingEntry) return matchingEntry.handle;

    // A v1 handle predates account scoping and is itself the legacy ownership
    // capability. Bind it once to the account that first presents it. The
    // Worker performs the matching atomic owner claim, so a wrong or stale
    // capability still cannot acquire server data.
    if (legacyHandle) {
      writeScanOwnership(storage, legacyHandle, subject);
      return legacyHandle;
    }
  } catch {
    try {
      storage.removeItem(SCAN_OWNERSHIP_STORAGE_KEY);
      storage.removeItem(LEGACY_SCAN_OWNERSHIP_STORAGE_KEY);
    } catch {
      // Storage can become unavailable after the initial read.
    }
  }
  return null;
}

export function writeScanOwnership(
  storage: Storage | null,
  handle: ScanHandle,
  subject: ScanOwnershipSubject = null,
): void {
  if (!storage) return;
  try {
    const existing = readStoredOwnership(storage)?.entries ?? [];
    const entries = existing.filter(
      (entry) => !sameSubject(entry.subject, subject),
    );
    entries.push({ subject, handle });
    const value: StoredScanOwnership = {
      version: 2,
      entries: entries.slice(-MAX_STORED_ACCOUNT_OWNERSHIPS),
    };
    storage.setItem(SCAN_OWNERSHIP_STORAGE_KEY, JSON.stringify(value));
    storage.removeItem(LEGACY_SCAN_OWNERSHIP_STORAGE_KEY);
  } catch {
    // Deletion remains available for the lifetime of the current page state.
  }
}

export function clearScanOwnership(
  storage: Storage | null,
  subject: ScanOwnershipSubject = null,
): void {
  if (!storage) return;
  try {
    const existing = readStoredOwnership(storage)?.entries ?? [];
    const entries = existing.filter(
      (entry) => !sameSubject(entry.subject, subject),
    );
    if (entries.length === 0) storage.removeItem(SCAN_OWNERSHIP_STORAGE_KEY);
    else {
      const value: StoredScanOwnership = { version: 2, entries };
      storage.setItem(SCAN_OWNERSHIP_STORAGE_KEY, JSON.stringify(value));
    }
    storage.removeItem(LEGACY_SCAN_OWNERSHIP_STORAGE_KEY);
  } catch {
    // The server-side deletion has already completed; storage is best-effort.
  }
}
