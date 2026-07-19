import { describe, expect, it } from "vitest";
import { WEB_EDITOR_SETTINGS_CATEGORIES } from "./WebEditorSettingsDialog";

describe("Web Editor settings navigation", () => {
  it("uses a localized, trial-scoped category catalog", () => {
    expect(WEB_EDITOR_SETTINGS_CATEGORIES.map(({ id }) => id)).toEqual([
      "project",
      "ai",
      "editor",
      "display",
      "about",
    ]);
    for (const category of WEB_EDITOR_SETTINGS_CATEGORIES) {
      expect(category.labelKey).toMatch(
        /^hostedEditor\.settings\.categories\./,
      );
    }
  });
});
