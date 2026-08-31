// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TreeNodeLite } from "@/features/tree/api";

const {
  mockUpdateNode,
  mockListAllNodes,
  mockListExpiredArchivedNodeIds,
  mockDeleteNode,
  mockSaveSceneContent,
  mockCreateNode,
  mockLoadSceneContent,
  mockLoadSceneContents,
  mockLoadTree,
  mockSetCharCount,
  mockScheduleBodyMentionScan,
  mockChatState,
  mockReadExternalFile,
  mockGetExternalFileMtime,
  mockWriteExternalFile,
  mockRegisterMount,
  mockUnregisterMount,
  mockScanMount,
  mockCurrentProject,
  mockWorkspaceIdentity,
  mockTreeState,
  mockLoadTabState,
  mockInitAutoSave,
  mockRebaselineScenesAtTail,
} = vi.hoisted(() => ({
  mockUpdateNode: vi.fn().mockResolvedValue(undefined),
  mockListAllNodes: vi.fn(),
  mockListExpiredArchivedNodeIds: vi.fn().mockResolvedValue([]),
  mockDeleteNode: vi.fn().mockResolvedValue(undefined),
  mockSaveSceneContent: vi.fn().mockResolvedValue({
    placedBeatPreview: null,
    contentVersion: 7,
    contentUpdatedAt: "2026-05-24T12:00:01.000Z",
  }),
  mockCreateNode: vi.fn(),
  mockLoadSceneContent: vi.fn().mockResolvedValue("{}"),
  mockLoadSceneContents: vi.fn().mockResolvedValue(new Map<string, string>()),
  mockLoadTree: vi.fn().mockResolvedValue(undefined),
  mockSetCharCount: vi.fn(),
  mockScheduleBodyMentionScan: vi.fn(),
  mockChatState: {
    activeSceneId: "",
    refreshContextLayers: vi.fn().mockResolvedValue(undefined),
  },
  mockReadExternalFile: vi.fn().mockResolvedValue("Updated.\n"),
  mockGetExternalFileMtime: vi
    .fn()
    .mockResolvedValue("2026-05-24T12:00:00.000Z"),
  mockWriteExternalFile: vi.fn().mockResolvedValue(undefined),
  mockRegisterMount: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
  mockUnregisterMount: vi.fn().mockResolvedValue(undefined),
  mockScanMount: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
  mockCurrentProject: { id: "p1" },
  mockWorkspaceIdentity: {
    current: null as { path: string; openRevision: number } | null,
  },
  mockTreeState: {
    nodes: [] as TreeNodeLite[],
    projectId: "p1",
    hydratedProjectId: null as string | null,
    hydratedWorkspaceOpenRevision: null as number | null,
    setActiveScene: vi.fn(),
  },
  mockLoadTabState: vi.fn(),
  mockInitAutoSave: vi.fn(),
  mockRebaselineScenesAtTail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    updateNode: mockUpdateNode,
    listAllNodes: mockListAllNodes,
    listExpiredArchivedNodeIds: mockListExpiredArchivedNodeIds,
    deleteNode: mockDeleteNode,
    saveSceneContent: mockSaveSceneContent,
    createNode: mockCreateNode,
    loadSceneContent: mockLoadSceneContent,
    loadSceneContents: mockLoadSceneContents,
  };
});

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      ...mockTreeState,
      loadTree: mockLoadTree,
      reloadTreeOrThrow: mockLoadTree,
      setCharCount: mockSetCharCount,
    }),
  },
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleSceneIndex: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => mockCurrentProject.id,
}));

vi.mock("@/runtime/workspaceIdentity", () => ({
  getCurrentWorkspaceIdentity: () =>
    mockWorkspaceIdentity.current ? { ...mockWorkspaceIdentity.current } : null,
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      tabs: [],
      secondaryTabs: [],
      dirtyTabIds: new Set<string>(),
      loadTabState: mockLoadTabState,
      initAutoSave: mockInitAutoSave,
    }),
  },
}));

vi.mock("@/features/editor/linearEditorStore", () => ({
  useLinearEditorStore: {
    getState: () => ({ editorsById: {} }),
  },
}));

vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: {
    getState: () => mockChatState,
  },
}));

vi.mock("@/features/editor/persistSceneBody", () => ({
  scheduleBodyMentionScan: mockScheduleBodyMentionScan,
}));

vi.mock("@/features/timelapse/toggle", () => ({
  rebaselineScenesAtTail: mockRebaselineScenesAtTail,
}));

