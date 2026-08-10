import { describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import {
  buildProjectNarrativeSnapshot,
  collectNarrativeExternalSourceUris,
  derivePersistedNarrativeSceneScope,
  flushProjectNarrativeScope,
  type ProjectSnapshotAdapterServices,
} from "./projectSnapshotAdapter";
import type { ProjectNarrativeSourceRow } from "@/features/narrative-extraction/source/types";

const AUTHORITY: MutationAuthority = {
  projectId: "project-a",
  currentProjectId: () => "project-a",
  workspacePath: "/workspace-a",
  workspaceOpenRevision: 7,
};

function prose(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function row(nodeId: string, orderIndex: number): ProjectNarrativeSourceRow {
  return {
    nodeId,
    parentId: "folder-a",
    title: `Scene ${nodeId}`,
    content: prose(`Body ${nodeId}`),
    sortOrder: `a${orderIndex}`,
    orderIndex,
    version: orderIndex + 1,
    updatedAt: `2026-08-09T00:0${orderIndex}:00.000Z`,
    sourceUri: nodeId === "scene-b" ? "external-root://novel/scene-b.md" : null,
  };
}

function services(
  overrides: Partial<ProjectSnapshotAdapterServices> = {},
): ProjectSnapshotAdapterServices {
  return {
    isAuthorityCurrent: vi.fn(() => true),
    hasExternalConflict: vi.fn(() => false),
    hasPendingAutoSave: vi.fn(() => false),
    hasPendingDraft: vi.fn(() => false),
    hasPendingWriteBack: vi.fn(() => false),
    hasPendingDocumentMutation: vi.fn(() => false),
    flushAutoSaves: vi.fn(async () => undefined),
    flushDrafts: vi.fn(async () => undefined),
    flushWriteBacks: vi.fn(async () => undefined),
    flushDocumentMutations: vi.fn(async () => undefined),
    loadSourceRows: vi.fn(async () => [row("scene-a", 0), row("scene-b", 1)]),
    createSnapshotId: vi.fn(() => "snapshot-a"),
    now: vi.fn(() => "2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("flushProjectNarrativeScope", () => {
  it("flushes dirty non-active scenes in scope without touching unrelated drafts", async () => {
    const flushAutoSaves = vi.fn(async () => undefined);
    const flushDrafts = vi.fn(async () => undefined);
    const svc = services({
      hasPendingAutoSave: vi.fn((sceneId) => sceneId === "scene-b"),
      hasPendingDraft: vi.fn((sceneId) => sceneId === "scene-b"),
      flushAutoSaves,
      flushDrafts,
    });

    await expect(
      flushProjectNarrativeScope(
        { sceneIds: ["scene-a", "scene-b"], authority: AUTHORITY },
        svc,
      ),
    ).resolves.toEqual({ status: "flushed", blockedDocuments: [] });
    expect(flushAutoSaves).toHaveBeenCalledWith("scene-b");
    expect(flushDrafts).toHaveBeenCalledWith("scene-b");
    expect(flushAutoSaves).not.toHaveBeenCalledWith("outside-scope");
  });

  it("drains a file-backed write-back scheduled by the body save", async () => {
    let pendingAutoSave = true;
    let pendingWriteBack = false;
    const flushWriteBacks = vi.fn(async () => {
      pendingWriteBack = false;
    });
    const svc = services({
      hasPendingAutoSave: vi.fn(() => pendingAutoSave),
      hasPendingWriteBack: vi.fn(() => pendingWriteBack),
      flushAutoSaves: vi.fn(async () => {
        pendingAutoSave = false;
        pendingWriteBack = true;
      }),
      flushWriteBacks,
    });

    await expect(
      flushProjectNarrativeScope(
        { sceneIds: ["scene-b"], authority: AUTHORITY },
        svc,
      ),
    ).resolves.toEqual({ status: "flushed", blockedDocuments: [] });
    expect(flushWriteBacks).toHaveBeenCalledWith(["scene-b"]);
  });

  it("returns already-clean without issuing persistence writes", async () => {
    const svc = services();

    await expect(
      flushProjectNarrativeScope(
        { sceneIds: ["scene-a"], authority: AUTHORITY },
        svc,
      ),
    ).resolves.toEqual({ status: "already-clean", blockedDocuments: [] });
    expect(svc.flushAutoSaves).not.toHaveBeenCalled();
    expect(svc.flushDrafts).not.toHaveBeenCalled();
  });

  it("classifies external conflict before flushing", async () => {
    const svc = services({
      hasExternalConflict: vi.fn((sceneId) => sceneId === "scene-b"),
      hasPendingAutoSave: vi.fn(() => true),
    });

    const result = await flushProjectNarrativeScope(
      { sceneIds: ["scene-a", "scene-b"], authority: AUTHORITY },
      svc,
    );

    expect(result).toEqual({
      status: "blocked",
      blockedDocuments: [{ sceneId: "scene-b", reason: "external-conflict" }],
    });
    expect(svc.flushAutoSaves).not.toHaveBeenCalledWith("scene-b");
  });

  it("reports save failures and authority changes as blocked", async () => {
    const isAuthorityCurrent = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const svc = services({
      isAuthorityCurrent,
      hasPendingAutoSave: vi.fn(() => true),
      flushAutoSaves: vi.fn(async (sceneId) => {
        if (sceneId === "scene-a") throw new Error("disk full");
      }),
    });

    const result = await flushProjectNarrativeScope(
      { sceneIds: ["scene-a", "scene-b"], authority: AUTHORITY },
      svc,
    );

    expect(result.status).toBe("blocked");
    expect(result.blockedDocuments).toEqual(
      expect.arrayContaining([
        { sceneId: "scene-a", reason: "save-failed" },
        { sceneId: "scene-b", reason: "authority-changed" },
      ]),
    );
  });
});

describe("buildProjectNarrativeSnapshot", () => {
  it("fails closed when the renderer cannot flush drafts owned by another window", async () => {
    const svc = services({ canFlushCompleteScope: vi.fn(() => false) });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SNAPSHOT_SCOPE_NOT_FLUSHED" }),
    ]);
    expect(svc.loadSourceRows).not.toHaveBeenCalled();
  });

  it("fails closed when a detached Scene editor opens before publication", async () => {
    const canFlushCompleteScope = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const settleExternalSourceMutations = vi.fn(async () => undefined);
    const svc = services({
      canFlushCompleteScope,
      settleExternalSourceMutations,
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SNAPSHOT_SCOPE_NOT_FLUSHED" }),
    ]);
    expect(canFlushCompleteScope).toHaveBeenCalledTimes(2);
    expect(settleExternalSourceMutations).not.toHaveBeenCalled();
  });

  it("freezes the requested scope before the first async boundary", async () => {
    const mutableSceneIds = ["scene-a"];
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const loadSourceRows = vi.fn(
      async (_projectId: string, sceneIds: readonly string[]) =>
        sceneIds.map((sceneId, index) => row(sceneId, index)),
    );
    const svc = services({
      validateSceneScope: vi.fn(async () => {
        await validationGate;
        return { ok: true as const, sceneIds: ["scene-a"] };
      }),
      loadSourceRows,
    });

    const pending = buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: mutableSceneIds,
        authority: AUTHORITY,
      },
      svc,
    );
    mutableSceneIds[0] = "scene-b";
    mutableSceneIds.push("scene-c");
    releaseValidation();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(loadSourceRows).toHaveBeenCalledWith("project-a", ["scene-a"]);
  });

  it("holds mutation admission closed from scope drain through source seal", async () => {
    const calls: string[] = [];
    const svc = services({
      hasPendingAutoSave: vi.fn(() => true),
      flushAutoSaves: vi.fn(async () => {
        calls.push("flush");
      }),
      acquireSourceReadLease: vi.fn(() => {
        calls.push("acquire");
        return {
          openReadPhase: () => calls.push("open-read"),
          release: () => calls.push("release"),
        };
      }),
      loadSourceRows: vi.fn(async () => {
        calls.push("load");
        return [row("scene-a", 0), row("scene-b", 1)];
      }),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "acquire",
      "open-read",
      "flush",
      "flush",
      "load",
      "load",
      "load",
      "release",
    ]);
  });

  it("loads the sealed DB rows only after scope flush and preserves freshness fields", async () => {
    const calls: string[] = [];
    const svc = services({
      hasPendingAutoSave: vi.fn((sceneId) => sceneId === "scene-b"),
      flushAutoSaves: vi.fn(async (sceneId) => {
        calls.push(`flush:${sceneId}`);
      }),
      loadSourceRows: vi.fn(async (_projectId, sceneIds) => {
        calls.push(`load:${sceneIds.join(",")}`);
        return [row("scene-a", 0), row("scene-b", 1)];
      }),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([
      "flush:scene-b",
      "load:scene-a,scene-b",
      "load:scene-a,scene-b",
      "load:scene-a,scene-b",
    ]);
    expect(
      result.snapshot.documents.map((document) => document.orderIndex),
    ).toEqual([0, 1]);
    expect(result.snapshot.documents[1].origin).toEqual({
      kind: "project-node",
      projectId: "project-a",
      nodeId: "scene-b",
      sourceVersion: 2,
      sourceUpdatedAt: "2026-08-09T00:01:00.000Z",
      sourceUri: "external-root://novel/scene-b.md",
    });
  });

  it("does not read or seal a snapshot when scope flush is blocked", async () => {
    const svc = services({
      hasExternalConflict: vi.fn(() => true),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SCOPE_NOT_FLUSHED" }),
      ]),
    );
    expect(svc.loadSourceRows).not.toHaveBeenCalled();
  });

  it("rejects missing rows instead of synthesizing empty documents", async () => {
    const svc = services({
      loadSourceRows: vi.fn(async () => [row("scene-a", 0)]),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SNAPSHOT_SOURCE_MISSING",
          documentSourceKey: "project:scene:scene-b",
        }),
      ]),
    );
  });

  it("rejects a scope whose authority changes during the read", async () => {
    const isAuthorityCurrent = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const svc = services({ isAuthorityCurrent });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_AUTHORITY_CHANGED" }),
      ]),
    );
  });

  it("rejects a scope whose persisted DFS order differs from the requested order", async () => {
    const svc = services({
      validateSceneScope: vi.fn(async () => ({
        ok: true as const,
        sceneIds: ["scene-b", "scene-a"],
      })),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SCOPE_ORDER_MISMATCH" }),
      ]),
    );
    expect(svc.flushAutoSaves).not.toHaveBeenCalled();
    expect(svc.loadSourceRows).not.toHaveBeenCalled();
  });

  it("rejects an incomplete requested folder scope before flushing", async () => {
    const svc = services({
      validateSceneScope: vi.fn(async () => ({
        ok: true as const,
        sceneIds: ["scene-a", "scene-b", "scene-c"],
      })),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SCOPE_NOT_FLUSHED" }),
      ]),
    );
    expect(result.flush?.blockedDocuments).toContainEqual({
      sceneId: "scene-c",
      reason: "document-unavailable",
    });
    expect(svc.flushAutoSaves).not.toHaveBeenCalled();
  });

  it("rejects an unavailable folder even when the requested scene list is empty", async () => {
    const svc = services({
      validateSceneScope: vi.fn(async () => ({
        ok: false as const,
        reason: "folder-unavailable" as const,
      })),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "missing-folder",
        language: "ja",
        sceneIds: [],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SCOPE_UNAVAILABLE" }),
      ]),
    );
    expect(svc.loadSourceRows).not.toHaveBeenCalled();
  });

  it("rejects a corpus that changes between the source read and seal verification", async () => {
    const firstRows = [row("scene-a", 0), row("scene-b", 1)];
    const changedRows = [
      firstRows[0],
      { ...firstRows[1], version: 3, content: prose("Changed body") },
    ];
    const svc = services({
      loadSourceRows: vi
        .fn<
          (
            projectId: string,
            sceneIds: readonly string[],
          ) => Promise<ProjectNarrativeSourceRow[]>
        >()
        .mockResolvedValueOnce(firstRows)
        .mockResolvedValueOnce(changedRows),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SOURCE_CHANGED" }),
      ]),
    );
  });

  it("rejects an external watcher fact observed after row verification", async () => {
    const settleExternalSourceMutations = vi.fn(async () => {
      throw new Error("external source changed");
    });
    const svc = services({ settleExternalSourceMutations });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SOURCE_CHANGED" }),
      ]),
    );
    expect(settleExternalSourceMutations).toHaveBeenCalledWith(
      "project-a",
      "folder-a",
      expect.arrayContaining([
        expect.objectContaining({
          sourceUri: "external-root://novel/scene-b.md",
        }),
      ]),
    );
  });

  it("rejects an external conflict discovered by the final watcher fence", async () => {
    let externalConflict = false;
    const svc = services({
      hasExternalConflict: vi.fn(() => externalConflict),
      settleExternalSourceMutations: vi.fn(async () => {
        externalConflict = true;
      }),
    });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SOURCE_CHANGED" }),
      ]),
    );
  });

  it("rejects a folder scope that changes during source sealing", async () => {
    const validateSceneScope = vi
      .fn<
        (
          projectId: string,
          folderId: string,
          sceneIds: readonly string[],
        ) => Promise<{
          readonly ok: true;
          readonly sceneIds: readonly string[];
        }>
      >()
      .mockResolvedValueOnce({
        ok: true,
        sceneIds: ["scene-a", "scene-b"],
      })
      .mockResolvedValueOnce({
        ok: true,
        sceneIds: ["scene-a", "scene-b"],
      })
      .mockResolvedValueOnce({
        ok: true,
        sceneIds: ["scene-b", "scene-a"],
      });
    const svc = services({ validateSceneScope });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SOURCE_CHANGED" }),
      ]),
    );
    expect(validateSceneScope).toHaveBeenCalledTimes(3);
  });

  it("rejects a Scene change after the final external-source fence", async () => {
    const stableRows = [row("scene-a", 0), row("scene-b", 1)];
    const changedRows = [
      stableRows[0],
      {
        ...stableRows[1],
        version: stableRows[1].version + 1,
        content: prose("Changed at publication"),
      },
    ];
    const loadSourceRows = vi
      .fn<
        (
          projectId: string,
          sceneIds: readonly string[],
        ) => Promise<ProjectNarrativeSourceRow[]>
      >()
      .mockResolvedValueOnce(stableRows)
      .mockResolvedValueOnce(stableRows)
      .mockResolvedValueOnce(changedRows);
    const svc = services({ loadSourceRows });

    const result = await buildProjectNarrativeSnapshot(
      {
        projectId: "project-a",
        folderId: "folder-a",
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_SOURCE_CHANGED" }),
      ]),
    );
    expect(loadSourceRows).toHaveBeenCalledTimes(3);
  });
});

