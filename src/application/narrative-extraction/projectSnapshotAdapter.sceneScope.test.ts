import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import type { ProjectNarrativeSourceRow } from "@/features/narrative-extraction/source/types";

const listNodesMock = vi.hoisted(() => vi.fn());
const loadRowsMock = vi.hoisted(() => vi.fn());
const settleMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/tree/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/tree/api")>()),
  listNodes: listNodesMock,
  loadProjectNarrativeSourceRows: loadRowsMock,
}));

vi.mock("@/features/external-mount/mountManager", () => ({
  settleExternalMountMutationsForSourceUris: settleMock,
  hasExternalMountReloadConflictForScene: () => false,
}));

import {
  buildProjectNarrativeSnapshot,
  collectRequestedSceneExternalSourceUris,
  defaultProjectSnapshotAdapterServices,
  deriveRequestedDirectChildSceneScope,
  type NarrativeSceneScopeOptions,
  type ProjectNarrativeSnapshotRequest,
  type ProjectNarrativeSnapshotResult,
  type ProjectSnapshotAdapterServices,
} from "./projectSnapshotAdapter";

const AUTHORITY: MutationAuthority = {
  projectId: "project-a",
  currentProjectId: () => "project-a",
  workspacePath: "/workspace-a",
  workspaceOpenRevision: 7,
};

interface TestNode {
  id: string;
  parentId: string | null;
  nodeType: "folder" | "scene" | "note";
  sortOrder: string;
  sourceUri: string | null;
}

function node(
  id: string,
  parentId: string | null,
  nodeType: TestNode["nodeType"],
  sortOrder: string,
  sourceUri: string | null = null,
): TestNode {
  return { id, parentId, nodeType, sortOrder, sourceUri };
}

const MOUNT_URI = "external-root://novel/.mount";
const sceneUri = (id: string) => `external-root://novel/${id}.md`;

/** folder-a holds three Scenes, a note, and a nested folder with a Scene. */
function baseTree(): TestNode[] {
  return [
    node("folder-root", null, "folder", "a0"),
    node("folder-a", "folder-root", "folder", "a0", MOUNT_URI),
    node("s1", "folder-a", "scene", "a1", sceneUri("s1")),
    node("s2", "folder-a", "scene", "a2", sceneUri("s2")),
    node("s3", "folder-a", "scene", "a3", sceneUri("s3")),
    node("n1", "folder-a", "note", "a4"),
    node("folder-b", "folder-a", "folder", "a5"),
    node("g1", "folder-b", "scene", "a1"),
    node("folder-c", "folder-root", "folder", "a1"),
    node("c1", "folder-c", "scene", "a1"),
    node("r1", null, "scene", "a9"),
  ];
}