vi.mock("./api", () => ({
  readExternalFile: (...args: unknown[]) => mockReadExternalFile(...args),
  getExternalFileMtime: (...args: unknown[]) =>
    mockGetExternalFileMtime(...args),
  writeExternalFile: (...args: unknown[]) => mockWriteExternalFile(...args),
  unregisterMount: (...args: unknown[]) => mockUnregisterMount(...args),
  registerMount: (...args: unknown[]) => mockRegisterMount(...args),
  scanMount: (...args: unknown[]) => mockScanMount(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const mockGetProjectSetting = vi.fn().mockResolvedValue(null);
const mockSetProjectSetting = vi.fn().mockResolvedValue(undefined);
vi.mock("@/features/settings/api", () => ({
  getProjectSetting: (...args: unknown[]) => mockGetProjectSetting(...args),
  setProjectSetting: (...args: unknown[]) => mockSetProjectSetting(...args),
}));

import { contentHash } from "./contentHash";
import { markdownToPmJson } from "./markdownBridge";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import {
  addExternalMount,
  applyExternalContent,
  buildDbByUriMap,
  handleFileEvent,
  hashForDiskContent,
  hashForNodeContent,
  initializeExternalMounts,
  purgeExpiredArchives,
  resolveReloadConflict,
  settleExternalMountMutationsForSourceUris,
  _resetMountAuthorityForTests,
  _resetPendingArchives,
  _resetRecentDeletes,
} from "./mountManager";
import { useExternalRootStore } from "./externalRootStore";
import { buildMountFolderUri, buildSourceUri } from "./sourceUri";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { _resetWriteBackTimers, scheduleWriteBack } from "./writeBack";
import {
  createDocumentSaveSession,
  _resetDocumentSaveCoordinatorForTests,
  isExclusiveDocumentLeaseActive,
  runCoordinatedDocumentSave,
  StaleRetiredDocumentSaveError,
} from "@/features/editor/document/documentSaveCoordinator";
import { serializeSceneWrite } from "@/features/tree/pendingSceneWrites";
import { discardAutoSavesForDocument, useAutoSave } from "@/hooks/useAutoSave";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import {
  _resetTimelapseGenesisBarriersForTests,
  awaitTimelapseGenesisBarrier,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";

beforeEach(() => {
  _resetMountAuthorityForTests();
  _resetQuiescenceLeasesForTests();
  _resetTimelapseGenesisBarriersForTests();
  mockCurrentProject.id = "p1";
  publishCurrentProjectId("p1");
  mockWorkspaceIdentity.current = null;
  useExternalWriteStore.getState().clear();
});

afterEach(() => {
  _resetQuiescenceLeasesForTests();
});

// listAllNodes は H4 projection で content / unplacedBeatsDoc を返さない
// (TreeNodeLite)。本文が要る経路は loadSceneContent / loadSceneContents の
// mock から供給する。
function node(
  overrides: Partial<TreeNodeLite> & Pick<TreeNodeLite, "id" | "sourceUri">,
): TreeNodeLite {
  return {
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    version: 0,
    title: "Scene",
    synopsis: null,

    intent: null,
    sortOrder: "a0",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    chronicleStartTime: null,
    chronicleStartMinute: null,
    chronicleStartGranularity: "none",
    chronicleEndTime: null,
    chronicleEndMinute: null,
    chronicleEndGranularity: "none",
    chroniclePrecision: "exact",
    status: "outline",
    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    sourceMtime: null,
    archivedAt: null,
    contextMode: null,
    aliases: "[]",
    excludedAliases: "[]",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildDbByUriMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("archives duplicate active nodes that share the same sourceUri", async () => {
    const uri = "external-root://root-1/chapter/01.md";
    const map = await buildDbByUriMap(
      [
        node({
          id: "keep",
          sourceUri: uri,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        node({
          id: "dup",
          sourceUri: uri,
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
      "external-root://root-1/",
      "external-root://root-1/.mount",
    );

    expect(map.size).toBe(1);
    expect(map.get(uri)?.id).toBe("keep");
    expect(mockUpdateNode).toHaveBeenCalledTimes(1);
    expect(mockUpdateNode).toHaveBeenCalledWith(
      "dup",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );
  });

  it("excludes external folder nodes from file reconciliation", async () => {
    const folderUri = "external-root://root-1/chapter";
    const map = await buildDbByUriMap(
      [
        node({
          id: "chapter-folder",
          nodeType: "folder",
          sourceUri: folderUri,
        }),
      ],
      "external-root://root-1/",
      "external-root://root-1/.mount",
    );

    expect(map.has(folderUri)).toBe(false);
    expect(mockUpdateNode).not.toHaveBeenCalled();
  });
});

describe("hashForNodeContent", () => {
  it("does not match raw ProseMirror JSON against markdown hash", async () => {
    // 旧 hashForNode は node.content (PM JSON 文字列) を生 markdown と直接比較
    // していたため必ず外れていた。修正後は pmJsonToMarkdown 経由なので、JSON
    // 文字列の SHA-256 とは別の値になる。
    const markdown = "Different formats must not compare equal.";
    const pmJson = JSON.stringify(markdownToPmJson(markdown));
    const wrongHash = await contentHash(pmJson);

    const nodeHash = await hashForNodeContent(pmJson);

    expect(nodeHash).not.toBe(wrongHash);
  });
});

describe("hashForDiskContent vs hashForNodeContent", () => {
  // 同一内容のシーンが「disk の生 markdown」「DB に保存された PM JSON」のどちらを
  // 起点にしても同じ rename-detection ハッシュを返すことを実証する。
  // round-trip drift (空行縮退、末尾改行付加、リスト記法) を吸収できているかを
  // 多様なサンプルで確認するゴールデンテスト。
  const SAMPLES: Array<[string, string]> = [
    ["simple paragraph", "Hello world.\n"],
    ["bold + italic", "Hello **world** and *emph*.\n"],
    ["heading + paragraph", "# Title\n\nBody text.\n"],
    ["bullet list", "- one\n- two\n- three\n"],
    ["task list", "- [ ] todo\n- [x] done\n"],
    ["fenced code", "```ts\nconst x = 1;\n```\n"],
    ["multi-paragraph", "Para one.\n\nPara two.\n\nPara three.\n"],
    [
      "heading-body-list",
      "# Title\n\nBody **bold** text.\n\n- item 1\n- item 2\n",
    ],
    ["trailing newline absent", "Hello world."],
    ["multiple blank lines", "Para one.\n\n\nPara two.\n"],
  ];

  for (const [name, raw] of SAMPLES) {
    it(`disk and node hashes agree for: ${name}`, async () => {
      const pmJson = JSON.stringify(markdownToPmJson(raw));
      const nodeHash = await hashForNodeContent(pmJson);
      const diskHash = await hashForDiskContent(raw);
      expect(nodeHash).toBe(diskHash);
    });
  }

  it("yields different hashes for semantically different markdown", async () => {
    const a = await hashForDiskContent("Hello world.\n");
    const b = await hashForDiskContent("Goodbye world.\n");
    expect(a).not.toBe(b);
  });
});

describe("addExternalMount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectSetting.mockResolvedValue("[]");
    mockListAllNodes.mockResolvedValue([]);
    mockListExpiredArchivedNodeIds.mockResolvedValue([]);
    mockCreateNode.mockImplementation(async (params) =>
      node({
        id: params.id,
        sourceUri: params.sourceUri ?? "",
        nodeType: params.nodeType,
        title: params.title,
        parentId: params.parentId ?? null,
      }),
    );
  });

  it("persists non-zero charCount when mounting markdown files", async () => {
    const markdown = "Mount body text.";
    const pmJson = JSON.stringify(markdownToPmJson(markdown));
    const expectedCharCount = countSceneBodyCharsFromJson(pmJson);

    mockRegisterMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "chapter/01.md",
          content: markdown,
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: await contentHash(markdown),
        },
      ],
    });

    await addExternalMount("/mnt/novel", "Novel");

    expect(expectedCharCount).toBeGreaterThan(0);
    const sceneCall = mockCreateNode.mock.calls.find(
      ([params]) => params.nodeType === "scene",
    );
    expect(sceneCall?.[0]).toMatchObject({
      content: pmJson,
    });
    expect(sceneCall?.[1]).toEqual(
      expect.objectContaining({
        timelapseDocumentIdentity: expect.objectContaining({
          storage: "file",
        }),
      }),
    );
    expect(mockSaveSceneContent).not.toHaveBeenCalled();
  });

  it("persists non-zero charCount when reconciling an existing scene", async () => {
    const rootId =
      "root-sync" as `${string}-${string}-${string}-${string}-${string}`;
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(rootId);

    const markdown = "Resynced existing scene body.";
    const pmJson = JSON.stringify(markdownToPmJson(markdown));
    const expectedCharCount = countSceneBodyCharsFromJson(pmJson);
    const sceneUri = buildSourceUri(rootId, "chapter/01.md");

    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri(rootId),
        parentId: null,
      }),
      node({
        id: "scene-existing",
        sourceUri: sceneUri,
        charCount: 0,
        parentId: "mount-folder",
      }),
    ]);

    mockRegisterMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "chapter/01.md",
          content: markdown,
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: await contentHash(markdown),
        },
      ],
    });

    await addExternalMount("/mnt/novel", "Novel");

    expect(expectedCharCount).toBeGreaterThan(0);
    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-existing",
      expect.objectContaining({
        content: pmJson,
        charCount: expectedCharCount,
      }),
    );
    expect(mockCreateNode).not.toHaveBeenCalledWith(
      expect.objectContaining({ nodeType: "scene" }),
    );

    uuidSpy.mockRestore();
  });

  it("unregisters a native watcher when its add scope is superseded", async () => {
    let releaseRegister!: (scan: { files: []; dirs: [] }) => void;
    mockRegisterMount.mockImplementationOnce(
      () =>
        new Promise<{ files: []; dirs: [] }>((resolve) => {
          releaseRegister = resolve;
        }),
    );

    const adding = addExternalMount("/mnt/old", "Old");
    await vi.waitFor(() => expect(mockRegisterMount).toHaveBeenCalledTimes(1));
    const registeredRootId = mockRegisterMount.mock.calls[0][0] as string;

    mockCurrentProject.id = "p2";
    const switching = initializeExternalMounts({
      projectId: "p2",
      workspaceOpenRevision: 2,
    });
    releaseRegister({ files: [], dirs: [] });
    await Promise.all([adding, switching]);

    expect(mockUnregisterMount).toHaveBeenCalledWith(registeredRootId);
    expect(mockSetProjectSetting).not.toHaveBeenCalled();
    expect(mockCreateNode).not.toHaveBeenCalled();
  });
});

describe("applyExternalContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExternalRootStore.setState({ mutedWrites: [], conflicts: [] });
  });

  it("updates charCount and does not mute the path", async () => {
    const markdown = "External sync body text.";
    const mtime = "2026-05-24T12:00:00.000Z";

    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      markdown,
      mtime,
    );

    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        content: expect.any(String),
        charCount: markdown.length,
      }),
    );
    expect(mockUpdateNode).toHaveBeenCalledWith("scene-1", {
      sourceMtime: mtime,
    });
    expect(mockSetCharCount).toHaveBeenCalledWith("scene-1", markdown.length);
    expect(
      useExternalRootStore.getState().isMuted("root-1", "chapter/01.md"),
    ).toBe(false);
  });
});

