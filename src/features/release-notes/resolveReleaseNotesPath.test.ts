import { describe, it, expect } from "vitest";
import {
  resolveReleaseNotesPath,
  jaReleaseNotesPath,
} from "./resolveReleaseNotesPath";

describe("resolveReleaseNotesPath", () => {
  const version = "0.10.4";

  it("returns ja-only paths for ja UI", () => {
    expect(resolveReleaseNotesPath(version, "ja")).toEqual({
      primary: "RELEASE_NOTES/v0.10.4.ja.md",
    });
    expect(resolveReleaseNotesPath(version, "ja-JP")).toEqual({
      primary: "RELEASE_NOTES/v0.10.4.ja.md",
    });
  });

  it("returns en primary with ja fallback for en UI", () => {
    expect(resolveReleaseNotesPath(version, "en")).toEqual({
      primary: "RELEASE_NOTES/v0.10.4.en.md",
      fallback: "RELEASE_NOTES/v0.10.4.ja.md",
    });
    expect(resolveReleaseNotesPath(version, "en-US")).toEqual({
      primary: "RELEASE_NOTES/v0.10.4.en.md",
      fallback: "RELEASE_NOTES/v0.10.4.ja.md",
    });
  });
});

describe("jaReleaseNotesPath", () => {
  it("returns ja file path", () => {
    expect(jaReleaseNotesPath("1.2.3")).toBe("RELEASE_NOTES/v1.2.3.ja.md");
  });
});
