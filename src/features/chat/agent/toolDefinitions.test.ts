import { describe, it, expect } from "vitest";
import {
  getDeterministicAgentTools,
  snapshotAgentTools,
} from "./toolDefinitions";

describe("toolDefinitions", () => {
  it("sorts tools by name deterministically", () => {
    const tools = getDeterministicAgentTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("snapshotAgentTools returns deep clone independent of source", () => {
    const snap = snapshotAgentTools();
    snap[0]!.description = "mutated";
    const again = snapshotAgentTools();
    expect(again[0]!.description).not.toBe("mutated");
  });

  it("preserves ask_user's nested questions[] schema after sort + clone", () => {
    const askUser = snapshotAgentTools().find((t) => t.name === "ask_user");
    expect(askUser).toBeDefined();
    const questions = askUser!.inputSchema.properties.questions;
    expect(questions.type).toBe("array");
    const itemProps = questions.items?.properties;
    expect(itemProps).toBeDefined();
    expect(itemProps!.question.type).toBe("string");
    expect(itemProps!.kind.enum).toEqual(["single", "multi", "text"]);
    expect(itemProps!.options.items?.type).toBe("string");
    expect(questions.items?.required).toEqual(["question", "kind"]);
  });
});