describe("applyExternalContent — Codex body mention + chat refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExternalRootStore.setState({ mutedWrites: [], conflicts: [] });
    mockChatState.activeSceneId = "";
  });

  it("schedules the project-wide authoritative body mention scanner", async () => {
    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      "External text mentions 太郎.",
      "2026-05-24T12:00:00.000Z",
    );

    expect(mockScheduleBodyMentionScan).toHaveBeenCalledWith({
      projectId: "p1",
      sceneId: "scene-1",
      docJsonStr: expect.any(String),
      sceneVersion: 7,
      sceneUpdatedAt: "2026-05-24T12:00:01.000Z",
    });
  });

  it("calls refreshContextLayers when the synced scene is active in chat", async () => {
    mockChatState.activeSceneId = "scene-1";

    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      "External text.",
      "2026-05-24T12:00:00.000Z",
    );

    expect(mockChatState.refreshContextLayers).toHaveBeenCalledTimes(1);
  });

  it("skips refreshContextLayers when a different scene is active", async () => {
    mockChatState.activeSceneId = "scene-other";

    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      "External text.",
      "2026-05-24T12:00:00.000Z",
    );

    expect(mockChatState.refreshContextLayers).not.toHaveBeenCalled();
  });
});

describe("handleFileEvent snapshot barriers", () => {
  const selectedUri = buildSourceUri("root-1", "chapter/selected.md");

  beforeEach(() => {
    vi.clearAllMocks();
    useExternalRootStore.setState({
      roots: [{ id: "root-1", path: "/mnt", label: "M" }],
      mutedWrites: [],
      conflicts: [],
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "scene-selected",
        parentId: "mount-folder",
        sourceUri: selectedUri,
      }),
    ]);
    mockReadExternalFile.mockResolvedValue("external winner\n");
    mockGetExternalFileMtime.mockResolvedValue("2026-05-24T12:00:00.000Z");
    mockScanMount.mockReset().mockResolvedValue({
      dirs: [{ relPath: "chapter", name: "chapter" }],
      files: [
        {
          relPath: "chapter/selected.md",
          content: "external winner\n",
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "selected-hash",
        },
      ],
    });
  });

  it("queues watcher facts behind every lifecycle lease instead of dropping them", async () => {
    const lease = acquireQuiescenceLease("audit-export");
    const changed = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/selected.md",
      kind: "changed",
    });

    await Promise.resolve();
    expect(mockReadExternalFile).not.toHaveBeenCalled();

    lease.release();
    await changed;
    expect(mockReadExternalFile).toHaveBeenCalledWith(
      "root-1",
      "chapter/selected.md",
    );
  });

  it("makes snapshot settlement fail fast for a watcher fact observed during its lease", async () => {
    const lease = acquireQuiescenceLease("narrative-snapshot");
    const changed = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/selected.md",
      kind: "changed",
    });

    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).rejects.toThrow("changed during narrative snapshot");
    expect(mockReadExternalFile).not.toHaveBeenCalled();

    lease.release();
    await changed;
    expect(mockReadExternalFile).toHaveBeenCalledOnce();
  });

  it("permits same-root predecessors so a selected queued fact can settle", async () => {
    const firstUri = buildSourceUri("root-1", "other/first.md");
    const secondUri = buildSourceUri("root-1", "other/second.md");
    mockListAllNodes.mockResolvedValue([
      node({ id: "scene-first", sourceUri: firstUri }),
      node({ id: "scene-second", sourceUri: secondUri }),
      node({ id: "scene-selected", sourceUri: selectedUri }),
    ]);
    let releaseFirstRead!: (content: string) => void;
    mockReadExternalFile.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseFirstRead = resolve;
      }),
    );

    const first = handleFileEvent({
      rootId: "root-1",
      relPath: "other/first.md",
      kind: "changed",
    });
    await vi.waitFor(() => expect(mockReadExternalFile).toHaveBeenCalledOnce());
    const second = handleFileEvent({
      rootId: "root-1",
      relPath: "other/second.md",
      kind: "changed",
    });
    const selected = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/selected.md",
      kind: "changed",
    });
    const lease = acquireQuiescenceLease("narrative-snapshot");
    const settlement = settleExternalMountMutationsForSourceUris([selectedUri]);

    releaseFirstRead("first external winner\n");
    await Promise.all([first, second, selected, settlement]);
    expect(mockReadExternalFile).toHaveBeenCalledTimes(3);
    lease.release();
  });

  it("ignores a muted write-back echo before registering snapshot work", async () => {
    useExternalRootStore.getState().mutePath("root-1", "chapter/selected.md");
    const lease = acquireQuiescenceLease("narrative-snapshot");
    const echo = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/selected.md",
      kind: "changed",
    });

    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).resolves.toBeUndefined();
    lease.release();
    await echo;
    expect(mockReadExternalFile).not.toHaveBeenCalled();
  });

  it("rejects settlement while a selected source has an unresolved reload conflict", async () => {
    useExternalRootStore.getState().enqueueConflict({
      sceneId: "scene-selected",
      rootId: "root-1",
      relPath: "chapter/selected.md",
      incomingContent: "external winner\n",
      incomingMtime: "2026-05-24T12:00:00.000Z",
    });

    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).rejects.toThrow("unresolved conflict");
  });

  it("rejects a disk change still hidden in the main-process debounce queue", async () => {
    mockScanMount.mockResolvedValue({
      dirs: [{ relPath: "chapter", name: "chapter" }],
      files: [
        {
          relPath: "chapter/selected.md",
          content: "disk changed before renderer notification\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "changed-hash",
        },
      ],
    });

    await expect(
      settleExternalMountMutationsForSourceUris(
        [selectedUri],
        [
          {
            sourceUri: selectedUri,
            content: JSON.stringify(markdownToPmJson("persisted version\n")),
          },
        ],
      ),
    ).rejects.toThrow("differs from its persisted Scene");
  });

  it("rejects an unpersisted file discovered below the selected external folder", async () => {
    const folderUri = buildSourceUri("root-1", "chapter");
    mockScanMount.mockResolvedValue({
      dirs: [{ relPath: "chapter", name: "chapter" }],
      files: [
        {
          relPath: "chapter/selected.md",
          content: "external winner\n",
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "selected-hash",
        },
        {
          relPath: "chapter/new.md",
          content: "new file\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "new-hash",
        },
      ],
    });

    await expect(
      settleExternalMountMutationsForSourceUris(
        [folderUri, selectedUri],
        [
          {
            sourceUri: selectedUri,
            content: JSON.stringify(markdownToPmJson("external winner\n")),
          },
        ],
      ),
    ).rejects.toThrow("unpersisted source");
  });

  it("rejects an empty selected external folder removed without a watcher event", async () => {
    mockScanMount.mockResolvedValue({ dirs: [], files: [] });

    await expect(
      settleExternalMountMutationsForSourceUris(
        [buildSourceUri("root-1", "chapter")],
        [],
      ),
    ).rejects.toThrow("source path is missing");
  });

  it("does not accept a file in place of a selected external folder", async () => {
    mockScanMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "chapter",
          content: "not a directory\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "replacement-hash",
        },
      ],
    });

    await expect(
      settleExternalMountMutationsForSourceUris(
        [buildSourceUri("root-1", "chapter")],
        [],
      ),
    ).rejects.toThrow("source path is missing");
  });

  it("checks file identity without comparing content during preflight", async () => {
    await expect(
      settleExternalMountMutationsForSourceUris(
        [buildSourceUri("root-1", "chapter"), selectedUri],
        [{ sourceUri: selectedUri }],
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a malformed external source URI instead of dropping its fence", async () => {
    await expect(
      settleExternalMountMutationsForSourceUris(["unknown://selected.md"]),
    ).rejects.toThrow("source URI is invalid");
    expect(mockScanMount).not.toHaveBeenCalled();
  });

  it("rejects multiple persisted Scenes that claim the same external source", async () => {
    await expect(
      settleExternalMountMutationsForSourceUris(
        [selectedUri],
        [
          {
            sourceUri: selectedUri,
            content: JSON.stringify(markdownToPmJson("first\n")),
          },
          {
            sourceUri: selectedUri,
            content: JSON.stringify(markdownToPmJson("second\n")),
          },
        ],
      ),
    ).rejects.toThrow("share an external source");
  });

  it("tracks an added event as root-wide while reconciliation is in flight", async () => {
    const scan = {
      dirs: [],
      files: [
        {
          relPath: "chapter/selected.md",
          content: "selected\n",
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "selected-hash",
        },
        {
          relPath: "chapter/new.md",
          content: "new\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "new-hash",
        },
      ],
    };
    let releaseScan!: () => void;
    const pendingScan = new Promise<typeof scan>((resolve) => {
      releaseScan = () => resolve(scan);
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri("root-1"),
      }),
      node({
        id: "scene-selected",
        parentId: "mount-folder",
        sourceUri: selectedUri,
      }),
    ]);
    mockScanMount.mockReturnValueOnce(pendingScan);
    mockCreateNode.mockResolvedValue(
      node({
        id: "scene-new",
        parentId: "mount-folder",
        sourceUri: buildSourceUri("root-1", "chapter/new.md"),
      }),
    );
    const added = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/new.md",
      kind: "added",
    });
    await vi.waitFor(() => expect(mockScanMount).toHaveBeenCalledOnce());

    let settled = false;
    const drain = settleExternalMountMutationsForSourceUris([selectedUri]).then(
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseScan();
    await Promise.all([added, drain]);
    expect(settled).toBe(true);
  });

  it("keeps an added-event scan failure sticky for the whole root", async () => {
    mockScanMount.mockRejectedValueOnce(new Error("scan failed"));

    await expect(
      handleFileEvent({
        rootId: "root-1",
        relPath: "chapter/new.md",
        kind: "added",
      }),
    ).rejects.toThrow("scan failed");
    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).rejects.toThrow("previously failed");
  });

  it("recovers a root-wide scan failure through a successful rename reconciliation", async () => {
    const oldUri = buildSourceUri("root-1", "chapter/old.md");
    const newUri = buildSourceUri("root-1", "chapter/new.md");
    const movedContent = JSON.stringify(markdownToPmJson("Moved.\n"));
    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri("root-1"),
      }),
      node({ id: "scene-selected", sourceUri: selectedUri }),
      node({ id: "scene-old", sourceUri: oldUri }),
    ]);
    mockLoadSceneContent.mockResolvedValueOnce(movedContent);
    mockLoadSceneContents.mockResolvedValue(
      new Map([["scene-old", movedContent]]),
    );
    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/old.md",
      kind: "removed",
    });
    mockScanMount.mockRejectedValueOnce(new Error("scan failed"));
    await expect(
      handleFileEvent({
        rootId: "root-1",
        relPath: "chapter/new.md",
        kind: "added",
      }),
    ).rejects.toThrow("scan failed");
    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).rejects.toThrow("previously failed");

    mockScanMount.mockResolvedValueOnce({
      dirs: [{ relPath: "chapter", name: "chapter" }],
      files: [
        {
          relPath: "chapter/selected.md",
          content: "selected\n",
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "selected-hash",
        },
        {
          relPath: "chapter/new.md",
          content: "Moved.\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "moved-hash",
        },
      ],
    });
    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/new.md",
      kind: "added",
    });

    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).resolves.toBeUndefined();
    expect(mockUpdateNode).toHaveBeenCalledWith(
      "scene-old",
      expect.objectContaining({ sourceUri: newUri }),
    );
  });

  it("keeps a root-wide reconciliation failure sticky for another source path", async () => {
    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri("root-1"),
      }),
      node({
        id: "scene-selected",
        parentId: "mount-folder",
        sourceUri: selectedUri,
      }),
    ]);
    mockScanMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "chapter/selected.md",
          content: "selected\n",
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "selected-hash",
        },
        {
          relPath: "chapter/new.md",
          content: "new\n",
          mtime: "2026-05-24T12:00:01.000Z",
          contentHash: "new-hash",
        },
      ],
    });
    mockSaveSceneContent.mockRejectedValueOnce(
      new Error("root reconciliation failed"),
    );

    await expect(
      handleFileEvent({
        rootId: "root-1",
        relPath: "chapter/new.md",
        kind: "added",
      }),
    ).rejects.toThrow("root reconciliation failed");
    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).rejects.toThrow("previously failed");
  });

  it("clears a path-scoped rename failure without poisoning its whole root", async () => {
    const oldUri = buildSourceUri("root-1", "chapter/old.md");
    const newUri = buildSourceUri("root-1", "chapter/new.md");
    mockListAllNodes.mockResolvedValue([
      node({ id: "scene-old", sourceUri: oldUri }),
      node({ id: "scene-selected", sourceUri: selectedUri }),
    ]);
    mockUpdateNode.mockRejectedValueOnce(new Error("rename failed"));

    const renameEvent = {
      rootId: "root-1",
      oldRelPath: "chapter/old.md",
      relPath: "chapter/new.md",
      kind: "renamed" as const,
    };
    await expect(handleFileEvent(renameEvent)).rejects.toThrow("rename failed");
    await expect(
      settleExternalMountMutationsForSourceUris([selectedUri]),
    ).resolves.toBeUndefined();
    await expect(
      settleExternalMountMutationsForSourceUris([oldUri, newUri]),
    ).rejects.toThrow("previously failed");
    await expect(
      settleExternalMountMutationsForSourceUris([
        buildSourceUri("root-1", "chapter"),
      ]),
    ).rejects.toThrow("previously failed");

    await handleFileEvent(renameEvent);
    await expect(
      settleExternalMountMutationsForSourceUris([oldUri, newUri]),
    ).resolves.toBeUndefined();
  });

  it("lets a queued retry clear the failure emitted by the preceding event", async () => {
    const oldUri = buildSourceUri("root-1", "chapter/old.md");
    const newUri = buildSourceUri("root-1", "chapter/new.md");
    mockListAllNodes.mockResolvedValue([
      node({ id: "scene-old", sourceUri: oldUri }),
    ]);
    let rejectFirst!: (error: Error) => void;
    mockUpdateNode.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    const event = {
      rootId: "root-1",
      oldRelPath: "chapter/old.md",
      relPath: "chapter/new.md",
      kind: "renamed" as const,
    };

    const first = handleFileEvent(event);
    await vi.waitFor(() => expect(mockUpdateNode).toHaveBeenCalledOnce());
    const retry = handleFileEvent(event);
    rejectFirst(new Error("first rename failed"));

    await expect(first).rejects.toThrow("first rename failed");
    await retry;
    await expect(
      settleExternalMountMutationsForSourceUris([oldUri, newUri]),
    ).resolves.toBeUndefined();
  });

  it("does not carry a delayed failure into a newer mount authority", async () => {
    let releaseMetadataWrite!: () => void;
    const metadataWrite = new Promise<void>((resolve) => {
      releaseMetadataWrite = resolve;
    });
    mockUpdateNode.mockImplementationOnce(async () => {
      await metadataWrite;
      throw new Error("old authority failed late");
    });

    const oldEvent = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/selected.md",
      kind: "changed",
    });
    await vi.waitFor(() => expect(mockUpdateNode).toHaveBeenCalledOnce());

    mockCurrentProject.id = "p2";
    mockGetProjectSetting.mockResolvedValue(null);
    mockListAllNodes.mockResolvedValue([]);
    await initializeExternalMounts({
      projectId: "p2",
      workspaceOpenRevision: 2,
    });
    mockCurrentProject.id = "p1";
    const currentAuthorityDrain = settleExternalMountMutationsForSourceUris([
      selectedUri,
    ]);
    releaseMetadataWrite();
    await expect(oldEvent).rejects.toThrow("old authority failed late");
    await expect(currentAuthorityDrain).resolves.toBeUndefined();
  });
});

