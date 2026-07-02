// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNodeLite } from "@/features/tree/api";

const {
  mockUpdateNode,
  mockListAllNodes,
  mockSaveSceneContent,
  mockCreateNode,
  mockLoadSceneContent,
  mockLoadSceneContents,
  mockLoadTree,
  mockSetCharCount,
  mockUpsertSceneBodyMentions,
  mockCodexState,
  mockChatState,
  mockReadExternalFile,
  mockGetExternalFileMtime,
  mockRegisterMount,
  mockScanMount,
} = vi.hoisted(() => ({
  mockUpdateNode: vi.fn().mockResolvedValue(undefined),
  mockListAllNodes: vi.fn(),
  mockSaveSceneContent: vi.fn().mockResolvedValue({ placedBeatPreview: null }),
  mockCreateNode: vi.fn(),
  mockLoadSceneContent: vi.fn().mockResolvedValue("{}"),
  mockLoadSceneContents: vi.fn().mockResolvedValue(new Map<string, string>()),
  mockLoadTree: vi.fn().mockResolvedValue(undefined),
  mockSetCharCount: vi.fn(),
  mockUpsertSceneBodyMentions: vi.fn().mockResolvedValue(undefined),
  mockCodexState: {
    entries: [] as Array<{ id: string; name: string; type: string }>,
  },
  mockChatState: {
    activeSceneId: "",
    refreshContextLayers: vi.fn().mockResolvedValue(undefined),
  },
  mockReadExternalFile: vi.fn().mockResolvedValue("Updated.\n"),
  mockGetExternalFileMtime: vi
    .fn()
    .mockResolvedValue("2026-05-24T12:00:00.000Z"),
  mockRegisterMount: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
  mockScanMount: vi.fn().mockResolvedValue({ files: [], dirs: [] }),
}));

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    updateNode: mockUpdateNode,
    listAllNodes: mockListAllNodes,
    saveSceneContent: mockSaveSceneContent,
    createNode: mockCreateNode,
    loadSceneContent: mockLoadSceneContent,
    loadSceneContents: mockLoadSceneContents,
  };
});

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      loadTree: mockLoadTree,
      setCharCount: mockSetCharCount,
    }),
  },
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleSceneIndex: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      tabs: [],
      secondaryTabs: [],
      dirtyTabIds: new Set<string>(),
    }),
  },
}));

vi.mock("@/features/editor/linearEditorStore", () => ({
  useLinearEditorStore: {
    getState: () => ({ editorsById: {} }),
  },
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => mockCodexState,
  },
}));

vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: {
    getState: () => mockChatState,
  },
}));

vi.mock("@/features/editor/beat/bodyMentionApi", () => ({
  upsertSceneBodyMentions: mockUpsertSceneBodyMentions,
}));

vi.mock("./api", () => ({
  readExternalFile: (...args: unknown[]) => mockReadExternalFile(...args),
  getExternalFileMtime: (...args: unknown[]) =>
    mockGetExternalFileMtime(...args),
  unregisterMount: vi.fn().mockResolvedValue(undefined),
  registerMount: (...args: unknown[]) => mockRegisterMount(...args),
  scanMount: (...args: unknown[]) => mockScanMount(...args),
}));

vi.mock("sonner", () => ({
  toast: {
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
  _resetPendingArchives,
  _resetRecentDeletes,
} from "./mountManager";
import { useExternalRootStore } from "./externalRootStore";
import { buildMountFolderUri, buildSourceUri } from "./sourceUri";

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
    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: pmJson,
        charCount: expectedCharCount,
      }),
    );
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
    mockCodexState.entries = [];
    mockChatState.activeSceneId = "";
  });

  it("calls upsertSceneBodyMentions when codex entries exist", async () => {
    mockCodexState.entries = [{ id: "e1", name: "太郎", type: "character" }];

    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      "External text mentions 太郎.",
      "2026-05-24T12:00:00.000Z",
    );

    expect(mockUpsertSceneBodyMentions).toHaveBeenCalledTimes(1);
    expect(mockUpsertSceneBodyMentions).toHaveBeenCalledWith(
      "scene-1",
      expect.any(String),
      mockCodexState.entries,
    );
  });

  it("skips upsertSceneBodyMentions when codex entries are empty", async () => {
    mockCodexState.entries = [];

    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      "External text.",
      "2026-05-24T12:00:00.000Z",
    );

    expect(mockUpsertSceneBodyMentions).not.toHaveBeenCalled();
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
});

describe("initializeExternalMounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

describe("reload conflict queue", () => {
  beforeEach(() => {
    useExternalRootStore.setState({ conflicts: [] });
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
});
