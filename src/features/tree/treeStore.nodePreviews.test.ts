import { describe, it, expect, beforeEach } from "vitest";
import { useTreeStore } from "./treeStore";

/**
 * Phase 4 regression gate.
 *
 * setNodePreview は nodePreviews だけを更新し、nodes[] の参照は据え置く。
 * これが崩れると、whole-array selector 29 サイトが打鍵中・autosave 中に
 * notify されて Phase 3 以前の longtask に戻る。
 */
describe("treeStore.setNodePreview — nodes[] is not mutated", () => {
  beforeEach(() => {
    useTreeStore.setState({
      nodes: [],
      scenes: [],
      activeSceneId: "",
      selectedIds: [],
      charCounts: {},
      nodePreviews: {},
    });
  });

  it("nodes[] の参照を変えずに preview だけ更新する", () => {
    useTreeStore.setState({
      nodes: [
        {
          id: "s1",
          projectId: "p",
          parentId: null,
          nodeType: "scene",
          title: "S1",
          synopsis: null,
          intent: null,
          sortOrder: "a0",
          status: null,
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          charCount: 0,
          createdAt: "x",
          updatedAt: "x",
        },
      ],
    });

    const before = useTreeStore.getState().nodes;
    useTreeStore
      .getState()
      .setNodePreview("s1", { placed: '["a"]', unplaced: null });
    const after = useTreeStore.getState().nodes;

    expect(after).toBe(before);
    expect(useTreeStore.getState().nodePreviews["s1"]).toEqual({
      placed: '["a"]',
      unplaced: null,
    });
  });

  it("同値ならば nodePreviews 自体も新参照を作らない (set skip)", () => {
    useTreeStore.setState({
      nodePreviews: { s1: { placed: '["a"]', unplaced: null } },
    });
    const before = useTreeStore.getState().nodePreviews;
    useTreeStore
      .getState()
      .setNodePreview("s1", { placed: '["a"]', unplaced: null });
    const after = useTreeStore.getState().nodePreviews;
    expect(after).toBe(before);
  });

  it("未登録 id に null/null を入れても set を skip する", () => {
    const before = useTreeStore.getState().nodePreviews;
    useTreeStore
      .getState()
      .setNodePreview("s2", { placed: null, unplaced: null });
    const after = useTreeStore.getState().nodePreviews;
    expect(after).toBe(before);
  });

  it("partial 指定 (placed のみ) は既存 unplaced を保つ", () => {
    useTreeStore.setState({
      nodePreviews: { s1: { placed: null, unplaced: '["x"]' } },
    });
    useTreeStore.getState().setNodePreview("s1", { placed: '["y"]' });
    expect(useTreeStore.getState().nodePreviews["s1"]).toEqual({
      placed: '["y"]',
      unplaced: '["x"]',
    });
  });

  it("setNodePreview は nodes セレクタの subscriber に notify しない", () => {
    let nodesNotifyCount = 0;
    const unsub = useTreeStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes) nodesNotifyCount++;
    });
    useTreeStore
      .getState()
      .setNodePreview("s1", { placed: '["a"]', unplaced: null });
    useTreeStore
      .getState()
      .setNodePreview("s1", { placed: '["b"]', unplaced: '["c"]' });
    unsub();
    expect(nodesNotifyCount).toBe(0);
  });
});
