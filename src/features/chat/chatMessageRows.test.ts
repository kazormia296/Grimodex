import { describe, expect, it } from "vitest";
import {
  isBlankAssistantRow,
  regenerationSourceUser,
  visibleChatRows,
} from "./chatMessageRows";

type Row = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: string | null;
};
const row = (
  id: string,
  role: Row["role"],
  content: string,
  metadata?: Record<string, unknown>,
): Row => ({
  id,
  role,
  content,
  ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
});

describe("regenerationSourceUser", () => {
  it("returns the user directly before the assistant", () => {
    const rows = [row("u1", "user", "q"), row("a1", "assistant", "r")];
    expect(regenerationSourceUser(rows, "a1")?.id).toBe("u1");
  });

  it("returns null when the previous row is an assistant (left by a failed turn)", () => {
    const rows = [
      row("u1", "user", "q1"),
      row("a1", "assistant", "r1"),
      row("left", "assistant", "partial", { runtime_error: "down" }),
    ];
    expect(regenerationSourceUser(rows, "left")).toBeNull();
    expect(regenerationSourceUser(rows, "a1")?.id).toBe("u1");
  });

  it("skips system rows and summary markers but not other assistants", () => {
    const rows = [
      row("u1", "user", "q"),
      row("sys", "system", "s"),
      row("sum", "assistant", "要約", { summary_id: "1" }),
      row("a1", "assistant", "r"),
    ];
    expect(regenerationSourceUser(rows, "a1")?.id).toBe("u1");
  });

  it("returns null for an unknown id or the first row", () => {
    const rows = [row("a1", "assistant", "r")];
    expect(regenerationSourceUser(rows, "a1")).toBeNull();
    expect(regenerationSourceUser(rows, "nope")).toBeNull();
  });
});

describe("isBlankAssistantRow / visibleChatRows", () => {
  it("treats an empty assistant row with nothing to display as blank", () => {
    expect(isBlankAssistantRow(row("a", "assistant", ""))).toBe(true);
    expect(isBlankAssistantRow(row("a", "assistant", "  \n"))).toBe(true);
    expect(
      isBlankAssistantRow(row("a", "assistant", "", { stopped: true })),
    ).toBe(true);
    expect(
      isBlankAssistantRow(row("a", "assistant", "", { tool_calls: [] })),
    ).toBe(true);
  });

  it("does not treat a row with text, tool calls, thinking, or a summary marker as blank", () => {
    expect(isBlankAssistantRow(row("a", "assistant", "text"))).toBe(false);
    expect(isBlankAssistantRow(row("u", "user", ""))).toBe(false);
    expect(
      isBlankAssistantRow(row("a", "assistant", "", { tool_calls: [{}] })),
    ).toBe(false);
    expect(
      isBlankAssistantRow(
        row("a", "assistant", "", { thinking_blocks: [{ thinking: "t" }] }),
      ),
    ).toBe(false);
    expect(
      isBlankAssistantRow(row("a", "assistant", "", { summary_id: "1" })),
    ).toBe(false);
  });

  it("hides blank rows and system rows from the list but keeps a trailing one while streaming", () => {
    const rows = [
      row("s", "system", "sys"),
      row("u1", "user", "q"),
      row("blank", "assistant", ""),
      row("u2", "user", "q2"),
      row("last", "assistant", ""),
    ];
    expect(visibleChatRows(rows, false).map((r) => r.id)).toEqual(["u1", "u2"]);
    expect(visibleChatRows(rows, true).map((r) => r.id)).toEqual([
      "u1",
      "u2",
      "last",
    ]);
  });
});
