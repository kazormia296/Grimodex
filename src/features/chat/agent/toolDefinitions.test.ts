import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, TOOL_MAP } from "./toolDefinitions";

describe("AGENT_TOOLS — Phase 3 foreshadow / timeline tools", () => {
  it("list_open_foreshadows is registered with no required params", () => {
    const tool = TOOL_MAP.get("list_open_foreshadows");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual([]);
  });

  it("get_foreshadow_detail requires id", () => {
    const tool = TOOL_MAP.get("get_foreshadow_detail");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("id");
    expect(tool?.inputSchema.properties).toHaveProperty("id");
  });

  it("get_scene_timeline_neighbors requires sceneId", () => {
    const tool = TOOL_MAP.get("get_scene_timeline_neighbors");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("sceneId");
    expect(tool?.inputSchema.properties).toHaveProperty("sceneId");
  });

  it("all tool names are unique", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("each tool's required fields exist in properties", () => {
    for (const tool of AGENT_TOOLS) {
      for (const req of tool.inputSchema.required) {
        expect(tool.inputSchema.properties).toHaveProperty(req);
      }
    }
  });
});
