import { describe, it, expect } from "vitest";
import { migrateKouetsuStore, useKouetsuStore } from "./kouetsuStore";

describe("kouetsuStore persist migration (v0 → v1)", () => {
  it("editorial タブは issues へ写像される", () => {
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
    expect(migrated.projectGroupBy).toBe("codex");
  });
  it("current → {type:'scene'} / open", () => {
    const m = migrateKouetsuStore(
      {
        activeTab: "issues",
        activeIssuesScope: "current",
        activeEditorialScope: "current",
        projectGroupBy: "scene",
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
        projectGroupBy: "scene",
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
        projectGroupBy: "scene",
      },
      0,
    );
    expect(m.scope).toEqual({ type: "scene" });
    expect(m.statusFilter).toBe("dismissed");
  });
  it("v1 以降はそのまま返す", () => {
    const v1 = {
      activeTab: "blocker",
      scope: { type: "project" },
      statusFilter: "open",
      projectGroupBy: "scene",
    };
    expect(migrateKouetsuStore(v1, 1)).toEqual(v1);
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
