import { describe, expect, it } from "vitest";
import { createWorkspaceOpenTransition } from "./workspaceOpenTraceIntegration";

describe("createWorkspaceOpenTransition", () => {
  it("builds the target scope while preserving the source identity", () => {
    const from = {
      workspacePath: "D:\\Novels\\Current",
      workspaceOpenRevision: 4,
      projectId: "project-current",
    };

    expect(createWorkspaceOpenTransition(from, "D:\\Novels\\Next")).toEqual({
      kind: "workspace",
      from,
      to: {
        workspacePath: "D:\\Novels\\Next",
        workspaceOpenRevision: null,
        projectId: null,
      },
    });
  });
});
