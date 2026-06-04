import { describe, it, expect } from "vitest";
import {
  parseTreePlan,
  buildOutlineContext,
  stripSynopsisIfDisabled,
} from "./generate";
import type { AiTreePlan } from "./types";
import type { TreeNodeData, NodeType } from "../treeStore";

function mkNode(p: {
  id: string;
  nodeType: NodeType;
  parentId: string | null;
  sortOrder: string;
  title?: string;
  synopsis?: string | null;
}): TreeNodeData {
  return {
    projectId: "proj-1",
    title: p.title ?? p.id,
    synopsis: p.synopsis ?? null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    sourceUri: null,
    sourceMtime: null,
    archivedAt: null,
    contextMode: null,
    aliases: null,
    excludedAliases: null,
    createdAt: "t",
    updatedAt: "t",
    ...p,
  };
}

describe("parseTreePlan", () => {
  it("parses bare JSON and stamps the kind", () => {
    const text =
      '{"ops":[{"op":"create","tempId":"tmp:a","parentRef":null,"nodeType":"scene","title":"S"}]}';
    const plan = parseTreePlan(text, "scaffold");
    expect(plan.kind).toBe("scaffold");
    expect(plan.ops).toHaveLength(1);
  });

  it("extracts JSON from a ```json fenced block", () => {
    const text =
      'ここに案です:\n```json\n{"ops":[{"op":"rename","nodeId":"x","title":"Y"}]}\n```\nどうぞ。';
    const plan = parseTreePlan(text, "reorganize");
    expect(plan.ops[0]).toMatchObject({ op: "rename", nodeId: "x" });
  });

  it("extracts JSON embedded in prose without fences", () => {
    const text = 'プラン: {"ops":[]} 以上です';
    expect(parseTreePlan(text, "scaffold").ops).toEqual([]);
  });

  it("throws when ops is missing", () => {
    expect(() => parseTreePlan('{"foo":1}', "scaffold")).toThrow();
  });

  it("throws on non-JSON output", () => {
    expect(() =>
      parseTreePlan("申し訳ありませんが生成できません", "scaffold"),
    ).toThrow();
  });
});

describe("stripSynopsisIfDisabled (bodyWrite bypass guard)", () => {
  const planWithSynopsis: AiTreePlan = {
    kind: "scaffold",
    ops: [
      {
        op: "create",
        tempId: "tmp:a",
        parentRef: null,
        nodeType: "scene",
        title: "S",
        synopsis: "AI が勝手に付けたあらすじ",
      },
      { op: "rename", nodeId: "x", title: "Y" },
    ],
  };

  it("strips AI-supplied synopsis from create ops when the toggle is OFF", () => {
    const out = stripSynopsisIfDisabled(planWithSynopsis, false);
    const create = out.ops.find((o) => o.op === "create");
    expect(create && "synopsis" in create).toBe(false);
    // 非 create op は素通り
    expect(out.ops[1]).toEqual({ op: "rename", nodeId: "x", title: "Y" });
  });

  it("keeps synopsis when the toggle is ON", () => {
    const out = stripSynopsisIfDisabled(planWithSynopsis, true);
    const create = out.ops.find((o) => o.op === "create");
    expect(create && "synopsis" in create && create.synopsis).toBe(
      "AI が勝手に付けたあらすじ",
    );
  });
});

describe("buildOutlineContext", () => {
  const nodes = [
    mkNode({
      id: "F2",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
      title: "Ch2",
    }),
    mkNode({
      id: "F1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a0",
      title: "Ch1",
    }),
    mkNode({
      id: "s1",
      nodeType: "scene",
      parentId: "F1",
      sortOrder: "a0",
      title: "S1",
      synopsis: "intro",
    }),
    mkNode({
      id: "s2",
      nodeType: "scene",
      parentId: "F1",
      sortOrder: "a1",
      title: "S2",
    }),
  ];

  it("returns DFS pre-order sorted by sortOrder with depth (whole project)", () => {
    const out = buildOutlineContext(nodes, null);
    expect(out.map((n) => n.id)).toEqual(["F1", "s1", "s2", "F2"]);
    expect(out.find((n) => n.id === "s1")?.depth).toBe(1);
    expect(out.find((n) => n.id === "F1")?.depth).toBe(0);
    expect(out.find((n) => n.id === "s1")?.synopsis).toBe("intro");
  });

  it("returns only the subtree under rootRef (excluding the root)", () => {
    const out = buildOutlineContext(nodes, "F1");
    expect(out.map((n) => n.id)).toEqual(["s1", "s2"]);
    expect(out[0].depth).toBe(0);
  });
});
