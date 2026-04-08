import { describe, it, expect } from "vitest";
import { iconToDataUrl } from "./iconUtils";

describe("iconToDataUrl", () => {
  it("returns null for null input", () => {
    expect(iconToDataUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(iconToDataUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(iconToDataUrl("")).toBeNull();
  });

  it("returns null for non-data-url strings", () => {
    expect(iconToDataUrl("[blob 1234 bytes]")).toBeNull();
    expect(iconToDataUrl("[1,2,3]")).toBeNull();
    expect(iconToDataUrl("blob:http://localhost/test")).toBeNull();
  });

  it("returns the string for valid data URLs", () => {
    const url = "data:image/webp;base64,UklGRg==";
    expect(iconToDataUrl(url)).toBe(url);
  });
});
