import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  activeWorkspacePath: "/workspace-a",
  workspaceSwitchInProgress: false,
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => workspace,
  },
}));

import {
  aiAuditContextForOperation,
  assertAiOperationAuthorityCurrent,
  captureAiOperationAuthority,
} from "./projectScope";

describe("AI operation authority", () => {
  beforeEach(() => {
    workspace.activeWorkspacePath = "/workspace-a";
    workspace.workspaceSwitchInProgress = false;
  });

  it("keeps the captured project and workspace across deferred work", () => {
    const authority = captureAiOperationAuthority("project-a", "scene-a");

    workspace.activeWorkspacePath = "/workspace-b";

    expect(aiAuditContextForOperation(authority, "beat_generation")).toEqual(
      expect.objectContaining({
        projectId: "project-a",
        expectedWorkspacePath: "/workspace-a",
        operationId: authority.operationId,
        metadata: { operationScopeId: "scene-a" },
      }),
    );
    expect(() =>
      assertAiOperationAuthorityCurrent(authority, "project-a"),
    ).toThrow(/authority changed/);
  });

  it("rejects a project replacement even when the workspace path is unchanged", () => {
    const authority = captureAiOperationAuthority("project-a", "scene-a");

    expect(() =>
      assertAiOperationAuthorityCurrent(authority, "project-b"),
    ).toThrow(/authority changed/);
  });
});