describe("handleFileEvent removed deferral", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPendingArchives();
    _resetRecentDeletes();
    useExternalRootStore.setState({
      roots: [{ id: "root-1", path: "/mnt", label: "M" }],
      mutedWrites: [],
      conflicts: [],
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "scene-1",
        sourceUri: "external-root://root-1/chapter/01.md",
      }),
    ]);
    // rename 検知ハッシュ用の本文は listAllNodes ではなく loadSceneContent 経由
    mockLoadSceneContent.mockResolvedValue(
      JSON.stringify(markdownToPmJson("Hello.\n")),
    );
  });

  it("does not archive immediately on removed; cancels when changed follows", async () => {
    vi.useFakeTimers();

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "removed",
    });

    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "changed",
    });

    await vi.advanceTimersByTimeAsync(6000);

    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );

    vi.useRealTimers();
  });

  it("lets a muted self-write echo cancel a pending external archive", async () => {
    vi.useFakeTimers();
    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "removed",
    });
    useExternalRootStore.getState().mutePath("root-1", "chapter/01.md");

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "added",
    });
    await vi.advanceTimersByTimeAsync(6000);

    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );
    vi.useRealTimers();
  });

  it("lets a muted re-materialization overtake neither an in-flight removal nor its archive", async () => {
    vi.useFakeTimers();
    let releaseContent!: (content: string) => void;
    mockLoadSceneContent.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseContent = resolve;
      }),
    );
    const removed = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "removed",
    });
    await vi.waitFor(() => expect(mockLoadSceneContent).toHaveBeenCalledOnce());
    useExternalRootStore.getState().mutePath("root-1", "chapter/01.md");
    const added = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "added",
    });

    await Promise.resolve();
    expect(mockScanMount).not.toHaveBeenCalled();
    releaseContent(JSON.stringify(markdownToPmJson("Hello.\n")));
    await Promise.all([removed, added]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );
    expect(mockScanMount).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("serializes a re-add behind an archive task whose timer already fired", async () => {
    vi.useFakeTimers();
    let releaseArchive!: () => void;
    mockUpdateNode.mockImplementationOnce(async (_id, patch) => {
      if (patch.archivedAt) {
        await new Promise<void>((resolve) => {
          releaseArchive = resolve;
        });
      }
    });
    mockScanMount.mockResolvedValueOnce({
      dirs: [],
      files: [
        {
          relPath: "chapter/01.md",
          content: "Hello.\n",
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: "hash",
        },
      ],
    });

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "removed",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() =>
      expect(mockUpdateNode).toHaveBeenCalledWith(
        "scene-1",
        expect.objectContaining({ archivedAt: expect.any(String) }),
      ),
    );

    const added = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "added",
    });
    await Promise.resolve();
    expect(mockScanMount).not.toHaveBeenCalled();

    releaseArchive();
    await added;
    expect(mockScanMount).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("archives after RENAME_WINDOW_MS elapses with no follow-up event", async () => {
    vi.useFakeTimers();

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "removed",
    });

    // Before timer fires: no archive yet.
    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );

    await vi.advanceTimersByTimeAsync(6000);

    // After RENAME_WINDOW_MS (5s) + buffer: softArchiveNode must have run.
    expect(mockUpdateNode).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );

    vi.useRealTimers();
  });
});

