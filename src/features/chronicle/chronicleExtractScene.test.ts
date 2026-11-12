import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ChronicleReviewProposal } from "./chronicleExtractionStore";
import {
  chronicleCurrentSceneOptionValue,
  chronicleExtractTargetOptionValue,
  countChronicleUnsettledProposals,
  resolveChronicleExtractScene,
  resolveDiscardedRunTarget,
  singleSceneIdOfScope,
} from "./chronicleExtractScene";

function node(
  id: string,
  nodeType: TreeNodeData["nodeType"],
  parentId: string | null,
  sortOrder = id,
): TreeNodeData {
  return {
    id,
    projectId: "p",
    parentId,
    nodeType,
    title: `title-${id}`,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

const nodes = [
  node("f", "folder", null),
  node("s1", "scene", "f"),
  node("s2", "scene", "f"),
  node("root", "scene", null),
  node("n", "note", "f"),
  node("nested-f", "folder", "f"),
  node("deep", "scene", "nested-f"),
];

describe("chronicleCurrentSceneOptionValue", () => {
  it("never equals a plain folder id and round-trips the target value", () => {
    expect(chronicleCurrentSceneOptionValue("s1")).toBe("scene:s1");
    expect(chronicleExtractTargetOptionValue(null)).toBe("");
    expect(
      chronicleExtractTargetOptionValue({ kind: "folder", folderId: "f" }),
    ).toBe("f");
    expect(
      chronicleExtractTargetOptionValue({
        kind: "scene",
        sceneId: "s1",
        folderId: "f",
      }),
    ).toBe("scene:s1");
  });
});

describe("resolveChronicleExtractScene", () => {
  it("accepts a Scene whose parent is a folder", () => {
    expect(resolveChronicleExtractScene(nodes, "s1")).toEqual({
      available: true,
      sceneId: "s1",
      title: "title-s1",
      folderId: "f",
    });
    expect(resolveChronicleExtractScene(nodes, "deep")).toMatchObject({
      available: true,
      folderId: "nested-f",
    });
  });

  it.each([
    [null, "no-active-node"],
    ["", "no-active-node"],
    ["missing", "no-active-node"],
    ["n", "not-a-scene"],
    ["f", "not-a-scene"],
    ["root", "not-in-folder"],
  ] as const)("rejects %j as %s", (id, reason) => {
    expect(resolveChronicleExtractScene(nodes, id)).toEqual({
      available: false,
      reason,
    });
  });

  it("rejects a Scene whose parent is missing or not a folder", () => {
    expect(
      resolveChronicleExtractScene([node("orphan", "scene", "gone")], "orphan"),
    ).toEqual({ available: false, reason: "not-in-folder" });
    expect(
      resolveChronicleExtractScene(
        [node("note", "note", null), node("kid", "scene", "note")],
        "kid",
      ),
    ).toEqual({ available: false, reason: "not-in-folder" });
  });
});

describe("countChronicleUnsettledProposals", () => {
  it("counts unreviewed/approved/held/deferred, not rejected, applied, or already satisfied", () => {
    const base = {
      applicability: "applicable",
      application: null,
    } as const;
    const proposals = [
      { ...base, status: "unreviewed" },
      { ...base, status: "approved" },
      { ...base, status: "held" },
      { ...base, status: "deferred" },
      { ...base, status: "rejected" },
      { ...base, status: "approved", application: { commitId: "c" } },
      { ...base, status: "deferred", applicability: "already-satisfied" },
    ] as unknown as ChronicleReviewProposal[];
    expect(countChronicleUnsettledProposals(proposals)).toBe(4);
  });
});

describe("singleSceneIdOfScope / resolveDiscardedRunTarget", () => {
  it("reads a Scene id only from a one-Scene scope", () => {
    expect(singleSceneIdOfScope({ sceneIds: ["s1"] })).toBe("s1");
    expect(singleSceneIdOfScope({ sceneIds: ["s1", "s2"] })).toBeNull();
    expect(singleSceneIdOfScope({ sceneIds: [] })).toBeNull();
    expect(singleSceneIdOfScope({})).toBeNull();
  });

  it("keeps folder targets, treats a lone-Scene folder as the folder, and restores a live Scene", () => {
    expect(
      resolveDiscardedRunTarget(
        { folderId: "f", sceneIds: ["s1", "s2"] },
        nodes,
      ),
    ).toEqual({ kind: "folder", folderId: "f" });
    expect(
      resolveDiscardedRunTarget({ folderId: "f", sceneIds: ["s1"] }, nodes),
    ).toEqual({ kind: "scene", sceneId: "s1", folderId: "f" });
    expect(
      resolveDiscardedRunTarget(
        { folderId: "nested-f", sceneIds: ["deep"] },
        nodes,
      ),
    ).toEqual({ kind: "folder", folderId: "nested-f" });
  });

  it("returns null when the Scene is gone, moved, or no longer a direct child", () => {
    expect(
      resolveDiscardedRunTarget({ folderId: "f", sceneIds: ["gone"] }, nodes),
    ).toBeNull();
    expect(
      resolveDiscardedRunTarget({ folderId: "f", sceneIds: ["root"] }, nodes),
    ).toBeNull();
    // deep lives in nested-f, not directly in f (f has other Scenes).
    expect(
      resolveDiscardedRunTarget({ folderId: "f", sceneIds: ["deep"] }, nodes),
    ).toBeNull();
  });
});
