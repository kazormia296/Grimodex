// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScopeTreePickerList, flattenTree } from "./ScopeTreePicker";
import { useTreeStore, type TreeNodeData } from "./treeStore";

const nodes: TreeNodeData[] = [
  {
    id: "act1",
    parentId: null,
    nodeType: "folder",
    title: "第一幕",
    sortOrder: "a",
  },
  {
    id: "ch1",
    parentId: "act1",
    nodeType: "folder",
    title: "第一章",
    sortOrder: "a",
  },
  {
    id: "s1",
    parentId: "ch1",
    nodeType: "scene",
    title: "冒頭",
    sortOrder: "a",
  },
  {
    id: "s2",
    parentId: "ch1",
    nodeType: "scene",
    title: "追跡",
    sortOrder: "b",
  },
] as unknown as TreeNodeData[];

beforeEach(() => {
  useTreeStore.setState({ nodes });
});

describe("flattenTree", () => {
  it("DFS 順に depth 付きで平坦化する", () => {
    const rows = flattenTree(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(["act1", "ch1", "s1", "s2"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  });
});

describe("ScopeTreePickerList", () => {
  it("project 行 + folder/scene 行を出し、クリックで各 onPick* が飛ぶ", () => {
    const onScene = vi.fn();
    const onFolder = vi.fn();
    const onProject = vi.fn();
    render(
      <ScopeTreePickerList
        selection={{ type: "project" }}
        onPickScene={onScene}
        onPickFolder={onFolder}
        onPickProject={onProject}
      />,
    );
    fireEvent.click(screen.getByText("第一章"));
    expect(onFolder).toHaveBeenCalledWith("ch1");
    fireEvent.click(screen.getByText("冒頭"));
    expect(onScene).toHaveBeenCalledWith("s1");
    // 実際の ja.json 訳は "プロジェクト全体"（brief の "プロジェクト" は簡略化）。
    // 表示文字列を Chat と byte-identical に保つ制約のため実訳に合わせる。
    fireEvent.click(screen.getByText("プロジェクト全体"));
    expect(onProject).toHaveBeenCalled();
  });
  it("selection の行に選択スタイルが付く", () => {
    render(
      <ScopeTreePickerList
        selection={{ type: "folder", anchorId: "ch1" }}
        onPickScene={() => {}}
        onPickFolder={() => {}}
        onPickProject={() => {}}
      />,
    );
    expect(screen.getByText("第一章").closest("button")?.className).toContain(
      "bg-accent",
    );
  });
});