describe("handleFileEvent rename detection (removed → added)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPendingArchives();
    _resetRecentDeletes();
    useExternalRootStore.setState({
      roots: [{ id: "root-1", path: "/mnt", label: "M" }],
      mutedWrites: [],
      conflicts: [],
    });
  });

  it("loadSceneContent 経由の本文ハッシュで rename を検知し sourceUri を付け替える", async () => {
    const markdown = "Hello.\n";
    const oldUri = buildSourceUri("root-1", "chapter/01.md");
    const newUri = buildSourceUri("root-1", "chapter/02.md");
    mockListAllNodes.mockResolvedValue([
      node({ id: "scene-1", sourceUri: oldUri }),
    ]);
    // listAllNodes の行には content が無いので、削除イベント時のハッシュは
    // loadSceneContent 単発ロードから計算される。
    mockLoadSceneContent.mockResolvedValue(
      JSON.stringify(markdownToPmJson(markdown)),
    );
    mockScanMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "chapter/02.md",
          content: markdown,
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: await contentHash(markdown),
        },
      ],
    });

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "removed",
    });
    expect(mockLoadSceneContent).toHaveBeenCalledWith("scene-1");

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/02.md",
      kind: "added",
    });

    expect(mockUpdateNode).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ sourceUri: newUri }),
    );
    // rename として処理され、アーカイブはされない
    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );
  });

  it("moves an inferred rename into the persisted destination folder", async () => {
    const markdown = "Hello.\n";
    const oldUri = buildSourceUri("root-1", "old/01.md");
    const newUri = buildSourceUri("root-1", "selected/01.md");
    mockListAllNodes.mockResolvedValue([
      node({
        id: "old-folder",
        nodeType: "folder",
        sourceUri: buildSourceUri("root-1", "old"),
      }),
      node({
        id: "selected-folder",
        nodeType: "folder",
        sourceUri: buildSourceUri("root-1", "selected"),
      }),
      node({
        id: "scene-1",
        parentId: "old-folder",
        sourceUri: oldUri,
      }),
    ]);
    mockLoadSceneContent.mockResolvedValue(
      JSON.stringify(markdownToPmJson(markdown)),
    );
    mockScanMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "selected/01.md",
          content: markdown,
          mtime: "2026-05-24T12:00:00.000Z",
          contentHash: await contentHash(markdown),
        },
      ],
    });

    await handleFileEvent({
      rootId: "root-1",
      relPath: "old/01.md",
      kind: "removed",
    });
    await handleFileEvent({
      rootId: "root-1",
      relPath: "selected/01.md",
      kind: "added",
    });

    expect(mockUpdateNode).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        sourceUri: newUri,
        parentId: "selected-folder",
      }),
    );
  });
});

