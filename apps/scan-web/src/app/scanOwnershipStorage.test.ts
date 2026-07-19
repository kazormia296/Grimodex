// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ScanHandle } from "../api/scanApiClient";
import {
  clearScanOwnership,
  readScanOwnership,
  writeScanOwnership,
} from "./scanOwnershipStorage";

const handle: ScanHandle = {
  scanId: "scan-owned-1",
  scanToken: "scan-owned-secret",
  mode: "quick",
};

describe("Scan ownership session storage", () => {
  it("restores only a valid versioned Scan handle", () => {
    writeScanOwnership(sessionStorage, handle);
    expect(readScanOwnership(sessionStorage)).toEqual(handle);

    sessionStorage.setItem(
      "grimodex.scan.ownership.v1",
      JSON.stringify({ version: 1, handle: { ...handle, mode: "invalid" } }),
    );
    expect(readScanOwnership(sessionStorage)).toBeNull();
  });

  it("removes the deletion capability after confirmed deletion", () => {
    writeScanOwnership(sessionStorage, handle);
    clearScanOwnership(sessionStorage);
    expect(readScanOwnership(sessionStorage)).toBeNull();
  });
});
