import { describe, it, expect } from "vitest";
import { selectStoryContext } from "./storyContext";

type N = {
  id: string;
  parentId: string | null;
  nodeType: "folder" | "scene" | "note";
  synopsis: string | null;
};

const nodes: N[] = [
  { id: "ch1", parentId: null, nodeType: "folder", synopsis: "第1章: 出会い" },
  {
    id: "s1",
    parentId: "ch1",
    nodeType: "scene",
    synopsis: "二人が初めて会う",
  },
  { id: "s2", parentId: "ch1", nodeType: "scene", synopsis: null },
  {
    id: "root-scene",
    parentId: null,
    nodeType: "scene",
    synopsis: "プロローグ",
  },
  {
    id: "note-parent",
    parentId: null,
    nodeType: "note",
    synopsis: "ノート概要",
  },
  {
    id: "nested-scene",
    parentId: "note-parent",
    nodeType: "scene",
    synopsis: "x",
  },
  { id: "ch-empty", parentId: null, nodeType: "folder", synopsis: "   " },
  {
    id: "s-empty-parent",
    parentId: "ch-empty",
    nodeType: "scene",
    synopsis: "本文あり",
  },
];

describe("selectStoryContext", () => {
  it("シーン synopsis と親フォルダ synopsis(=章 outline) を返す", () => {
    expect(selectStoryContext(nodes, "s1")).toEqual({
      synopsis: "二人が初めて会う",
      outline: "第1章: 出会い",
    });
  });

  it("シーン synopsis が無ければ synopsis を省略 (outline は残る)", () => {
    expect(selectStoryContext(nodes, "s2")).toEqual({
      outline: "第1章: 出会い",
    });
  });

  it("親が無いシーンは outline を省略", () => {
    expect(selectStoryContext(nodes, "root-scene")).toEqual({
      synopsis: "プロローグ",
    });
  });

  it("親が folder でない (note) 場合は outline を省略 (直近親のみ・遡上しない)", () => {
    expect(selectStoryContext(nodes, "nested-scene")).toEqual({
      synopsis: "x",
    });
  });

  it("親フォルダ synopsis が空白のみなら outline を省略", () => {
    expect(selectStoryContext(nodes, "s-empty-parent")).toEqual({
      synopsis: "本文あり",
    });
  });

  it("存在しない sceneId は空オブジェクト", () => {
    expect(selectStoryContext(nodes, "nope")).toEqual({});
  });

  it("synopsis/outline とも空なら空オブジェクト (キャッシュ不変を保証)", () => {
    const ns: N[] = [
      { id: "f", parentId: null, nodeType: "folder", synopsis: null },
      { id: "sc", parentId: "f", nodeType: "scene", synopsis: "  " },
    ];
    expect(selectStoryContext(ns, "sc")).toEqual({});
  });
});
