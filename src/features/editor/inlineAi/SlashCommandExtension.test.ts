import { describe, it, expect } from "vitest";
import {
  filterCommands,
  getInlineAiCommands,
  INLINE_AI_COMMANDS,
} from "./inlineAiCommands";

describe("filterCommands", () => {
  it("returns all commands for empty query", () => {
    expect(filterCommands("")).toHaveLength(INLINE_AI_COMMANDS.length);
  });

  it("filters by command id prefix", () => {
    const result = filterCommands("con");
    expect(result.some((c) => c.id === "continue")).toBe(true);
    expect(result.every((c) => c.id.startsWith("con"))).toBe(true);
  });

  it("returns empty array for no match", () => {
    const result = filterCommands("zzznomatch");
    expect(result).toHaveLength(0);
  });

  it("all commands have required fields", () => {
    for (const cmd of getInlineAiCommands()) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.label).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(["insert", "replace"]).toContain(cmd.mode);
    }
  });

  it("replace-mode commands all require selection", () => {
    const replaceCommands = INLINE_AI_COMMANDS.filter(
      (c) => c.mode === "replace",
    );
    expect(replaceCommands.every((c) => c.needsSelection)).toBe(true);
  });
});