describe("initializeExternalMounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentProject.id = "p1";
    mockWorkspaceIdentity.current = null;
    Object.assign(mockTreeState, {
      nodes: [],
      projectId: "p1",
      hydratedProjectId: null,
      hydratedWorkspaceOpenRevision: null,
    });
    mockLoadTree.mockImplementation(
      async (projectId = "p1", workspaceOpenRevision?: number) => {
        Object.assign(mockTreeState, {
          projectId,
          hydratedProjectId: projectId,
          hydratedWorkspaceOpenRevision: workspaceOpenRevision ?? null,
        });
      },
    );
    mockLoadTabState.mockImplementation(
      async (
        _projectId: string,
        _validNodeIds: Set<string>,
        beforeApply?: (snapshot: {
          tabs: Array<{
            nodeId: string;
            isPreview: boolean;
            contentType: "scene";
          }>;
          activeTabId: string | null;
          secondaryTabs: [];
          secondaryActiveTabId: null;
          secondaryGroupOpen: false;
          activeGroupIndex: 0;
          splitDirection: "right";
          isLinearMode: false;
        }) => boolean | void,
      ) =>
        beforeApply?.({
          tabs: [],
          activeTabId: null,
          secondaryTabs: [],
          secondaryActiveTabId: null,
          secondaryGroupOpen: false,
          activeGroupIndex: 0,
          splitDirection: "right",
          isLinearMode: false,
        }) !== false,
    );
    mockGetProjectSetting.mockResolvedValue(null);
    mockListAllNodes.mockResolvedValue([]);
    useExternalRootStore.setState({
      roots: [],
      missingRoots: [],
      isInitialized: false,
      conflicts: [],
      mutedWrites: [],
    });
  });

  // 1840c8c7 regression: setInitialized(true) を loadTree より先に呼ぶと
  // ScenesPanel の useEffect([mountInitialized]) が nodes 空のまま発火し、
  // タブ復元の validNodeIds が空セットになって scene/note タブが全部消える。
  it("flips isInitialized only after loadTree resolves", async () => {
    const events: string[] = [];
    mockLoadTree.mockImplementation(async () => {
      events.push("loadTree:start");
      // microtask + macrotask の両方を渡って yield する
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      events.push("loadTree:end");
    });
    const unsub = useExternalRootStore.subscribe((s, prev) => {
      if (!prev.isInitialized && s.isInitialized) {
        events.push("setInitialized");
      }
    });

    await initializeExternalMounts();
    unsub();

    expect(events).toEqual([
      "loadTree:start",
      "loadTree:end",
      "setInitialized",
    ]);
  });

  // setInitialized が永久に立たないと ScenesPanel が loadTabState を呼ばず、
  // タブが永久に空のまま (loadTabState で空書き込みされ persisted state が
  // 破壊される副作用も含む)。settings 読み込みの例外でも finally に到達する。
  it("sets isInitialized=true even when loadRootsFromSettings throws", async () => {
    mockGetProjectSetting.mockRejectedValueOnce(new Error("boom"));

    await initializeExternalMounts();

    expect(useExternalRootStore.getState().isInitialized).toBe(true);
  });

  it("sets isInitialized=true even when loadTree throws", async () => {
    mockLoadTree.mockRejectedValueOnce(new Error("loadTree boom"));

    await initializeExternalMounts();

    expect(useExternalRootStore.getState().isInitialized).toBe(true);
  });

  it("forwards the target Workspace revision to the final tree reload", async () => {
    await initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 27,
    });

    expect(mockLoadTree).toHaveBeenCalledWith("p1", 27);
  });

  it("does not rewrite or rebaseline an unchanged normalized boot body", async () => {
    const root = { id: "root-1", path: "/mnt", label: "M" };
    const sourceUri = buildSourceUri(root.id, "same.md");
    const persisted = JSON.stringify(markdownToPmJson("same\n"));
    mockGetProjectSetting.mockResolvedValue(JSON.stringify([root]));
    mockRegisterMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "same.md",
          content: "same\n",
          mtime: "2026-08-31T01:00:00.000Z",
          contentHash: "raw-hash",
        },
      ],
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri(root.id),
      }),
      node({ id: "scene-1", parentId: "mount-folder", sourceUri }),
    ]);
    mockLoadSceneContents.mockResolvedValue(new Map([["scene-1", persisted]]));

    await initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 1,
    });

    expect(mockSaveSceneContent).not.toHaveBeenCalled();
    expect(mockRebaselineScenesAtTail).not.toHaveBeenCalled();
    expect(mockUpdateNode).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        sourceMtime: "2026-08-31T01:00:00.000Z",
      }),
    );
  });

  it("orders an offline body change after genesis and rebaselines after both Native writes", async () => {
    const root = { id: "root-1", path: "/mnt", label: "M" };
    const sourceUri = buildSourceUri(root.id, "changed.md");
    mockGetProjectSetting.mockResolvedValue(JSON.stringify([root]));
    mockRegisterMount.mockResolvedValue({
      dirs: [],
      files: [
        {
          relPath: "changed.md",
          content: "disk winner\n",
          mtime: "2026-08-31T02:00:00.000Z",
          contentHash: "raw-hash",
        },
      ],
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri(root.id),
      }),
      node({ id: "scene-1", parentId: "mount-folder", sourceUri }),
    ]);
    mockLoadSceneContents.mockResolvedValue(
      new Map([["scene-1", JSON.stringify(markdownToPmJson("stale db\n"))]]),
    );
    const genesis = beginTimelapseGenesisBarrier("p1");
    mockSaveSceneContent.mockImplementationOnce(async () => {
      await awaitTimelapseGenesisBarrier("p1");
      return {
        placedBeatPreview: null,
        contentVersion: 8,
        contentUpdatedAt: "2026-08-31T02:00:00.000Z",
      };
    });

    const initialization = initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 2,
    });
    await vi.waitFor(() => expect(mockSaveSceneContent).toHaveBeenCalledOnce());
    expect(mockUpdateNode).not.toHaveBeenCalledWith(
      "scene-1",
      expect.anything(),
    );
    expect(mockRebaselineScenesAtTail).not.toHaveBeenCalled();

    genesis.complete();
    await initialization;

    expect(mockSaveSceneContent.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateNode.mock.invocationCallOrder[0]!,
    );
    expect(mockUpdateNode.mock.invocationCallOrder[0]).toBeLessThan(
      mockRebaselineScenesAtTail.mock.invocationCallOrder[0]!,
    );
    expect(mockRebaselineScenesAtTail).toHaveBeenCalledWith("p1", ["scene-1"]);
  });

  it("archives external folders that disappeared from the latest directory scan", async () => {
    const root = { id: "root-1", path: "/mnt", label: "M" };
    mockGetProjectSetting.mockResolvedValue(JSON.stringify([root]));
    mockScanMount.mockResolvedValue({ dirs: [], files: [] });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "mount-folder",
        nodeType: "folder",
        sourceUri: buildMountFolderUri(root.id),
      }),
      node({
        id: "missing-folder",
        nodeType: "folder",
        parentId: "mount-folder",
        sourceUri: buildSourceUri(root.id, "removed"),
      }),
    ]);

    await initializeExternalMounts();

    expect(mockUpdateNode).toHaveBeenCalledWith(
      "missing-folder",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );
  });

  it("reuses the scoped critical Tree when mounts and archive purge made no changes", async () => {
    Object.assign(mockTreeState, {
      nodes: [
        node({ id: "scene-1", nodeType: "scene", sourceUri: null }),
        node({ id: "note-1", nodeType: "note", sourceUri: null }),
      ],
      projectId: "p1",
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: 27,
    });

    await initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 27,
    });

    expect(mockLoadTree).not.toHaveBeenCalled();
    expect(mockLoadTabState).toHaveBeenCalledWith(
      "p1",
      new Set(["scene-1", "note-1"]),
      expect.any(Function),
    );
  });

  it("purges only the targeted expired archive IDs", async () => {
    mockListExpiredArchivedNodeIds.mockResolvedValue([
      "expired-1",
      "expired-2",
    ]);

    await expect(purgeExpiredArchives("p1")).resolves.toBe(2);

    expect(mockListAllNodes).not.toHaveBeenCalled();
    expect(mockDeleteNode.mock.calls).toEqual([["expired-1"], ["expired-2"]]);
  });

  it("restores tabs only after the scoped tree hydration succeeds", async () => {
    mockTreeState.nodes = [
      node({ id: "scene-1", sourceUri: null, nodeType: "scene" }),
      node({ id: "note-1", sourceUri: null, nodeType: "note" }),
      node({ id: "folder-1", sourceUri: null, nodeType: "folder" }),
    ];
    mockLoadTabState.mockImplementationOnce(
      async (_projectId, _validNodeIds, beforeApply) =>
        beforeApply?.({
          tabs: [
            {
              nodeId: "scene-1",
              isPreview: false,
              contentType: "scene",
            },
          ],
          activeTabId: "scene-1",
          secondaryTabs: [],
          secondaryActiveTabId: null,
          secondaryGroupOpen: false,
          activeGroupIndex: 0,
          splitDirection: "right",
          isLinearMode: false,
        }) !== false,
    );

    await initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 27,
    });

    expect(mockLoadTabState).toHaveBeenCalledWith(
      "p1",
      new Set(["scene-1", "note-1"]),
      expect.any(Function),
    );
    expect(mockTreeState.setActiveScene).toHaveBeenCalledWith("scene-1");
    expect(mockInitAutoSave).toHaveBeenCalledWith("p1");
  });

  it("does not restore a stale project after a queued project switch", async () => {
    const initializedProjects: Array<string | null> = [];
    const unsubscribe = useExternalRootStore.subscribe((state, previous) => {
      if (!previous.isInitialized && state.isInitialized) {
        initializedProjects.push(mockTreeState.hydratedProjectId);
      }
    });
    let releaseFirstTreeLoad!: () => void;
    const firstTreeLoad = new Promise<void>((resolve) => {
      releaseFirstTreeLoad = resolve;
    });
    mockLoadTree
      .mockImplementationOnce(async (projectId, workspaceOpenRevision) => {
        await firstTreeLoad;
        Object.assign(mockTreeState, {
          nodes: [node({ id: "p1-scene", sourceUri: null })],
          projectId,
          hydratedProjectId: projectId,
          hydratedWorkspaceOpenRevision: workspaceOpenRevision,
        });
      })
      .mockImplementationOnce(async (projectId, workspaceOpenRevision) => {
        Object.assign(mockTreeState, {
          nodes: [node({ id: "p2-scene", sourceUri: null, projectId: "p2" })],
          projectId,
          hydratedProjectId: projectId,
          hydratedWorkspaceOpenRevision: workspaceOpenRevision,
        });
      });

    const oldInit = initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 1,
    });
    await vi.waitFor(() => expect(mockLoadTree).toHaveBeenCalledTimes(1));
    mockCurrentProject.id = "p2";
    const currentInit = initializeExternalMounts({
      projectId: "p2",
      workspaceOpenRevision: 2,
    });
    releaseFirstTreeLoad();
    await Promise.all([oldInit, currentInit]);
    unsubscribe();

    expect(initializedProjects).toEqual(["p2"]);
    expect(mockLoadTabState).toHaveBeenCalledTimes(1);
    expect(mockLoadTabState).toHaveBeenCalledWith(
      "p2",
      new Set(["p2-scene"]),
      expect.any(Function),
    );
    expect(mockInitAutoSave).toHaveBeenCalledWith("p2");
  });

  it("cancels stale reconcile mutations when the workspace switches during register", async () => {
    let releaseOldScan!: (scan: { files: []; dirs: [] }) => void;
    const oldScan = new Promise<{ files: []; dirs: [] }>((resolve) => {
      releaseOldScan = resolve;
    });
    mockGetProjectSetting.mockImplementation(async (projectId, key) => {
      if (projectId === "p1" && key === "external.roots") {
        return JSON.stringify([
          { id: "root-p1", path: "/old-root", label: "Old root" },
        ]);
      }
      return null;
    });
    mockRegisterMount.mockImplementationOnce(() => oldScan);

    const oldInit = initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 1,
    });
    await vi.waitFor(() => expect(mockRegisterMount).toHaveBeenCalledTimes(1));

    mockCurrentProject.id = "p2";
    const currentInit = initializeExternalMounts({
      projectId: "p2",
      workspaceOpenRevision: 2,
    });
    releaseOldScan({ files: [], dirs: [] });
    await Promise.all([oldInit, currentInit]);

    expect(mockCreateNode).not.toHaveBeenCalled();
    expect(mockUpdateNode).not.toHaveBeenCalled();
    expect(mockSaveSceneContent).not.toHaveBeenCalled();
    expect(mockUnregisterMount).toHaveBeenCalledWith("root-p1");
  });

  it("rejects an unscoped init when the captured workspace revision changes", async () => {
    let releaseTreeLoad!: () => void;
    const treeLoad = new Promise<void>((resolve) => {
      releaseTreeLoad = resolve;
    });
    mockWorkspaceIdentity.current = {
      path: "/workspace-a.grimodex",
      openRevision: 1,
    };
    mockLoadTree.mockImplementationOnce(
      async (projectId, workspaceOpenRevision) => {
        await treeLoad;
        Object.assign(mockTreeState, {
          nodes: [node({ id: "scene-1", sourceUri: null })],
          projectId,
          hydratedProjectId: projectId,
          hydratedWorkspaceOpenRevision: workspaceOpenRevision,
        });
      },
    );

    const initialization = initializeExternalMounts();
    await vi.waitFor(() => expect(mockLoadTree).toHaveBeenCalledTimes(1));
    mockWorkspaceIdentity.current = {
      path: "/workspace-a.grimodex",
      openRevision: 2,
    };
    releaseTreeLoad();
    await initialization;

    expect(mockLoadTree).toHaveBeenCalledWith("p1", 1);
    expect(mockLoadTabState).not.toHaveBeenCalled();
    expect(mockInitAutoSave).not.toHaveBeenCalled();
  });

  it("cancels a deferred archive before a new workspace can receive it", async () => {
    vi.useFakeTimers();
    useEditorSessionStore.getState().resetForProject();
    useExternalRootStore.setState({
      roots: [{ id: "root-1", path: "/old-root", label: "Old root" }],
      missingRoots: [],
      isInitialized: true,
      conflicts: [],
      mutedWrites: [],
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "old-scene",
        sourceUri: buildSourceUri("root-1", "scene.md"),
      }),
    ]);
    mockLoadSceneContent.mockResolvedValueOnce("{}");

    await handleFileEvent({
      rootId: "root-1",
      kind: "removed",
      relPath: "scene.md",
    });

    mockCurrentProject.id = "p2";
    mockListAllNodes.mockResolvedValue([]);
    await initializeExternalMounts({
      projectId: "p2",
      workspaceOpenRevision: 2,
    });
    const loadCallsAfterSwitch = mockLoadTree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);

    expect(mockUpdateNode).not.toHaveBeenCalled();
    expect(mockLoadTree).toHaveBeenCalledTimes(loadCallsAfterSwitch);
    vi.useRealTimers();
  });

  it("does not let an unscoped init absorb a queued target-revision init", async () => {
    let releaseFirstTreeLoad!: () => void;
    const firstTreeLoad = new Promise<void>((resolve) => {
      releaseFirstTreeLoad = resolve;
    });
    mockLoadTree
      .mockImplementationOnce(() => firstTreeLoad)
      .mockResolvedValue(undefined);

    const unscoped = initializeExternalMounts();
    await vi.waitFor(() => expect(mockLoadTree).toHaveBeenCalledTimes(1));
    const targetRevision = initializeExternalMounts({
      projectId: "p1",
      workspaceOpenRevision: 28,
    });
    releaseFirstTreeLoad();
    await Promise.all([unscoped, targetRevision]);

    expect(mockLoadTree.mock.calls).toEqual([
      ["p1", undefined],
      ["p1", 28],
    ]);
  });
});

