// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ScanHandle } from "../api/scanApiClient";
import {
  clearScanOwnership,
  readScanOwnership,
  SCAN_OWNERSHIP_STORAGE_KEY,
  writeScanOwnership,
} from "./scanOwnershipStorage";

const handle: ScanHandle = {
  scanId: "scan-owned-1",
  scanToken: "scan-owned-secret",
  mode: "quick",
};

describe("Scan ownership session storage", () => {
  it("restores only a valid versioned Scan handle", () => {
    writeScanOwnership(sessionStorage, handle, null);
    expect(readScanOwnership(sessionStorage, null)).toEqual(handle);

    sessionStorage.setItem(
      SCAN_OWNERSHIP_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [{ subject: null, handle: { ...handle, mode: "invalid" } }],
      }),
    );
    expect(readScanOwnership(sessionStorage, null)).toBeNull();
  });

  it("removes the deletion capability after confirmed deletion", () => {
    writeScanOwnership(sessionStorage, handle, "access-subject-a");
    clearScanOwnership(sessionStorage, "access-subject-a");
    expect(readScanOwnership(sessionStorage, "access-subject-a")).toBeNull();
  });

  it("returns only the handle associated with the active Access subject", () => {
    const secondHandle: ScanHandle = {
      scanId: "scan-owned-2",
      scanToken: "scan-owned-secret-2",
      mode: "full",
    };

    writeScanOwnership(sessionStorage, handle, "access-subject-a");
    writeScanOwnership(sessionStorage, secondHandle, "access-subject-b");

    expect(readScanOwnership(sessionStorage, "access-subject-a")).toEqual(
      handle,
    );
    expect(readScanOwnership(sessionStorage, "access-subject-b")).toEqual(
      secondHandle,
    );
    expect(readScanOwnership(sessionStorage, "access-subject-c")).toBeNull();
  });

  it("does not clear another account's retained handle", () => {
    writeScanOwnership(sessionStorage, handle, "access-subject-a");

    clearScanOwnership(sessionStorage, "access-subject-b");

    expect(readScanOwnership(sessionStorage, "access-subject-a")).toEqual(
      handle,
    );
  });

  it("migrates a legacy unscoped handle for local unauthenticated use", () => {
    sessionStorage.setItem(
      "grimodex.scan.ownership.v1",
      JSON.stringify({ version: 1, handle }),
    );

    expect(readScanOwnership(sessionStorage, null)).toEqual(handle);
    expect(sessionStorage.getItem("grimodex.scan.ownership.v1")).toBeNull();
    expect(readScanOwnership(sessionStorage, null)).toEqual(handle);
  });

  it("binds a legacy bearer capability to the first authenticated account", () => {
    sessionStorage.setItem(
      "grimodex.scan.ownership.v1",
      JSON.stringify({ version: 1, handle }),
    );

    expect(readScanOwnership(sessionStorage, "access-subject-b")).toEqual(
      handle,
    );
    expect(sessionStorage.getItem("grimodex.scan.ownership.v1")).toBeNull();
    expect(readScanOwnership(sessionStorage, "access-subject-b")).toEqual(
      handle,
    );
    expect(readScanOwnership(sessionStorage, "access-subject-c")).toBeNull();
  });
});
