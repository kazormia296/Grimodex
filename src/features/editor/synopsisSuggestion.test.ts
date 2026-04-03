import { describe, it, expect } from "vitest";
import { shouldPromptSynopsis } from "./synopsisSuggestion";
import type { SceneStatus } from "@/features/tree/treeStore";

describe("shouldPromptSynopsis", () => {
  const triggerStatuses: SceneStatus[] = ["complete", "revision", "final"];
  const nonTriggerStatuses: SceneStatus[] = ["outline", "draft"];

  it("returns true when transitioning to complete with empty synopsis", () => {
    expect(shouldPromptSynopsis("draft", "complete", null)).toBe(true);
    expect(shouldPromptSynopsis("draft", "complete", "")).toBe(true);
  });

  it("returns true when transitioning to revision with empty synopsis", () => {
    expect(shouldPromptSynopsis("draft", "revision", null)).toBe(true);
  });

  it("returns true when transitioning to final with empty synopsis", () => {
    expect(shouldPromptSynopsis("draft", "final", null)).toBe(true);
  });

  it("returns false when synopsis is already set", () => {
    for (const s of triggerStatuses) {
      expect(shouldPromptSynopsis("draft", s, "This is a synopsis")).toBe(
        false,
      );
    }
  });

  it("returns false for non-triggering statuses", () => {
    for (const s of nonTriggerStatuses) {
      expect(shouldPromptSynopsis("draft", s, null)).toBe(false);
    }
  });

  it("returns false when status did not change", () => {
    expect(shouldPromptSynopsis("complete", "complete", null)).toBe(false);
  });

  it("returns false when previous status is null (initial load)", () => {
    expect(shouldPromptSynopsis(null, "complete", null)).toBe(false);
  });

  it("returns false when new status is null", () => {
    expect(shouldPromptSynopsis("draft", null, null)).toBe(false);
  });
});
