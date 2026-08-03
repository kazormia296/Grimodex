import { describe, expect, it } from "vitest";
import { shouldClearRetainedEditorRecoveryDraft } from "./editorSaveResult";

describe("shouldClearRetainedEditorRecoveryDraft", () => {
  it("clears only a persisted save for the current edit generation", () => {
    expect(
      shouldClearRetainedEditorRecoveryDraft({
        persisted: true,
        committed: true,
      }),
    ).toBe(true);
    expect(
      shouldClearRetainedEditorRecoveryDraft({
        persisted: true,
        committed: false,
      }),
    ).toBe(false);
  });

  it("keeps the draft after a skipped or failed persistence attempt", () => {
    expect(
      shouldClearRetainedEditorRecoveryDraft({
        persisted: false,
        committed: false,
      }),
    ).toBe(false);
  });
});
