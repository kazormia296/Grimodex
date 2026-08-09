import { describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import {
  buildProjectNarrativeSnapshot,
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
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  });
}

function row(
  nodeId: string,
  orderIndex: number,
): ProjectNarrativeSourceRow {
  return {
    nodeId,
    parentId: "folder-a",
    title: `Scene ${nodeId}`,
    content: prose(`Body ${nodeId}`),
    sortOrder: `a${orderIndex}`,
    orderIndex,
    version: orderIndex + 1,
    updatedAt: `2026-08-09T00:0${orderIndex}:00.000Z`,
    sourceUri:
      nodeId === "scene-b" ? "external-root://novel/scene-b.md" : null,
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
    flushAutoSaves: vi.fn(async () => undefined),
    flushDrafts: vi.fn(async () => undefined),
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
      blockedDocuments: [
        { sceneId: "scene-b", reason: "external-conflict" },
      ],
    });
    expect(svc.flushAutoSaves).not.toHaveBeenCalledWith("scene-b");
  });

  it("reports save failures and authority changes as blocked", async () => {
    const isAuthorityCurrent = vi
      .fn<() => boolean>()
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
        language: "ja",
        sceneIds: ["scene-a", "scene-b"],
        authority: AUTHORITY,
      },
      svc,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual(["flush:scene-b", "load:scene-a,scene-b"]);
    expect(result.snapshot.documents.map((document) => document.orderIndex)).toEqual([
      0,
      1,
    ]);
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
});
