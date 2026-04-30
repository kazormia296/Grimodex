import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "./types";

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
