import { describe, it, expect } from "vitest";
import {
  getDeterministicAgentTools,
  getResearchSubagentTools,
  snapshotAgentTools,
  READ_ONLY_TOOL_NAMES,
  RESEARCH_SUBAGENT_TOOL,
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

  it("exposes run_research to the main agent with a required task param", () => {
    const tool = getDeterministicAgentTools().find(
      (t) => t.name === RESEARCH_SUBAGENT_TOOL,
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties.task?.type).toBe("string");
    expect(tool!.inputSchema.required).toEqual(["task"]);
  });
});

describe("getResearchSubagentTools — read-only subset (depth=1)", () => {
  it("contains exactly the read-only tool names", () => {
    const names = getResearchSubagentTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort());
  });

  it("excludes run_research itself so a sub-agent cannot recurse", () => {
    const names = getResearchSubagentTools().map((t) => t.name);
    expect(names).not.toContain(RESEARCH_SUBAGENT_TOOL);
  });

  it("excludes ask_user and all write tools", () => {
    const names = new Set(getResearchSubagentTools().map((t) => t.name));
    for (const blocked of [
      "ask_user",
      "create_codex_entry",
      "update_codex_entry",
      "create_foreshadow",
      "update_foreshadow",
      "create_snippet",
      "apply_ai_tree_plan",
      "propose_scene_body",
    ]) {
      expect(names.has(blocked)).toBe(false);
    }
  });

  it("returns a deep clone independent of the canonical tools", () => {
    const sub = getResearchSubagentTools();
    sub[0]!.description = "mutated";
    expect(getResearchSubagentTools()[0]!.description).not.toBe("mutated");
  });
});
