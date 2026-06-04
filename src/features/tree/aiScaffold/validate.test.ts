import { describe, it, expect } from "vitest";
import { validateAiTreePlan } from "./validate";
import type { TreeNodeData, NodeType } from "../treeStore";
import type { AiTreePlan, AiTreeScope, AiTreeOpKind } from "./types";

function mkNode(
  p: {
    id: string;
    nodeType: NodeType;
    parentId: string | null;
    sortOrder: string;
  } & Partial<TreeNodeData>,
): TreeNodeData {
  return {
    projectId: "proj-1",
    title: p.id,
    synopsis: null,
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

function scope(
  allowedOps: AiTreeOpKind[],
  rootRef: string | null,
  editableIds: string[] = [],
): AiTreeScope {
  return { allowedOps, rootRef, editableIds: new Set(editableIds) };
}

const codes = (r: ReturnType<typeof validateAiTreePlan>) =>
  r.ok ? [] : r.errors.map((e) => e.code);

describe("validateAiTreePlan — scaffold (additive)", () => {
  it("accepts a nested scaffold under root and returns topo-ordered creates", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:scene",
          parentRef: "tmp:ch",
          nodeType: "scene",
          title: "S1",
        },
        {
          op: "create",
          tempId: "tmp:ch",
          parentRef: null,
          nodeType: "folder",
          title: "Chapter 1",
        },
      ],
    };
    const r = validateAiTreePlan(plan, [], "proj-1", scope(["create"], null));
    expect(r.ok).toBe(true);
    if (r.ok) {
      // parent (tmp:ch) must come before its child (tmp:scene)
      expect(r.orderedCreates.map((c) => c.tempId)).toEqual([
        "tmp:ch",
        "tmp:scene",
      ]);
      expect(r.tempIds.sort()).toEqual(["tmp:ch", "tmp:scene"]);
    }
  });

  it("rejects creating a scene under a scene (type rule)", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:s",
          parentRef: "tmp:p",
          nodeType: "scene",
          title: "P",
        },
        {
          op: "create",
          tempId: "tmp:p",
          parentRef: null,
          nodeType: "scene",
          title: "child",
        },
      ],
    };
    const r = validateAiTreePlan(plan, [], "proj-1", scope(["create"], null));
    expect(codes(r)).toContain("bad_parent_type");
  });
});

describe("validateAiTreePlan — reorganize / group", () => {
  const nodes = [
    mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
    mkNode({ id: "s1", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
    mkNode({ id: "s2", nodeType: "scene", parentId: "F", sortOrder: "a1" }),
  ];

  it("accepts grouping existing scenes under a new folder", () => {
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "create",
          tempId: "tmp:g",
          parentRef: "F",
          nodeType: "folder",
          title: "Group",
        },
        { op: "move", nodeId: "s1", newParentRef: "tmp:g" },
        { op: "move", nodeId: "s2", newParentRef: "tmp:g" },
      ],
    };
    const r = validateAiTreePlan(
      plan,
      nodes,
      "proj-1",
      scope(["create", "move", "rename"], "F", ["s1", "s2"]),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects moving a folder into its own descendant (cycle)", () => {
    const tree = [
      mkNode({ id: "A", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "B", nodeType: "folder", parentId: "A", sortOrder: "a0" }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [{ op: "move", nodeId: "A", newParentRef: "B" }],
    };
    const r = validateAiTreePlan(
      plan,
      tree,
      "proj-1",
      scope(["move"], null, ["A", "B"]),
    );
    expect(codes(r)).toContain("cycle");
  });

  it("rejects a create+move composite cycle", () => {
    // new folder g under s1; move s1 under g → cycle g→s1→g
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "create",
          tempId: "tmp:g",
          parentRef: "s1",
          nodeType: "folder",
          title: "G",
        },
        { op: "move", nodeId: "s1", newParentRef: "tmp:g" },
      ],
    };
    const r = validateAiTreePlan(
      plan,
      nodes,
      "proj-1",
      scope(["create", "move"], "F", ["s1", "s2"]),
    );
    expect(codes(r)).toContain("cycle");
  });
});

