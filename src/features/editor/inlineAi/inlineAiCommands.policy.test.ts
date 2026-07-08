// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/ai-policy/policyGuard", () => ({
  isAiFeatureBlockedByPolicy: vi.fn(() => false),
}));

import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import {
  getVisibleInlineAiCommands,
  getInlineAiCommands,
  filterCommands,
} from "./inlineAiCommands";

const mockBlocked = vi.mocked(isAiFeatureBlockedByPolicy);

describe("getVisibleInlineAiCommands — bodyWrite policy filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all commands when bodyWrite is allowed", () => {
    mockBlocked.mockReturnValue(false);
    expect(getVisibleInlineAiCommands()).toHaveLength(
      getInlineAiCommands().length,
    );
  });

  it("excludes AI-generation commands but keeps sceneBeat when bodyWrite=off", () => {
    mockBlocked.mockReturnValue(true);
    const visible = getVisibleInlineAiCommands();
    expect(visible.every((c) => c.kind === "insert-node")).toBe(true);
    expect(visible.some((c) => c.id === "sceneBeat")).toBe(true);
    expect(visible.some((c) => c.id === "continue")).toBe(false);
    expect(visible.some((c) => c.id === "rewrite")).toBe(false);
  });

  it("filterCommands drops kind:ai commands when bodyWrite=off", () => {
    mockBlocked.mockReturnValue(true);
    const result = filterCommands("");
    expect(result.some((c) => c.id === "sceneBeat")).toBe(true);
    expect(result.some((c) => c.id === "continue")).toBe(false);
  });

  it("filterCommands drops needsSelection commands even when bodyWrite=on", () => {
    // policy が許可でも slash は選択系コマンドを出さない (選択保持不可のため)。
    mockBlocked.mockReturnValue(false);
    const result = filterCommands("");
    for (const excluded of [
      "rewrite",
      "shorten",
      "expand",
      "tone",
      "translate",
    ]) {
      expect(result.some((c) => c.id === excluded)).toBe(false);
    }
    expect(result.some((c) => c.id === "continue")).toBe(true);
    expect(result.some((c) => c.id === "sceneBeat")).toBe(true);
  });
});
