import { describe, it, expect } from "vitest";
import { CHAT_COMMANDS, filterChatCommands } from "./chatCommands";

describe("CHAT_COMMANDS", () => {
  it("必要なコマンドがすべて定義されている", () => {
    const ids = CHAT_COMMANDS.map((c) => c.id);
    expect(ids).toContain("continue");
    expect(ids).toContain("describe");
    expect(ids).toContain("dialogue");
    expect(ids).toContain("summarize");
    expect(ids).toContain("brainstorm");
    expect(ids).toContain("rewrite");
    expect(ids).toContain("translate");
  });

  it("各コマンドに label と description が存在する", () => {
    for (const cmd of CHAT_COMMANDS) {
      expect(cmd.label).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it("needsArg=true のコマンドに argPlaceholder がある", () => {
    const withArg = CHAT_COMMANDS.filter((c) => c.needsArg);
    for (const cmd of withArg) {
      expect(cmd.argPlaceholder).toBeTruthy();
    }
  });
});

describe("filterChatCommands", () => {
  it("空クエリですべてのコマンドを返す", () => {
    const result = filterChatCommands("");
    expect(result.length).toBe(CHAT_COMMANDS.length);
  });

  it("クエリにマッチするコマンドだけ返す", () => {
    const result = filterChatCommands("con");
    expect(result.some((c) => c.id === "continue")).toBe(true);
    expect(
      result.every(
        (c) => c.label.toLowerCase().includes("con") || c.id.includes("con"),
      ),
    ).toBe(true);
  });

  it("大文字小文字を区別しない", () => {
    const lower = filterChatCommands("sum");
    const upper = filterChatCommands("SUM");
    expect(lower.map((c) => c.id)).toEqual(upper.map((c) => c.id));
  });

  it("マッチしないクエリは空配列を返す", () => {
    const result = filterChatCommands("zzzznonexistent");
    expect(result).toHaveLength(0);
  });
});
