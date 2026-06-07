import { describe, it, expect } from "vitest";
import { buildMcpConfigJson } from "./mcpConfig";

describe("buildMcpConfigJson", () => {
  it("emits args in order: mcp, --workspace, --project, --readonly", () => {
    const json = buildMcpConfigJson({
      command: "/Applications/Grimodex.app/Contents/MacOS/Grimodex",
      workspace: "/Users/me/novel",
      projectId: "proj-123",
      readonly: true,
    });
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.grimodex.command).toBe(
      "/Applications/Grimodex.app/Contents/MacOS/Grimodex",
    );
    expect(parsed.mcpServers.grimodex.args).toEqual([
      "mcp",
      "--workspace",
      "/Users/me/novel",
      "--project",
      "proj-123",
      "--readonly",
    ]);
    expect(parsed.mcpServers.grimodex.env).toEqual({});
  });

  it("defaults readonly to true when omitted", () => {
    const parsed = JSON.parse(
      buildMcpConfigJson({ command: "grimodex", workspace: "/ws" }),
    );
    expect(parsed.mcpServers.grimodex.args).toContain("--readonly");
  });

  it("omits --readonly when readonly is false", () => {
    const parsed = JSON.parse(
      buildMcpConfigJson({
        command: "grimodex",
        workspace: "/ws",
        readonly: false,
      }),
    );
    expect(parsed.mcpServers.grimodex.args).not.toContain("--readonly");
  });

  it("omits --project when projectId is falsy", () => {
    for (const projectId of [undefined, null, ""]) {
      const parsed = JSON.parse(
        buildMcpConfigJson({
          command: "grimodex",
          workspace: "/ws",
          projectId,
        }),
      );
      expect(parsed.mcpServers.grimodex.args).not.toContain("--project");
    }
  });

  it("emits --all-projects and drops --project when allProjects is set", () => {
    const parsed = JSON.parse(
      buildMcpConfigJson({
        command: "grimodex",
        workspace: "/ws",
        projectId: "proj-123",
        allProjects: true,
      }),
    );
    const args = parsed.mcpServers.grimodex.args;
    expect(args).toContain("--all-projects");
    expect(args).not.toContain("--project");
    expect(args).toContain("--readonly");
  });
});
