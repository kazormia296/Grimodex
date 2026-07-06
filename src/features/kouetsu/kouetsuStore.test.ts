import { describe, it, expect } from "vitest";
import {
  migrateKouetsuStore,
  resolveKouetsuScope,
  useKouetsuStore,
  type KouetsuScope,
} from "./kouetsuStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

/** テスト用の最小ノード（resolveKouetsuScope は id / nodeType のみ参照）。 */
function node(id: string, nodeType: "folder" | "scene"): TreeNodeData {
  return { id, nodeType } as unknown as TreeNodeData;
}

describe("kouetsuStore persist migration (v0 → v1)", () => {
  it("editorial タブは issues へ写像され、撤去済み projectGroupBy は返却に含めない", () => {
    // 旧 persist に projectGroupBy が残っていても、migrate が返さなければ
    // shallow merge で state 外の余剰キーになるだけで無害。
    const migrated = migrateKouetsuStore(
      {
        activeTab: "editorial",
        activeIssuesScope: "current",
        activeEditorialScope: "project",
        projectGroupBy: "codex",
      },
      0,
    );
    expect(migrated.activeTab).toBe("issues");
    expect(migrated).not.toHaveProperty("projectGroupBy");
  });
  it("current → {type:'scene'} / open", () => {
    const m = migrateKouetsuStore(
      {
        activeTab: "issues",
        activeIssuesScope: "current",
        activeEditorialScope: "current",
      },
      0,
    );
    expect(m.scope).toEqual({ type: "scene" });
    expect(m.statusFilter).toBe("open");
  });
  it("project → {type:'project'}", () => {
    const m = migrateKouetsuStore(
      {
        activeTab: "comments",
        activeIssuesScope: "project",
        activeEditorialScope: "current",
      },
      0,
    );
    expect(m.scope).toEqual({ type: "project" });
  });
  it("ignored → {type:'scene'} + statusFilter='dismissed'", () => {
    const m = migrateKouetsuStore(
      {
        activeTab: "issues",
        activeIssuesScope: "ignored",
        activeEditorialScope: "current",
      },
      0,
    );
    expect(m.scope).toEqual({ type: "scene" });
    expect(m.statusFilter).toBe("dismissed");
  });
  it("v1 以降はそのまま返す（撤去済み projectGroupBy が残っていても素通し = 無害）", () => {
    const v1 = {
      activeTab: "blocker",
      scope: { type: "project" },
      statusFilter: "open",
      projectGroupBy: "scene",
    };
    expect(migrateKouetsuStore(v1, 1)).toEqual(v1);
  });
});

describe("resolveKouetsuScope", () => {
  const nodes = [node("f1", "folder"), node("s1", "scene")];

  it("folder anchor が実在するときは folder のまま素通しする", () => {
    const scope: KouetsuScope = { type: "folder", anchorId: "f1" };
    // 参照ごと不変（consumer 側 useMemo の deps 安定性のため）。
    expect(resolveKouetsuScope(scope, nodes)).toBe(scope);
  });

  it("folder anchor が現ツリーに無いときは project へ倒す", () => {
    const scope: KouetsuScope = { type: "folder", anchorId: "ghost" };
    expect(resolveKouetsuScope(scope, nodes)).toEqual({ type: "project" });
  });

  it("id は在るが folder ではない anchor も project へ倒す", () => {
    const scope: KouetsuScope = { type: "folder", anchorId: "s1" };
    expect(resolveKouetsuScope(scope, nodes)).toEqual({ type: "project" });
  });

  it("scene / project スコープはそのまま素通しする", () => {
    const scene: KouetsuScope = { type: "scene" };
    const project: KouetsuScope = { type: "project" };
    expect(resolveKouetsuScope(scene, nodes)).toBe(scene);
    expect(resolveKouetsuScope(project, nodes)).toBe(project);
  });
});

describe("kouetsuStore actions", () => {
  it("setScope / setStatusFilter が反映される", () => {
    useKouetsuStore.getState().setScope({ type: "folder", anchorId: "f1" });
    expect(useKouetsuStore.getState().scope).toEqual({
      type: "folder",
      anchorId: "f1",
    });
    useKouetsuStore.getState().setStatusFilter("dismissed");
    expect(useKouetsuStore.getState().statusFilter).toBe("dismissed");
  });
});
