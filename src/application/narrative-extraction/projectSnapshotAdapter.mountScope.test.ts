// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";

/**
 * Runs the production default scope validation and external-source fence
 * against the real mountManager verification (only the disk scan is faked), to
 * show that one Scene of an external-mount folder can be extracted while a
 * sibling Scene's file exists.
 */

const listNodesMock = vi.hoisted(() => vi.fn());
const loadRowsMock = vi.hoisted(() => vi.fn());
const scanMountMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/tree/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/tree/api")>()),
  listNodes: listNodesMock,
  loadProjectNarrativeSourceRows: loadRowsMock,
}));

vi.mock("@/features/external-mount/api", () => ({
  readExternalFile: vi.fn(),
  getExternalFileMtime: vi.fn(),
  writeExternalFile: vi.fn(),
  unregisterMount: vi.fn(),
  registerMount: vi.fn(),
  scanMount: (...args: unknown[]) => scanMountMock(...args),
}));

import {
  buildProjectNarrativeSnapshot,
  defaultProjectSnapshotAdapterServices,
  type ProjectNarrativeSnapshotRequest,
  type ProjectSnapshotAdapterServices,
} from "./projectSnapshotAdapter";
import { markdownToPmJson } from "@/features/external-mount/markdownBridge";
import {
  buildMountFolderUri,
  buildSourceUri,
} from "@/features/external-mount/sourceUri";
import { settleExternalMountMutationsForSourceUris } from "@/features/external-mount/mountManager";

const AUTHORITY: MutationAuthority = {
  projectId: "project-a",
  currentProjectId: () => "project-a",
  workspacePath: "/workspace-a",
  workspaceOpenRevision: 7,
};

const ROOT = "root-1";
const mountUri = buildMountFolderUri(ROOT);
const firstUri = buildSourceUri(ROOT, "chapter/first.md");
const secondUri = buildSourceUri(ROOT, "chapter/second.md");
const firstMarkdown = "first scene\n";
const secondMarkdown = "second scene\n";

const tree = [
  {
    id: "mount-folder",
    parentId: null,
    nodeType: "folder",
    sortOrder: "a0",
    sourceUri: mountUri,
  },
  {
    id: "first",
    parentId: "mount-folder",
    nodeType: "scene",
    sortOrder: "a1",
    sourceUri: firstUri,
  },
  {
    id: "second",
    parentId: "mount-folder",
    nodeType: "scene",
    sortOrder: "a2",
    sourceUri: secondUri,
  },
];

const contents: Record<string, string> = {
  first: JSON.stringify(markdownToPmJson(firstMarkdown)),
  second: JSON.stringify(markdownToPmJson(secondMarkdown)),
};

function services(): ProjectSnapshotAdapterServices {
  return {
    ...defaultProjectSnapshotAdapterServices,
    canFlushCompleteScope: async () => true,
    isAuthorityCurrent: () => true,
    hasExternalConflict: () => false,
    hasPendingAutoSave: () => false,
    hasPendingDraft: () => false,
    hasPendingWriteBack: () => false,
    hasPendingDocumentMutation: () => false,
    flushAutoSaves: async () => undefined,
    flushDrafts: async () => undefined,
    flushWriteBacks: async () => undefined,
    flushDocumentMutations: async () => undefined,
    acquireSourceReadLease: undefined,
    getScopeRevision: () => "revision",
    createSnapshotId: () => "snapshot-a",
    now: () => "2026-08-10T00:00:00.000Z",
  };
}

function request(
  sceneIds: readonly string[],
  overrides: Partial<ProjectNarrativeSnapshotRequest> = {},
): ProjectNarrativeSnapshotRequest {
  return {
    projectId: "project-a",
    folderId: "mount-folder",
    language: "ja",
    sceneIds,
    authority: AUTHORITY,
    ...overrides,
  };
}

beforeEach(() => {
  listNodesMock.mockReset();
  loadRowsMock.mockReset();
  scanMountMock.mockReset();
  listNodesMock.mockImplementation(async () =>
    tree.map((item) => ({ ...item })),
  );
  loadRowsMock.mockImplementation(
    async (_projectId: string, ids: readonly string[]) =>
      ids.map((id, orderIndex) => {
        const source = tree.find((item) => item.id === id)!;
        return {
          nodeId: id,
          parentId: source.parentId,
          title: id,
          content: contents[id]!,
          sortOrder: source.sortOrder,
          storyTimeOrder: null,
          orderIndex,
          version: 1,
          updatedAt: "2026-08-09T00:00:00.000Z",
          sourceUri: source.sourceUri,
        };
      }),
  );
  scanMountMock.mockResolvedValue({
    dirs: [{ relPath: "chapter", name: "chapter" }],
    files: [
      {
        relPath: "chapter/first.md",
        content: firstMarkdown,
        mtime: "2026-05-24T12:00:00.000Z",
        contentHash: "first-hash",
      },
      {
        relPath: "chapter/second.md",
        content: secondMarkdown,
        mtime: "2026-05-24T12:00:00.000Z",
        contentHash: "second-hash",
      },
    ],
  });
});

describe("requested-direct-children on an external-mount folder", () => {
  it("extracts one Scene while a sibling Scene's file is on disk", async () => {
    const result = await buildProjectNarrativeSnapshot(
      request(["first"], { sceneScopeMode: "requested-direct-children" }),
      services(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.documents).toHaveLength(1);
    expect(result.snapshot.documents[0]?.sourceKey).toBe("project:scene:first");
    expect(scanMountMock).toHaveBeenCalled();
    expect(loadRowsMock.mock.calls.every(([, ids]) => ids.length === 1)).toBe(
      true,
    );
  });

  it("still verifies the requested Scene's own file against the disk", async () => {
    scanMountMock.mockResolvedValue({
      dirs: [{ relPath: "chapter", name: "chapter" }],
      files: [
        {
          relPath: "chapter/first.md",
          content: "changed on disk\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "changed-hash",
        },
        {
          relPath: "chapter/second.md",
          content: secondMarkdown,
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "second-hash",
        },
      ],
    });

    const result = await buildProjectNarrativeSnapshot(
      request(["first"], { sceneScopeMode: "requested-direct-children" }),
      services(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "SNAPSHOT_SOURCE_CHANGED",
    ]);
  });

  it("stops when the requested Scene's file is gone from the disk", async () => {
    scanMountMock.mockResolvedValue({
      dirs: [{ relPath: "chapter", name: "chapter" }],
      files: [
        {
          relPath: "chapter/second.md",
          content: secondMarkdown,
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "second-hash",
        },
      ],
    });

    const result = await buildProjectNarrativeSnapshot(
      request(["first"], { sceneScopeMode: "requested-direct-children" }),
      services(),
    );

    expect(result.ok).toBe(false);
  });

  it("documents why the folder and mount root are left out: verifying them with one Scene's file fails", async () => {
    await expect(
      settleExternalMountMutationsForSourceUris(
        [mountUri, firstUri],
        [{ sourceUri: firstUri }],
      ),
    ).rejects.toThrow("unpersisted source");
  });
});
