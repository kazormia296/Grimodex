import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/tree/api", () => ({
  listNodes: vi.fn(async () => []),
  createNode: vi.fn(async (data: Record<string, unknown>) => ({ ...data })),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: vi.fn(() => ({
      loadTree: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock("@/lib/i18n", () => ({
  default: {
    t: vi.fn((key: string, opts?: { defaultValue?: string }) => {
      // Simulate i18n: structural-role descriptions live on folder stages.
      // Pattern A (threeAct): {stage}.synopsis on folder, {stage}Scene.name on scene.
      const map: Record<string, string> = {
        "grid.structureTemplates.threeAct.stages.act1.name": "第1幕：設定",
        "grid.structureTemplates.threeAct.stages.act1.synopsis":
          "act1 の structural role",
        "grid.structureTemplates.threeAct.stages.act1Scene.name": "導入",
        // Pattern B (saveTheCat): act folder has only name; beat folder has
        // name+synopsis; placeholder scene uses generic title.
        "grid.structureTemplates.saveTheCat.stages.act1.name": "第1幕",
        "grid.structureTemplates.saveTheCat.stages.openingImage.name":
          "冒頭イメージ",
        "grid.structureTemplates.saveTheCat.stages.openingImage.synopsis":
          "openingImage の beat 役割",
        // Pattern C (storyCircle): each stage becomes folder with synopsis.
        "grid.structureTemplates.storyCircle.stages.youInZone.name": "安住",
        "grid.structureTemplates.storyCircle.stages.youInZone.synopsis":
          "youInZone の役割",
        // Shared placeholder scene title.
        "grid.structureTemplates.placeholderScene": "シーン",
      };
      return map[key] ?? opts?.defaultValue ?? key;
    }),
  },
}));

import * as treeApi from "@/features/tree/api";
import { applyStructureTemplate } from "../applyStructureTemplate";

const createNodeMock = vi.mocked(treeApi.createNode);

beforeEach(() => {
  createNodeMock.mockClear();
});

function createdNodes(): Array<Record<string, unknown>> {
  return createNodeMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

describe("applyStructureTemplate — synopsis 出力先 (Phase 4 後続)", () => {
  it("Pattern A (threeAct): folder.synopsis に structural role を書き込み、scene.synopsis は空", async () => {
    await applyStructureTemplate("p1", "threeAct", null);

    const nodes = createdNodes();
    const act1Folder = nodes.find(
      (n) => n.nodeType === "folder" && n.title === "第1幕：設定",
    );
    expect(act1Folder).toBeDefined();
    expect(act1Folder!.synopsis).toBe("act1 の structural role");

    const act1Scene = nodes.find(
      (n) => n.nodeType === "scene" && n.title === "導入",
    );
    expect(act1Scene).toBeDefined();
    expect(act1Scene!.synopsis).toBeUndefined();
  });

  it("Pattern B (saveTheCat): beat が folder で wrap され、folder.synopsis に beat 役割が入る", async () => {
    await applyStructureTemplate("p1", "saveTheCat", null);

    const nodes = createdNodes();
    const beatFolder = nodes.find(
      (n) => n.nodeType === "folder" && n.title === "冒頭イメージ",
    );
    expect(beatFolder).toBeDefined();
    expect(beatFolder!.synopsis).toBe("openingImage の beat 役割");

    // beat folder の中にプレースホルダ scene が生成される
    const placeholders = nodes.filter(
      (n) =>
        n.nodeType === "scene" &&
        n.parentId === beatFolder!.id &&
        n.title === "シーン",
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]!.synopsis).toBeUndefined();

    // act folder は synopsis を持たない (i18n で未定義のため)
    const actFolder = nodes.find(
      (n) => n.nodeType === "folder" && n.title === "第1幕",
    );
    expect(actFolder).toBeDefined();
    expect(actFolder!.synopsis).toBeUndefined();
  });

  it("Pattern C (storyCircle): 各 stage が folder で wrap され、scene は placeholder", async () => {
    await applyStructureTemplate("p1", "storyCircle", null);

    const nodes = createdNodes();
    const youInZoneFolder = nodes.find(
      (n) => n.nodeType === "folder" && n.title === "安住",
    );
    expect(youInZoneFolder).toBeDefined();
    expect(youInZoneFolder!.synopsis).toBe("youInZone の役割");

    const placeholder = nodes.find(
      (n) =>
        n.nodeType === "scene" &&
        n.parentId === youInZoneFolder!.id &&
        n.title === "シーン",
    );
    expect(placeholder).toBeDefined();
    expect(placeholder!.synopsis).toBeUndefined();
  });
});