describe("derivePersistedNarrativeSceneScope", () => {
  it("keeps an empty external mount folder as a root-wide settlement target", () => {
    expect(
      collectNarrativeExternalSourceUris(
        [
          {
            id: "chapter",
            parentId: null,
            nodeType: "folder",
            sourceUri: null,
          },
          {
            id: "mount-root",
            parentId: "chapter",
            nodeType: "folder",
            sourceUri: "external-root://novel/.mount",
          },
        ],
        "chapter",
        [],
      ),
    ).toEqual(["external-root://novel/.mount"]);
  });

  it("derives filtered DFS order from persisted folders and ignores optimistic input order", () => {
    const nodes = [
      { id: "chapter", parentId: null, nodeType: "folder", sortOrder: "a0" },
      {
        id: "scene-a",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "a0",
      },
      {
        id: "section",
        parentId: "chapter",
        nodeType: "folder",
        sortOrder: "a1",
      },
      {
        id: "scene-b",
        parentId: "section",
        nodeType: "scene",
        sortOrder: "a0",
      },
      {
        id: "scene-c",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "a2",
      },
    ] as const;

    expect(derivePersistedNarrativeSceneScope(nodes, "chapter")).toEqual({
      ok: true,
      sceneIds: ["scene-a", "scene-b", "scene-c"],
    });
  });

  it("omits orphaned or cyclic requested scenes so validation fails closed", () => {
    const nodes = [
      {
        id: "folder-a",
        parentId: "folder-b",
        nodeType: "folder",
        sortOrder: "a0",
      },
      {
        id: "folder-b",
        parentId: "folder-a",
        nodeType: "folder",
        sortOrder: "a0",
      },
      {
        id: "scene-a",
        parentId: "folder-a",
        nodeType: "scene",
        sortOrder: "a0",
      },
    ] as const;

    expect(derivePersistedNarrativeSceneScope(nodes, "folder-a")).toEqual({
      ok: false,
      reason: "invalid-tree",
    });
  });

  it("uses the tree's binary fractional-key ordering", () => {
    const nodes = [
      { id: "chapter", parentId: null, nodeType: "folder", sortOrder: "a0" },
      {
        id: "scene-lower",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "az",
      },
      {
        id: "scene-upper",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "aZ",
      },
    ] as const;

    expect(derivePersistedNarrativeSceneScope(nodes, "chapter")).toEqual({
      ok: true,
      sceneIds: ["scene-upper", "scene-lower"],
    });
  });

  it("rejects duplicate sibling fractional keys as an ambiguous tree", () => {
    const nodes = [
      { id: "chapter", parentId: null, nodeType: "folder", sortOrder: "a0" },
      {
        id: "scene-a",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "a1",
      },
      {
        id: "scene-b",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "a1",
      },
    ] as const;

    expect(derivePersistedNarrativeSceneScope(nodes, "chapter")).toEqual({
      ok: false,
      reason: "invalid-tree",
    });
  });

  it("rejects descendants attached below a non-folder node", () => {
    const nodes = [
      { id: "chapter", parentId: null, nodeType: "folder", sortOrder: "a0" },
      {
        id: "scene-a",
        parentId: "chapter",
        nodeType: "scene",
        sortOrder: "a0",
      },
      {
        id: "nested-folder",
        parentId: "scene-a",
        nodeType: "folder",
        sortOrder: "a0",
      },
      {
        id: "scene-b",
        parentId: "nested-folder",
        nodeType: "scene",
        sortOrder: "a0",
      },
    ] as const;

    expect(derivePersistedNarrativeSceneScope(nodes, "chapter")).toEqual({
      ok: false,
      reason: "invalid-tree",
    });
  });

  it("distinguishes a valid empty folder from an unavailable folder", () => {
    const nodes = [
      { id: "empty", parentId: null, nodeType: "folder", sortOrder: "a0" },
    ] as const;

    expect(derivePersistedNarrativeSceneScope(nodes, "empty")).toEqual({
      ok: true,
      sceneIds: [],
    });
    expect(derivePersistedNarrativeSceneScope(nodes, "missing")).toEqual({
      ok: false,
      reason: "folder-unavailable",
    });
  });
});