describe("validateAiTreePlan — scope enforcement (Codex High-1)", () => {
  const nodes = [
    mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
    mkNode({ id: "inF", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
    mkNode({
      id: "outside",
      nodeType: "scene",
      parentId: null,
      sortOrder: "a1",
    }),
  ];

  it("rejects an op kind not in allowedOps", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [{ op: "rename", nodeId: "inF", title: "x" }],
    };
    const r = validateAiTreePlan(
      plan,
      nodes,
      "proj-1",
      scope(["create"], "F", ["inF"]),
    );
    expect(codes(r)).toContain("op_not_allowed");
  });

  it("rejects moving a node outside editableIds", () => {
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [{ op: "move", nodeId: "outside", newParentRef: "F" }],
    };
    const r = validateAiTreePlan(
      plan,
      nodes,
      "proj-1",
      scope(["move"], "F", ["inF"]),
    );
    expect(codes(r)).toContain("out_of_scope");
  });

  it("rejects creating outside the rootRef subtree", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:x",
          parentRef: null,
          nodeType: "scene",
          title: "x",
        },
      ],
    };
    const r = validateAiTreePlan(plan, nodes, "proj-1", scope(["create"], "F"));
    expect(codes(r)).toContain("parent_out_of_scope");
  });
});

describe("validateAiTreePlan — afterRef strictness (Codex High-2)", () => {
  const nodes = [
    mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
    mkNode({ id: "G", nodeType: "folder", parentId: null, sortOrder: "a1" }),
    mkNode({ id: "inF", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
    mkNode({ id: "inG", nodeType: "scene", parentId: "G", sortOrder: "a0" }),
  ];

  it("rejects afterRef pointing to a sibling of a different parent", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:x",
          parentRef: "F",
          nodeType: "scene",
          title: "x",
          pos: { afterRef: "inG" }, // inG lives under G, not F
        },
      ],
    };
    const r = validateAiTreePlan(
      plan,
      nodes,
      "proj-1",
      scope(["create"], "F", ["inF"]),
    );
    expect(codes(r)).toContain("after_cross_parent");
  });

  it("rejects afterRef referencing self", () => {
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "move",
          nodeId: "inF",
          newParentRef: "F",
          pos: { afterRef: "inF" },
        },
      ],
    };
    const r = validateAiTreePlan(
      plan,
      nodes,
      "proj-1",
      scope(["move"], "F", ["inF"]),
    );
    expect(codes(r)).toContain("after_self");
  });

  it("accepts afterRef whose anchor is moved into the same new folder in this batch", () => {
    // 自然な再編: 新フォルダ G を作り、s1 を G へ移動 → s2 を afterRef:s1 で同 G へ。
    // afterRef の判定は s1 の「最終」parent(=G)を見るので after_cross_parent で落ちない。
    const tree = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "s1", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
      mkNode({ id: "s2", nodeType: "scene", parentId: "F", sortOrder: "a1" }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "create",
          tempId: "tmp:g",
          parentRef: "F",
          nodeType: "folder",
          title: "G",
        },
        { op: "move", nodeId: "s1", newParentRef: "tmp:g" },
        {
          op: "move",
          nodeId: "s2",
          newParentRef: "tmp:g",
          pos: { afterRef: "s1" },
        },
      ],
    };
    const r = validateAiTreePlan(
      plan,
      tree,
      "proj-1",
      scope(["create", "move", "rename"], "F", ["s1", "s2"]),
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateAiTreePlan — IR limits & existence (Codex Medium-4)", () => {
  it("rejects an empty title", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:x",
          parentRef: null,
          nodeType: "scene",
          title: "  ",
        },
      ],
    };
    expect(
      codes(validateAiTreePlan(plan, [], "proj-1", scope(["create"], null))),
    ).toContain("empty_title");
  });

  it("rejects a malformed tempId", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "x",
          parentRef: null,
          nodeType: "scene",
          title: "ok",
        },
      ],
    };
    expect(
      codes(validateAiTreePlan(plan, [], "proj-1", scope(["create"], null))),
    ).toContain("bad_temp_id");
  });

  it("rejects duplicate move on the same node", () => {
    const nodes = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "F2", nodeType: "folder", parentId: null, sortOrder: "a1" }),
      mkNode({ id: "s", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        { op: "move", nodeId: "s", newParentRef: "F2" },
        { op: "move", nodeId: "s", newParentRef: "F" },
      ],
    };
    expect(
      codes(
        validateAiTreePlan(plan, nodes, "proj-1", scope(["move"], null, ["s"])),
      ),
    ).toContain("dup_move");
  });

  it("rejects moving a non-existent node", () => {
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [{ op: "move", nodeId: "ghost", newParentRef: null }],
    };
    expect(
      codes(
        validateAiTreePlan(
          plan,
          [],
          "proj-1",
          scope(["move"], null, ["ghost"]),
        ),
      ),
    ).toContain("missing_node");
  });

  it("rejects too many ops", () => {
    const ops = Array.from({ length: 201 }, (_, i) => ({
      op: "create" as const,
      tempId: `tmp:${i}`,
      parentRef: null,
      nodeType: "scene" as const,
      title: `s${i}`,
    }));
    expect(
      codes(
        validateAiTreePlan(
          { kind: "scaffold", ops },
          [],
          "proj-1",
          scope(["create"], null),
        ),
      ),
    ).toContain("too_many_ops");
  });
});

