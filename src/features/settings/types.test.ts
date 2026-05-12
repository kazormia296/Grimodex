import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, KEY_SCOPE } from "./types";

describe("KEY_SCOPE — カバレッジ", () => {
  it("DEFAULT_SETTINGS の全 key が KEY_SCOPE に含まれる", () => {
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (key) => KEY_SCOPE[key] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("KEY_SCOPE の値は global か project のみ", () => {
    const invalid = Object.entries(KEY_SCOPE).filter(
      ([, scope]) => scope !== "global" && scope !== "project",
    );
    expect(invalid).toEqual([]);
  });
});

describe("DEFAULT_SETTINGS — Beat Phase C keys", () => {
  it("beat.injectIntoContext のデフォルトは true", () => {
    expect(DEFAULT_SETTINGS["beat.injectIntoContext"]).toBe("true");
  });

  it("beat.inferRoles のデフォルトは true", () => {
    expect(DEFAULT_SETTINGS["beat.inferRoles"]).toBe("true");
  });

  it("beat.roleInferenceConfidenceThreshold のデフォルトは 0.7", () => {
    expect(DEFAULT_SETTINGS["beat.roleInferenceConfidenceThreshold"]).toBe(
      "0.7",
    );
  });
});
