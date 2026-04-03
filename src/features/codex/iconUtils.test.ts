import { describe, it, expect, vi, afterEach } from "vitest";
import { numberArrayToObjectUrl } from "./iconUtils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("numberArrayToObjectUrl", () => {
  it("returns null for null input", () => {
    const result = numberArrayToObjectUrl(null);
    expect(result).toBeNull();
  });

  it("returns null for undefined input", () => {
    const result = numberArrayToObjectUrl(undefined);
    expect(result).toBeNull();
  });

  it("returns null for empty array", () => {
    const result = numberArrayToObjectUrl([]);
    expect(result).toBeNull();
  });

  it("returns a blob: URL for non-empty array", () => {
    vi.stubGlobal(
      "URL",
      class {
        static createObjectURL(_blob: Blob) {
          return "blob:http://localhost/test-uuid";
        }
        static revokeObjectURL(_url: string) {}
      },
    );

    const result = numberArrayToObjectUrl([137, 80, 78, 71]);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^blob:/);
  });
});
