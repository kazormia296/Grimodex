import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextTreeNodeMutationTimestamp,
  publishTreeNodeMutation,
  resetTreeNodeMutationRegistryForTests,
  subscribeTreeNodeMutations,
  type TreeNodeMutation,
} from "./treeNodeMutationRegistry";

afterEach(() => {
  resetTreeNodeMutationRegistryForTests();
  vi.useRealTimers();
});

describe("treeNodeMutationRegistry", () => {
  it("同一millisecondでもrenderer内のtree row tokenを単調増加させる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));

    expect(nextTreeNodeMutationTimestamp()).toBe("2100-01-01T00:00:00.000Z");
    expect(nextTreeNodeMutationTimestamp()).toBe("2100-01-01T00:00:00.001Z");
  });

  it("replay在庫を最新workspace generationだけに限定する", () => {
    const mutation = (
      workspaceOpenRevision: number,
      nodeId: string,
    ): TreeNodeMutation => ({
      workspacePath: "/workspace",
      workspaceOpenRevision,
      projectId: "project",
      nodeId,
      updatedAt: `2024-01-01T00:00:0${workspaceOpenRevision}.000Z`,
    });
    publishTreeNodeMutation(mutation(1, "old-scene"));
    publishTreeNodeMutation(mutation(2, "new-scene"));

    const replayed: TreeNodeMutation[] = [];
    const unsubscribe = subscribeTreeNodeMutations(
      (value) => replayed.push(value),
      { replayCurrent: true },
    );
    unsubscribe();

    expect(replayed).toEqual([mutation(2, "new-scene")]);
  });

  it("native/DB由来のauthoritative tokenより後の時刻を次のJS writeへ付ける", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
    publishTreeNodeMutation({
      workspacePath: "/workspace",
      workspaceOpenRevision: 1,
      projectId: "project",
      nodeId: "scene",
      updatedAt: "2100-01-01T00:00:00.000Z",
    });

    expect(nextTreeNodeMutationTimestamp()).toBe("2100-01-01T00:00:00.001Z");
  });

  it("SQLite legacy UTC tokenをhostのlocal timezoneとして解釈しない", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
      publishTreeNodeMutation({
        workspacePath: "/workspace",
        workspaceOpenRevision: 1,
        projectId: "project",
        nodeId: "scene",
        updatedAt: "2100-01-01 00:00:00",
      });

      expect(nextTreeNodeMutationTimestamp()).toBe("2100-01-01T00:00:00.001Z");
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimezone;
      }
    }
  });

  it("offset付き高精度ISO tokenの絶対時刻を維持する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-12-31T22:00:00.123Z"));
    publishTreeNodeMutation({
      workspacePath: "/workspace",
      workspaceOpenRevision: 1,
      projectId: "project",
      nodeId: "scene",
      updatedAt: "2100-01-01T00:00:00.123456+02:00",
    });

    expect(nextTreeNodeMutationTimestamp()).toBe("2099-12-31T22:00:00.124Z");
  });
});