function prose(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

let tree: TestNode[] = baseTree();
let unreadable = new Set<string>();

function rowFor(
  nodeId: string,
  orderIndex: number,
): ProjectNarrativeSourceRow | null {
  const source = tree.find((candidate) => candidate.id === nodeId);
  if (!source || source.nodeType !== "scene" || unreadable.has(nodeId)) {
    return null;
  }
  return {
    nodeId,
    parentId: source.parentId,
    title: `Scene ${nodeId}`,
    content: prose(`Body ${nodeId}`),
    sortOrder: source.sortOrder,
    storyTimeOrder: null,
    orderIndex,
    version: 1,
    updatedAt: "2026-08-09T00:00:00.000Z",
    sourceUri: source.sourceUri,
  };
}

function services(
  overrides: Partial<ProjectSnapshotAdapterServices> = {},
): ProjectSnapshotAdapterServices {
  return {
    ...defaultProjectSnapshotAdapterServices,
    canFlushCompleteScope: async () => true,
    isAuthorityCurrent: () => true,
    hasExternalConflict: () => false,
    hasPendingAutoSave: () => false,
    hasPendingDraft: () => false,
    hasPendingWriteBack: () => false,
    hasPendingDocumentMutation: () => false,
    flushAutoSaves: vi.fn(async () => undefined),
    flushDrafts: vi.fn(async () => undefined),
    flushWriteBacks: vi.fn(async () => undefined),
    flushDocumentMutations: vi.fn(async () => undefined),
    acquireSourceReadLease: undefined,
    getScopeRevision: () => "revision",
    createSnapshotId: () => "snapshot-a",
    now: () => "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function request(
  sceneIds: readonly string[],
  overrides: Partial<ProjectNarrativeSnapshotRequest> = {},
): ProjectNarrativeSnapshotRequest {
  return {
    projectId: "project-a",
    folderId: "folder-a",
    language: "ja",
    sceneIds,
    authority: AUTHORITY,
    sceneScopeMode: "requested-direct-children",
    ...overrides,
  };
}

function codes(result: ProjectNarrativeSnapshotResult): string[] {
  return result.ok ? [] : result.diagnostics.map((item) => item.code);
}

beforeEach(() => {
  tree = baseTree();
  unreadable = new Set();
  listNodesMock.mockReset();
  loadRowsMock.mockReset();
  settleMock.mockReset();
  listNodesMock.mockImplementation(async () =>
    tree.map((item) => ({ ...item })),
  );
  loadRowsMock.mockImplementation(
    async (_projectId: string, ids: readonly string[]) =>
      ids.flatMap((id, index) => {
        const row = rowFor(id, index);
        return row ? [row] : [];
      }),
  );
  settleMock.mockResolvedValue(undefined);
});

describe("deriveRequestedDirectChildSceneScope", () => {
  it("returns only the requested direct-child Scenes, in tree order", () => {
    expect(
      deriveRequestedDirectChildSceneScope(tree, "folder-a", ["s2"]),
    ).toEqual({ ok: true, sceneIds: ["s2"] });
    expect(
      deriveRequestedDirectChildSceneScope(tree, "folder-a", ["s3", "s1"]),
    ).toEqual({ ok: true, sceneIds: ["s1", "s3"] });
  });

  it("omits ids that are not direct child Scenes of the folder", () => {
    expect(
      deriveRequestedDirectChildSceneScope(tree, "folder-a", [
        "g1",
        "c1",
        "r1",
        "n1",
        "ghost",
        "folder-b",
      ]),
    ).toEqual({ ok: true, sceneIds: [] });
  });

  it("rejects a missing folder, a non-folder, and a non-folder ancestor", () => {
    expect(deriveRequestedDirectChildSceneScope(tree, "ghost", ["s1"])).toEqual(
      {
        ok: false,
        reason: "folder-unavailable",
      },
    );
    expect(deriveRequestedDirectChildSceneScope(tree, "s1", ["s1"])).toEqual({
      ok: false,
      reason: "folder-unavailable",
    });
    const bad = baseTree().map((item) =>
      item.id === "folder-root" ? { ...item, nodeType: "note" as const } : item,
    );
    expect(
      deriveRequestedDirectChildSceneScope(bad, "folder-a", ["s1"]),
    ).toEqual({
      ok: false,
      reason: "invalid-tree",
    });
  });

  it("rejects an ancestor cycle", () => {
    const cyclic = [
      node("f1", "f2", "folder", "a0"),
      node("f2", "f1", "folder", "a0"),
      node("x", "f1", "scene", "a0"),
    ];
    expect(deriveRequestedDirectChildSceneScope(cyclic, "f1", ["x"])).toEqual({
      ok: false,
      reason: "invalid-tree",
    });
  });

  it("rejects a requested Scene that has children", () => {
    const withChild = [...baseTree(), node("kid", "s1", "scene", "a0")];
    expect(
      deriveRequestedDirectChildSceneScope(withChild, "folder-a", ["s1"]),
    ).toEqual({ ok: false, reason: "invalid-tree" });
    // An unrelated sibling having children does not matter.
    expect(
      deriveRequestedDirectChildSceneScope(withChild, "folder-a", ["s2"]),
    ).toEqual({ ok: true, sceneIds: ["s2"] });
  });

  it("rejects equal sort keys between requested Scenes but ignores unrequested siblings", () => {
    const duplicated = baseTree().map((item) =>
      item.id === "s3" ? { ...item, sortOrder: "a2" } : item,
    );
    expect(
      deriveRequestedDirectChildSceneScope(duplicated, "folder-a", [
        "s2",
        "s3",
      ]),
    ).toEqual({ ok: false, reason: "invalid-tree" });
    expect(
      deriveRequestedDirectChildSceneScope(duplicated, "folder-a", ["s2"]),
    ).toEqual({ ok: true, sceneIds: ["s2"] });
    expect(
      deriveRequestedDirectChildSceneScope(duplicated, "folder-a", ["s1"]),
    ).toEqual({ ok: true, sceneIds: ["s1"] });
  });
});

describe("collectRequestedSceneExternalSourceUris", () => {
  it("collects only the rows' own file URIs, never a folder or mount root", () => {
    expect(
      collectRequestedSceneExternalSourceUris([
        { sourceUri: sceneUri("s1") },
        { sourceUri: null },
        { sourceUri: sceneUri("s1") },
      ]),
    ).toEqual([sceneUri("s1")]);
  });
});

describe("buildProjectNarrativeSnapshot with requested-direct-children", () => {
  it("builds from one Scene of a three-Scene folder and reads only that Scene", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s2"]),
      services(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.documents).toHaveLength(1);
    expect(result.snapshot.documents[0]?.sourceKey).toBe("project:scene:s2");
    expect(result.scopeAuthorityDocuments).toHaveLength(1);
    expect(loadRowsMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, ids] of loadRowsMock.mock.calls) {
      expect(ids).toEqual(["s2"]);
    }
  });

  it("settles and verifies only the requested Scene's file, never the folder, mount root, or siblings", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s2"]),
      services(),
    );

    expect(result.ok).toBe(true);
    // 3 scope validations (settle inside each) + the final fence after sealing.
    expect(settleMock).toHaveBeenCalledTimes(4);
    for (const [sourceUris, expectations] of settleMock.mock.calls) {
      expect(sourceUris).toEqual([sceneUri("s2")]);
      expect(
        (expectations as { sourceUri: string }[]).map((item) => item.sourceUri),
      ).toEqual([sceneUri("s2")]);
      expect(sourceUris).not.toContain(MOUNT_URI);
      expect(sourceUris).not.toContain(sceneUri("s1"));
      expect(sourceUris).not.toContain(sceneUri("s3"));
    }
  });

  it("passes when sibling Scenes have ambiguous sort keys (folder-exact fails closed on the same tree)", async () => {
    tree = tree.map((item) =>
      item.id === "s3" ? { ...item, sortOrder: "a2" } : item,
    );

    const scoped = await buildProjectNarrativeSnapshot(
      request(["s1"]),
      services(),
    );
    expect(scoped.ok).toBe(true);

    const exact = await buildProjectNarrativeSnapshot(
      request(["s1", "s2", "s3"], { sceneScopeMode: undefined }),
      services(),
    );
    expect(exact.ok).toBe(false);
    expect(codes(exact)).toEqual(["SNAPSHOT_SCOPE_UNAVAILABLE"]);
  });

  it("builds two requested Scenes in tree order", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s1", "s3"]),
      services(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.snapshot.documents.map((document) => document.sourceKey),
    ).toEqual(["project:scene:s1", "project:scene:s3"]);
  });

  it.each([
    ["a grandchild Scene", "folder-a", ["g1"]],
    ["a Scene of another folder", "folder-a", ["c1"]],
    ["a Scene directly under the project", "folder-a", ["r1"]],
    ["a note", "folder-a", ["n1"]],
    ["a missing Scene", "folder-a", ["ghost"]],
  ])(
    "rejects %s before flushing, with the existing unavailable diagnostics",
    async (_label, folderId, sceneIds) => {
      const svc = services();
      const result = await buildProjectNarrativeSnapshot(
        request(sceneIds, { folderId }),
        svc,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_NOT_FLUSHED"]);
      expect(result.flush?.blockedDocuments).toContainEqual({
        sceneId: sceneIds[0],
        reason: "document-unavailable",
      });
      expect(svc.flushAutoSaves).not.toHaveBeenCalled();
    },
  );

  it("rejects a requested Scene whose row cannot be read", async () => {
    unreadable = new Set(["s2"]);
    const result = await buildProjectNarrativeSnapshot(
      request(["s2"]),
      services(),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_NOT_FLUSHED"]);
  });

  it("rejects a folder that is missing, not a folder, or under a non-folder ancestor", async () => {
    for (const folderId of ["ghost", "s1"]) {
      const result = await buildProjectNarrativeSnapshot(
        request(["s2"], { folderId }),
        services(),
      );
      expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_UNAVAILABLE"]);
    }
    tree = tree.map((item) =>
      item.id === "folder-root"
        ? { ...item, nodeType: "scene" as const }
        : item,
    );
    const result = await buildProjectNarrativeSnapshot(
      request(["s2"]),
      services(),
    );
    expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_UNAVAILABLE"]);
  });

  it("rejects a requested Scene that has children", async () => {
    tree = [...tree, node("kid", "s1", "scene", "a0")];
    const result = await buildProjectNarrativeSnapshot(
      request(["s1"]),
      services(),
    );
    expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_UNAVAILABLE"]);
  });

  it("rejects two requested Scenes in the reverse of tree order", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s3", "s1"]),
      services(),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_ORDER_MISMATCH"]);
  });

  it("rejects a duplicated requested Scene", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s1", "s1"]),
      services(),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_DUPLICATE_SOURCE_KEY"]);
  });

  it("stops with SNAPSHOT_SOURCE_CHANGED when the Scene is removed while sealing", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s2"]),
      services({
        createSnapshotId: () => {
          tree = tree.filter((item) => item.id !== "s2");
          return "snapshot-a";
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_SOURCE_CHANGED"]);
  });

  it("stops with SNAPSHOT_SOURCE_CHANGED when the Scene is moved out of the folder while sealing", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s2"]),
      services({
        createSnapshotId: () => {
          tree = tree.map((item) =>
            item.id === "s2" ? { ...item, parentId: "folder-c" } : item,
          );
          return "snapshot-a";
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_SOURCE_CHANGED"]);
  });

  it("stops with SNAPSHOT_SOURCE_CHANGED when the Scene moves after the final external fence", async () => {
    const base = services();
    const result = await buildProjectNarrativeSnapshot(request(["s2"]), {
      ...base,
      settleExternalSourceMutations: async (...args) => {
        await base.settleExternalSourceMutations!(...args);
        tree = tree.map((item) =>
          item.id === "s2" ? { ...item, parentId: "folder-b" } : item,
        );
      },
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_SOURCE_CHANGED"]);
  });

  it("stops with SNAPSHOT_SOURCE_CHANGED when the Scene becomes unreadable after sealing", async () => {
    const base = services();
    const result = await buildProjectNarrativeSnapshot(request(["s2"]), {
      ...base,
      settleExternalSourceMutations: async (...args) => {
        await base.settleExternalSourceMutations!(...args);
        unreadable = new Set(["s2"]);
      },
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["SNAPSHOT_SOURCE_CHANGED"]);
  });
});

describe("default (folder-exact) behaviour is unchanged", () => {
  it.each([
    ["omitted", undefined],
    ["explicit folder-exact", "folder-exact" as const],
    [
      "an unknown value (treated as folder-exact)",
      "anything-else" as unknown as "folder-exact",
    ],
  ])(
    "still rejects a partial folder request when the mode is %s",
    async (_label, sceneScopeMode) => {
      const result = await buildProjectNarrativeSnapshot(
        request(["s1"], { sceneScopeMode }),
        services(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codes(result)).toEqual(["SNAPSHOT_SCOPE_NOT_FLUSHED"]);
      expect(
        result.flush?.blockedDocuments.map((item) => item.sceneId),
      ).toEqual(expect.arrayContaining(["s2", "s3"]));
    },
  );

  it("still builds the complete folder request, settling the folder and mount root", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["s1", "s2", "s3", "g1"], { sceneScopeMode: undefined }),
      services(),
    );
    expect(result.ok).toBe(true);
    const settledUris = settleMock.mock.calls.flatMap(
      ([sourceUris]) => sourceUris as string[],
    );
    expect(settledUris).toContain(MOUNT_URI);
  });
});

describe("scope mode is forwarded to injected services only when selected", () => {
  function spyServices() {
    const validateSceneScope = vi.fn(
      async (
        _projectId: string,
        _folderId: string,
        sceneIds: readonly string[],
      ) => ({ ok: true as const, sceneIds }),
    );
    const settleExternalSourceMutations = vi.fn(
      async (
        _projectId: string,
        _folderId: string,
        _rows: readonly ProjectNarrativeSourceRow[],
        _options?: NarrativeSceneScopeOptions,
      ) => undefined,
    );
    return {
      validateSceneScope,
      settleExternalSourceMutations,
      services: services({
        validateSceneScope,
        settleExternalSourceMutations,
        loadSourceRows: async (_projectId, ids) =>
          ids.flatMap((id, index) => {
            const row = rowFor(id, index);
            return row ? [row] : [];
          }),
      }),
    };
  }

  it("passes the option to every validation and the final fence", async () => {
    const spies = spyServices();
    const result = await buildProjectNarrativeSnapshot(
      request(["s1"]),
      spies.services,
    );
    expect(result.ok).toBe(true);
    expect(spies.validateSceneScope).toHaveBeenCalledTimes(3);
    for (const call of spies.validateSceneScope.mock.calls) {
      expect(call).toEqual([
        "project-a",
        "folder-a",
        ["s1"],
        { sceneScopeMode: "requested-direct-children" },
      ]);
    }
    expect(spies.settleExternalSourceMutations).toHaveBeenCalledTimes(1);
    expect(spies.settleExternalSourceMutations.mock.calls[0]?.[3]).toEqual({
      sceneScopeMode: "requested-direct-children",
    });
  });

  it("keeps the original three arguments when the mode is not selected", async () => {
    const spies = spyServices();
    const result = await buildProjectNarrativeSnapshot(
      request(["s1"], { sceneScopeMode: undefined }),
      spies.services,
    );
    expect(result.ok).toBe(true);
    for (const call of spies.validateSceneScope.mock.calls) {
      expect(call).toHaveLength(3);
    }
    expect(spies.settleExternalSourceMutations.mock.calls[0]).toHaveLength(3);
  });

  it("does not put the mode into the sealed snapshot", async () => {
    const spies = spyServices();
    const result = await buildProjectNarrativeSnapshot(
      request(["s1"]),
      spies.services,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.snapshot)).not.toContain(
      "requested-direct-children",
    );
    expect(JSON.stringify(result.snapshot)).not.toContain("sceneScopeMode");
    expect(JSON.stringify(result.scopeAuthorityDocuments)).not.toContain(
      "sceneScopeMode",
    );
  });
});
