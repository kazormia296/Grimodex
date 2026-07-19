import type { ScanHandle } from "../api/scanApiClient";

export const SCAN_OWNERSHIP_STORAGE_KEY = "grimodex.scan.ownership.v1";

interface StoredScanOwnership {
  version: 1;
  handle: ScanHandle;
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

export function currentScanOwnershipStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readScanOwnership(storage: Storage | null): ScanHandle | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SCAN_OWNERSHIP_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredScanOwnership>;
    if (value.version === 1 && isScanHandle(value.handle)) return value.handle;
    storage.removeItem(SCAN_OWNERSHIP_STORAGE_KEY);
  } catch {
    try {
      storage.removeItem(SCAN_OWNERSHIP_STORAGE_KEY);
    } catch {
      // Storage can become unavailable after the initial read.
    }
  }
  return null;
}

export function writeScanOwnership(
  storage: Storage | null,
  handle: ScanHandle,
): void {
  if (!storage) return;
  try {
    const value: StoredScanOwnership = { version: 1, handle };
    storage.setItem(SCAN_OWNERSHIP_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Deletion remains available for the lifetime of the current page state.
  }
}

export function clearScanOwnership(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(SCAN_OWNERSHIP_STORAGE_KEY);
  } catch {
    // The server-side deletion has already completed; storage is best-effort.
  }
}
