import { describe, it, expect } from "vitest";
import {
  AGENT_TOOLS,
  getDeterministicAgentTools,
  getResearchSubagentTools,
  snapshotAgentTools,
  READ_ONLY_TOOL_NAMES,
  RESEARCH_SUBAGENT_TOOL,
} from "./toolDefinitions";
import {
  AGENT_TOOL_MANIFEST,
  HERMES_ALLOWED_TOOL_NAMES,
  MANIFEST_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES as MANIFEST_READ_ONLY_TOOL_NAMES,
} from "./toolManifest";

describe("toolDefinitions", () => {
  it("retires secret from event and foreshadow write tools while keeping disclosure metadata", () => {
    const tools = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));
    const disclosurePrefix =
      "Optional scene id where readers learn of this event; chronicle read tools mark it so earlier scenes aren't written as if readers knew. It does not hide the event.";
    const disclosureDescriptions: Record<string, string> = {
      create_event: `${disclosurePrefix} Omit or pass empty for none.`,
      update_event: `${disclosurePrefix} Omit to leave unchanged; pass an empty string to clear.`,
    };

    for (const name of ["create_event", "update_event"]) {
      const tool = tools.get(name)!;
      expect(tool.inputSchema.properties).not.toHaveProperty("secret");
      const description =
        tool.inputSchema.properties.revealSceneId?.description ?? "";
      expect(description).toBe(disclosureDescriptions[name]);
      expect(
        description.replace("does not hide the event", "").toLowerCase(),
      ).not.toMatch(/\b(?:hide|invisible)\b/u);
    }

    const createForeshadow = tools.get("create_foreshadow")!;
    const updateForeshadow = tools.get("update_foreshadow")!;
    expect(createForeshadow.inputSchema.properties).not.toHaveProperty(
      "secret",
    );
    expect(updateForeshadow.inputSchema.properties).not.toHaveProperty(
      "secret",
    );
    expect(createForeshadow.description).toBe(
      "Create a new foreshadowing (plant/payoff) item. Requires knowledgeWrite policy.",
    );
    expect(createForeshadow.description).not.toContain(
      "hidden from list_open_foreshadows",
    );
  });

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

  it("keeps the tool definitions and security manifest in exact parity", () => {
    expect([...new Set(AGENT_TOOLS.map((tool) => tool.name))].sort()).toEqual(
      [...MANIFEST_TOOL_NAMES].sort(),
    );
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(
      [...MANIFEST_READ_ONLY_TOOL_NAMES].sort(),
    );
    expect([...HERMES_ALLOWED_TOOL_NAMES].sort()).toEqual(
      [...MANIFEST_TOOL_NAMES]
        .filter((name) => !MUTATING_TOOL_NAMES.has(name))
        .sort(),
    );
    expect(
      [...MANIFEST_TOOL_NAMES]
        .filter((name) => MUTATING_TOOL_NAMES.has(name))
        .sort(),
    ).toEqual(
      [...MANIFEST_TOOL_NAMES]
        .filter((name) => !HERMES_ALLOWED_TOOL_NAMES.includes(name))
        .sort(),
    );
  });

  it("declares write-tool bodies as Markdown and aliases as string arrays", () => {
    for (const name of ["create_codex_entry", "update_codex_entry"]) {
      const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties.content).toMatchObject({
        type: "string",
        description: expect.stringContaining("Markdown"),
      });
      expect(tool!.inputSchema.properties.aliases).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
    }

    const snippet = AGENT_TOOLS.find(
      (candidate) => candidate.name === "create_snippet",
    );
    expect(snippet).toBeDefined();
    expect(snippet!.inputSchema.properties.content).toMatchObject({
      type: "string",
      description: expect.stringContaining("Markdown"),
    });
  });
});

const APP_HELP_TOOL_NAMES = [
  "get_app_help_index",
  "get_app_help",
  "get_ui_state",
] as const;

describe("app help read tools", () => {
  it("manifest では read・policy なし・全 channel・確認なし（他の read のツールと同じ）", () => {
    for (const name of APP_HELP_TOOL_NAMES) {
      expect(AGENT_TOOL_MANIFEST.find((tool) => tool.name === name)).toEqual({
        name,
        capability: "read",
        requiredPolicy: null,
        allowedChannels: ["agent", "hermes", "native"],
        requiresUserConfirmation: false,
      });
    }
  });

  it("Hermes／native の low-trust parser と research sub-agent に、read のツールとして届く", () => {
    const research = getResearchSubagentTools().map((t) => t.name);
    for (const name of APP_HELP_TOOL_NAMES) {
      expect(HERMES_ALLOWED_TOOL_NAMES).toContain(name);
      expect(READ_ONLY_TOOL_NAMES).toContain(name);
      expect(MUTATING_TOOL_NAMES.has(name)).toBe(false);
      expect(research).toContain(name);
    }
  });

  it("入力 schema が設計どおり（index は query／kind、help は id 必須、ui_state は引数なし）", () => {
    const tools = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));
    const index = tools.get("get_app_help_index")!.inputSchema;
    expect(Object.keys(index.properties).sort()).toEqual(["kind", "query"]);
    expect(index.required).toEqual([]);
    expect(index.properties.kind?.enum).toEqual([
      "command",
      "panel",
      "settingsCategory",
      "topic",
    ]);
    expect(tools.get("get_app_help")!.inputSchema.required).toEqual(["id"]);
    expect(tools.get("get_ui_state")!.inputSchema.properties).toEqual({});
  });

  it("ツールの説明は短く、設定の値・本文を返さないと書いている", () => {
    for (const name of APP_HELP_TOOL_NAMES) {
      const tool = AGENT_TOOLS.find((candidate) => candidate.name === name)!;
      expect(tool.description.length).toBeLessThan(500);
    }
    const help = AGENT_TOOLS.find((t) => t.name === "get_app_help")!;
    expect(help.description).toContain("Never returns setting values");
    const state = AGENT_TOOLS.find((t) => t.name === "get_ui_state")!;
    expect(state.description).toContain("Never returns scene text");
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
