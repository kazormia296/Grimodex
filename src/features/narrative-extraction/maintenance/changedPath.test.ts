import { describe, expect, it } from "vitest";

import {
  canonicalChangedPaths,
  isCanonicalChangedPath,
  jsonPointerSegment,
} from "./changedPath";

describe("Narrative Change Feed changed paths", () => {
  it("accepts JSON Pointer escapes and rejects writer-specific names", () => {
    expect(isCanonicalChangedPath("/title")).toBe(true);
    expect(isCanonicalChangedPath("/sceneLinks/a~1b")).toBe(true);
    expect(isCanonicalChangedPath("title")).toBe(false);
    expect(isCanonicalChangedPath("/title~2")).toBe(false);
  });

  it("sorts a deterministic unique vocabulary", () => {
    expect(canonicalChangedPaths(["/z", "/a"])).toEqual(["/a", "/z"]);
    expect(canonicalChangedPaths(["/😀", "/é"])).toEqual(["/é", "/😀"]);
    expect(() => canonicalChangedPaths(["/a", "/a"])).toThrow("duplicates");
  });

  it("escapes child identities before composing paths", () => {
    expect(jsonPointerSegment("marker/a~b")).toBe("marker~1a~0b");
  });
});
