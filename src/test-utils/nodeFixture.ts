import type { TreeNodeData } from "@/features/tree/treeStore";

/**
 * テスト用 TreeNodeData ファクトリ。
 * 必須フィールドのデフォルト値を埋めて返す。
 */
export function makeNodeData(
  overrides: Partial<TreeNodeData> & { id: string },
): TreeNodeData {
  return {
    projectId: "proj-test",
    parentId: null,
    nodeType: "scene",
    title: overrides.id,
    synopsis: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}
