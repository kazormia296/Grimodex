import { describe, it, expect } from "vitest";
import { slugifyTitle, resolveUniqueSlug, padIndex } from "./slug";

describe("slug", () => {
  it("preserves Japanese characters", () => {
    expect(slugifyTitle("第一章")).toBe("第一章");
  });

  it("replaces Windows-forbidden characters", () => {
    expect(slugifyTitle('scene: "test"')).toBe("scene_ _test_");
  });

  it("appends suffix for reserved names", () => {
    expect(slugifyTitle("CON")).toBe("CON_");
  });

  it("resolves duplicate slugs with numeric suffix", () => {
    const used = new Set<string>();
    expect(resolveUniqueSlug("Scene", used)).toBe("Scene");
    expect(resolveUniqueSlug("Scene", used)).toBe("Scene-2");
    expect(resolveUniqueSlug("Scene", used)).toBe("Scene-3");
  });

  it("zero-pads indices", () => {
    expect(padIndex(1)).toBe("01");
    expect(padIndex(12)).toBe("12");
  });
});
