import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_AGENT_IR_QUERY_UTF16_MAX } from "@/../electron/shared/chatAgentIrWire";
import { SEARCH_EVENTS_DESCRIPTION as SEARCH_EVENTS_TODAY } from "@/../electron/shared/agentReadToolDefinitions";
import { CHAT_IR_CLASS_NOTE } from "./chatIrStatusText";

/**
 * The `search_events` description while the chat IR route is open or closed
 * (S1-B PR-B2, DR-CHATIR-S1-37). The product's constant is `false`; the open
 * case replaces the constant with `vi.doMock` and loads the module again.
 */

type Definitions = typeof import("./toolDefinitions");

async function load(enabled: boolean): Promise<Definitions> {
  vi.resetModules();
  vi.doMock("./chatAgentIrAvailability", () => ({
    CHAT_AGENT_IR_ENABLED: enabled,
  }));
  return import("./toolDefinitions");
}

function descriptionOf(
  tools: ReadonlyArray<{ name: string; description: string }>,
): string {
  return tools.find((tool) => tool.name === "search_events")!.description;
}

afterEach(() => {
  vi.doUnmock("./chatAgentIrAvailability");
  vi.resetModules();
});

describe("search_events description and the chat IR constant", () => {
  it("keeps the product's constant closed", async () => {
    const real = await vi.importActual<
      typeof import("./chatAgentIrAvailability")
    >("./chatAgentIrAvailability");
    expect(real.CHAT_AGENT_IR_ENABLED).toBe(false);
  });

  it("is today's text while the constant is false, everywhere it is read", async () => {
    const defs = await load(false);
    expect(descriptionOf(defs.snapshotAgentTools())).toBe(SEARCH_EVENTS_TODAY);
    expect(descriptionOf(defs.AGENT_TOOLS)).toBe(SEARCH_EVENTS_TODAY);
    expect(descriptionOf(defs.getResearchSubagentTools())).toBe(
      SEARCH_EVENTS_TODAY,
    );
    expect(JSON.stringify(defs.snapshotAgentTools())).not.toContain(
      "chronicleIr",
    );
  });

  it("adds the reading of `chronicleIr` after today's text while the constant is true", async () => {
    const defs = await load(true);
    const description = descriptionOf(defs.snapshotAgentTools());
    expect(description.startsWith(SEARCH_EVENTS_TODAY)).toBe(true);
    expect(description).toContain("chronicleIr");
    for (const name of [
      "answered",
      "none",
      "transient",
      "unavailable",
      "context",
      "query",
      "internal",
    ]) {
      expect(description, name).toContain(name);
    }
    expect(description).toContain("not evidence that nothing exists");
    expect(description).toContain(
      `${CHAT_AGENT_IR_QUERY_UTF16_MAX} characters`,
    );
    // The class names match the table the notes come from.
    expect(Object.keys(CHAT_IR_CLASS_NOTE).sort()).toEqual(
      [
        "answered",
        "none",
        "transient",
        "unavailable",
        "context",
        "query",
        "internal",
      ].sort(),
    );
  });

  it("does not say who approved the summaries (D3 is asked before the route opens)", async () => {
    const description = descriptionOf((await load(true)).snapshotAgentTools());
    expect(description).not.toMatch(/approv|human-approved|review/iu);
  });

  it("changes nothing but that description, and not the input schema", async () => {
    const closed = (await load(false)).snapshotAgentTools();
    const open = (await load(true)).snapshotAgentTools();
    expect(open.map((tool) => tool.name)).toEqual(
      closed.map((tool) => tool.name),
    );
    for (const [index, tool] of open.entries()) {
      const before = closed[index]!;
      if (tool.name === "search_events") {
        expect(tool.inputSchema).toEqual(before.inputSchema);
        expect(tool.description).not.toBe(before.description);
      } else {
        expect(tool).toEqual(before);
      }
    }
  });

  it("keeps the research sub-agent's definition free of the reading, in both modes", async () => {
    for (const enabled of [false, true]) {
      const defs = await load(enabled);
      const subagent = defs.getResearchSubagentTools();
      expect(descriptionOf(subagent)).toBe(SEARCH_EVENTS_TODAY);
      expect(JSON.stringify(subagent)).not.toContain("chronicleIr");
      // The main agent's list is not touched by the sub-agent's.
      expect(descriptionOf(defs.AGENT_TOOLS).includes("chronicleIr")).toBe(
        enabled,
      );
    }
  });
});