describe("reload conflict queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWriteBackTimers();
    _resetDocumentSaveCoordinatorForTests();
    useEditorSessionStore.getState().resetForProject();
    useExternalRootStore.setState({
      roots: [{ id: "root-1", path: "/mnt", label: "M" }],
      mutedWrites: [],
      conflicts: [],
    });
    mockListAllNodes.mockResolvedValue([
      node({
        id: "scene-1",
        sourceUri: "external-root://root-1/chapter/01.md",
      }),
    ]);
    mockReadExternalFile.mockResolvedValue("external winner\n");
    mockGetExternalFileMtime.mockResolvedValue("2026-05-24T12:00:00.000Z");
    mockWriteExternalFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    _resetWriteBackTimers();
    _resetDocumentSaveCoordinatorForTests();
  });

  it("queues multiple conflicts instead of overwriting", () => {
    const first = {
      sceneId: "s1",
      rootId: "r1",
      relPath: "a.md",
      incomingContent: "a",
      incomingMtime: "2026-01-01T00:00:00.000Z",
    };
    const second = {
      sceneId: "s2",
      rootId: "r1",
      relPath: "b.md",
      incomingContent: "b",
      incomingMtime: "2026-01-02T00:00:00.000Z",
    };

    useExternalRootStore.getState().enqueueConflict(first);
    useExternalRootStore.getState().enqueueConflict(second);

    expect(useExternalRootStore.getState().conflicts).toEqual([first, second]);

    useExternalRootStore.getState().shiftConflict();

    expect(useExternalRootStore.getState().conflicts).toEqual([second]);
  });

  it("queues an external change behind a scheduled OUT write and reload cancels the stale draft", async () => {
    scheduleWriteBack(
      "scene-1",
      "external-root://root-1/chapter/01.md",
      JSON.stringify(markdownToPmJson("stale local\n")),
    );

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "changed",
    });

    expect(useExternalRootStore.getState().conflicts).toEqual([
      expect.objectContaining({
        sceneId: "scene-1",
        incomingContent: "external winner\n",
      }),
    ]);
    expect(mockSaveSceneContent).not.toHaveBeenCalled();
    expect(mockWriteExternalFile).not.toHaveBeenCalled();

    await resolveReloadConflict("reload");

    expect(mockWriteExternalFile).toHaveBeenCalledOnce();
    expect(mockWriteExternalFile).toHaveBeenCalledWith(
      "root-1",
      "chapter/01.md",
      "external winner\n",
    );
    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        content: JSON.stringify(markdownToPmJson("external winner\n")),
      }),
    );
    expect(useExternalRootStore.getState().conflicts).toEqual([]);
  });

  it("queues an external change while a failed unmounted AutoSave retains the local draft", async () => {
    const documentKey = {
      kind: "tree",
      id: "scene-1",
      storage: "file",
    } as const;
    const retiredSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const hook = renderHook(() =>
      useAutoSave(retiredSave, 0, { documentKey: () => documentKey }),
    );

    act(() => {
      hook.result.current.schedule();
    });
    hook.unmount();
    await vi.waitFor(() => expect(retiredSave).toHaveBeenCalledOnce());

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "changed",
    });

    expect(mockSaveSceneContent).not.toHaveBeenCalled();
    expect(useExternalRootStore.getState().conflicts).toEqual([
      expect.objectContaining({
        sceneId: "scene-1",
        incomingContent: "external winner\n",
      }),
    ]);

    discardAutoSavesForDocument(documentKey);
  });

  it("rechecks after the initial clean snapshot and preserves an edit that appears while a prior scene write settles", async () => {
    let releasePriorWrite!: () => void;
    const priorWriteGate = new Promise<void>((resolve) => {
      releasePriorWrite = resolve;
    });
    const priorWrite = serializeSceneWrite("scene-1", () => priorWriteGate);
    const documentKey = {
      kind: "tree",
      id: "scene-1",
      storage: "file",
    } as const;

    const changed = handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "changed",
    });
    await vi.waitFor(() =>
      expect(isExclusiveDocumentLeaseActive(documentKey)).toBe(true),
    );

    // The watcher already observed a clean document, but a transaction that
    // was admitted just before the synchronous lease can publish dirty while
    // the older DB chain is still settling.
    useEditorSessionStore.getState().setDocumentDirty(documentKey, true);
    releasePriorWrite();
    await Promise.all([priorWrite, changed]);

    expect(mockSaveSceneContent).not.toHaveBeenCalled();
    expect(useExternalRootStore.getState().conflicts).toEqual([
      expect.objectContaining({
        sceneId: "scene-1",
        incomingContent: "external winner\n",
      }),
    ]);
  });

  it("reload re-cancels an OUT draft scheduled by a local save after the first cancellation", async () => {
    const documentKey = {
      kind: "tree",
      id: "scene-1",
      storage: "file",
    } as const;
    let releaseLocalSave!: () => void;
    const localSaveGate = new Promise<void>((resolve) => {
      releaseLocalSave = resolve;
    });
    const stalePmJson = JSON.stringify(markdownToPmJson("stale local\n"));
    const localSave = runCoordinatedDocumentSave(documentKey, async () => {
      await localSaveGate;
      scheduleWriteBack(
        "scene-1",
        "external-root://root-1/chapter/01.md",
        stalePmJson,
      );
    });
    useExternalRootStore.getState().enqueueConflict({
      sceneId: "scene-1",
      rootId: "root-1",
      relPath: "chapter/01.md",
      incomingContent: "external winner\n",
      incomingMtime: "2026-05-24T12:00:00.000Z",
    });

    const reload = resolveReloadConflict("reload");
    expect(isExclusiveDocumentLeaseActive(documentKey)).toBe(true);
    releaseLocalSave();
    await Promise.all([localSave, reload]);

    expect(mockWriteExternalFile).toHaveBeenCalledOnce();
    expect(mockWriteExternalFile).toHaveBeenCalledWith(
      "root-1",
      "chapter/01.md",
      "external winner\n",
    );
    expect(useExternalRootStore.getState().conflicts).toEqual([]);
  });

  it("publishes the exact-document reload and foreign revision before automatic-import side effects", async () => {
    const documentKey = {
      kind: "tree",
      id: "scene-1",
      storage: "file",
    } as const;
    const detached = createDocumentSaveSession();
    detached.retire(documentKey);
    mockUpdateNode.mockImplementationOnce(async () => {
      expect(
        useExternalWriteStore.getState().reloadNonce[
          externalDocumentStateKey(documentKey)
        ],
      ).toBe(1);
      throw new Error("metadata update failed");
    });

    await expect(
      handleFileEvent({
        rootId: "root-1",
        relPath: "chapter/01.md",
        kind: "changed",
      }),
    ).rejects.toThrow("metadata update failed");
    const sourceUri = buildSourceUri("root-1", "chapter/01.md");
    await expect(
      settleExternalMountMutationsForSourceUris([sourceUri]),
    ).rejects.toThrow("previously failed");

    expect(
      useExternalWriteStore.getState().reloadNonce[
        externalDocumentStateKey(documentKey)
      ],
    ).toBe(1);
    const staleRetry = vi.fn(async () => true);
    await expect(
      runCoordinatedDocumentSave(documentKey, staleRetry, {
        session: detached,
        didPersist: Boolean,
      }),
    ).rejects.toBeInstanceOf(StaleRetiredDocumentSaveError);
    expect(staleRetry).not.toHaveBeenCalled();

    await handleFileEvent({
      rootId: "root-1",
      relPath: "chapter/01.md",
      kind: "changed",
    });
    await expect(
      settleExternalMountMutationsForSourceUris([sourceUri]),
    ).resolves.toBeUndefined();
  });

  it("publishes the chosen disk version before explicit Reload side effects", async () => {
    const documentKey = {
      kind: "tree",
      id: "scene-1",
      storage: "file",
    } as const;
    const detached = createDocumentSaveSession();
    detached.retire(documentKey);
    useExternalRootStore.getState().enqueueConflict({
      sceneId: "scene-1",
      rootId: "root-1",
      relPath: "chapter/01.md",
      incomingContent: "external winner\n",
      incomingMtime: "2026-05-24T12:00:00.000Z",
    });
    mockUpdateNode.mockImplementationOnce(async () => {
      expect(
        useExternalWriteStore.getState().reloadNonce[
          externalDocumentStateKey(documentKey)
        ],
      ).toBe(1);
      throw new Error("metadata update failed");
    });

    await expect(resolveReloadConflict("reload")).rejects.toThrow(
      "metadata update failed",
    );

    expect(
      useExternalWriteStore.getState().reloadNonce[
        externalDocumentStateKey(documentKey)
      ],
    ).toBe(1);
    const staleRetry = vi.fn(async () => true);
    await expect(
      runCoordinatedDocumentSave(documentKey, staleRetry, {
        session: detached,
        didPersist: Boolean,
      }),
    ).rejects.toBeInstanceOf(StaleRetiredDocumentSaveError);
    expect(staleRetry).not.toHaveBeenCalled();
  });
});
