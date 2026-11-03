import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  apply: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("./applyScopeDefault", () => ({ applyScopeDefaultToScenes: h.apply }));
vi.mock("sonner", () => ({
  toast: { success: h.success, warning: h.warning, error: h.error },
}));
vi.mock("@/lib/i18n", () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspacePath: "/workspace" }),
  },
}));

import { applyScopeDefaultAfterImport } from "./importApply";

describe("applyScopeDefaultAfterImport（SDEF/1 R14、A7）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing while the check is OFF: the imported Scenes stay unknown", async () => {
    await expect(
      applyScopeDefaultAfterImport(false, ["s1", "s2"]),
    ).resolves.toBeNull();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
  });

  it("loops the imported unknown Scenes when ON and shows a partial result", async () => {
    h.apply.mockResolvedValue({
      status: "done",
      applied: 1,
      skipped: 0,
      failed: 1,
    });
    await applyScopeDefaultAfterImport(true, ["s1", "s2"]);
    expect(h.apply).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      projectId: "project-1",
      sceneIds: ["s1", "s2"],
      target: "unknown",
    });
    expect(h.warning).toHaveBeenCalledWith(
      'settings.project.sceneScopeApplyResult:{"applied":1,"failed":1}',
    );
  });
});