describe("validateAiTreePlan — afterRef cycle (M2)", () => {
  it("rejects two creates whose afterRef point at each other (after_cycle)", () => {
    const nodes = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
    ];
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:a",
          parentRef: "F",
          nodeType: "scene",
          title: "a",
          pos: { afterRef: "tmp:b" },
        },
        {
          op: "create",
          tempId: "tmp:b",
          parentRef: "F",
          nodeType: "scene",
          title: "b",
          pos: { afterRef: "tmp:a" },
        },
      ],
    };
    expect(
      codes(validateAiTreePlan(plan, nodes, "proj-1", scope(["create"], "F"))),
    ).toContain("after_cycle");
  });

  it("rejects a 3-cycle of moves via afterRef", () => {
    const nodes = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "s1", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
      mkNode({ id: "s2", nodeType: "scene", parentId: "F", sortOrder: "a1" }),
      mkNode({ id: "s3", nodeType: "scene", parentId: "F", sortOrder: "a2" }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "move",
          nodeId: "s1",
          newParentRef: "F",
          pos: { afterRef: "s2" },
        },
        {
          op: "move",
          nodeId: "s2",
          newParentRef: "F",
          pos: { afterRef: "s3" },
        },
        {
          op: "move",
          nodeId: "s3",
          newParentRef: "F",
          pos: { afterRef: "s1" },
        },
      ],
    };
    expect(
      codes(
        validateAiTreePlan(
          plan,
          nodes,
          "proj-1",
          scope(["move"], "F", ["s1", "s2", "s3"]),
        ),
      ),
    ).toContain("after_cycle");
  });

  it("still accepts a linear afterRef chain among inserted nodes", () => {
    const nodes = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
    ];
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:a",
          parentRef: "F",
          nodeType: "scene",
          title: "a",
        },
        {
          op: "create",
          tempId: "tmp:b",
          parentRef: "F",
          nodeType: "scene",
          title: "b",
          pos: { afterRef: "tmp:a" },
        },
      ],
    };
    expect(
      validateAiTreePlan(plan, nodes, "proj-1", scope(["create"], "F")).ok,
    ).toBe(true);
  });
});

describe("validateAiTreePlan — corrupt anchor & cross-project (N3 / security)", () => {
  it("rejects afterRef pointing at an existing sibling with a corrupt sortOrder (after_bad_anchor)", () => {
    const nodes = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      // corrupt fractional-index key
      mkNode({ id: "bad", nodeType: "scene", parentId: "F", sortOrder: "!!!" }),
    ];
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:n",
          parentRef: "F",
          nodeType: "scene",
          title: "n",
          pos: { afterRef: "bad" },
        },
      ],
    };
    expect(
      codes(validateAiTreePlan(plan, nodes, "proj-1", scope(["create"], "F"))),
    ).toContain("after_bad_anchor");
  });

  it("rejects a move targeting a node owned by a different project (cross-project)", () => {
    const nodes = [
      mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      mkNode({
        id: "other",
        nodeType: "scene",
        parentId: null,
        sortOrder: "a1",
        projectId: "proj-2",
      }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [{ op: "move", nodeId: "other", newParentRef: "F" }],
    };
    // even if scope.editableIds is (wrongly) widened, refExists rejects the
    // foreign-project node before it can be touched.
    expect(
      codes(
        validateAiTreePlan(
          plan,
          nodes,
          "proj-1",
          scope(["move"], null, ["other"]),
        ),
      ),
    ).toContain("missing_node");
  });
});
