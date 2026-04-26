// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCreateForeshadowSetup,
  mockSaveForeshadowAnchors,
  mockSaveSceneContent,
  mockCreateRevision,
  mockLoadSetups,
  mockEditor,
} = vi.hoisted(() => {
  const mockEditor = {
    state: {
      selection: { from: 10 },
      doc: { type: "doc" },
    },
    chain: vi.fn(),
    getJSON: vi.fn().mockReturnValue({ type: "doc", content: [] }),
  };
  const chainResult = {
    insertContentAt: vi.fn().mockReturnThis(),
    setTextSelection: vi.fn().mockReturnThis(),
    setMark: vi.fn().mockReturnThis(),
    run: vi.fn(),
  };
  mockEditor.chain.mockReturnValue(chainResult);

  return {
    mockCreateForeshadowSetup: vi.fn().mockResolvedValue({ id: "setup-ai-1" }),
    mockSaveForeshadowAnchors: vi.fn().mockResolvedValue(undefined),
    mockSaveSceneContent: vi.fn().mockResolvedValue(undefined),
    mockCreateRevision: vi.fn().mockResolvedValue(null),
    mockLoadSetups: vi.fn().mockResolvedValue(undefined),
    mockEditor,
  };
});

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    createForeshadowSetup: mockCreateForeshadowSetup,
    listForeshadows: vi.fn().mockResolvedValue([]),
    listSetups: vi.fn().mockResolvedValue([]),
    auditChapter: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./saveAnchors", () => ({
  saveForeshadowAnchors: mockSaveForeshadowAnchors,
}));

vi.mock("@/features/tree/api", () => ({
  saveSceneContent: mockSaveSceneContent,
  loadSceneContent: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/features/revision/api", () => ({
  createRevision: mockCreateRevision,
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: {
    getState: () => ({ editor: mockEditor }),
  },
}));

vi.mock("@/features/tree/store", () => ({
  useSceneStore: {
    getState: () => ({
      activeSceneId: "scene-ai",
      nodes: [],
    }),
  },
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({
  foreshadowSetups: {},
  foreshadows: {},
}));
vi.mock("drizzle-orm", () => ({
  inArray: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  max: vi.fn(),
}));

import { useForeshadowStore } from "./foreshadowStore";

const INSERTED_NEW_CANDIDATE = {
  sceneId: "scene-ai",
  kind: "inserted_new" as const,
  suggestedText: "井戸の底に何かが沈んでいた。",
  rationale: "後の展開への伏線",
  predictedStrength: "subtle" as const,
  existingExcerpt: undefined,
  fromPosHint: undefined,
  toPosHint: undefined,
  suggestedInsertionPoint: "段落の末尾",
};

describe("adoptInsertedNewSetup", () => {
  beforeEach(() => {
    mockCreateForeshadowSetup.mockClear();
    mockSaveForeshadowAnchors.mockClear();
    mockSaveSceneContent.mockClear();
    mockCreateRevision.mockClear();
    mockLoadSetups.mockClear();

    useForeshadowStore.setState({
      items: [],
      proposeResults: {
        "f-1": [INSERTED_NEW_CANDIDATE],
      },
      setupsByForeshadowId: {},
    });
  });

  it("createForeshadowSetup を AI メタデータ付きで呼ぶ", async () => {
    await useForeshadowStore.getState().adoptInsertedNewSetup("f-1", 0);

    expect(mockCreateForeshadowSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        foreshadowId: "f-1",
        sceneId: "scene-ai",
        kind: "inserted_new",
        attribution: "ai",
        aiRationale: "後の展開への伏線",
        strength: "subtle",
      }),
    );
  });

  it("saveForeshadowAnchors を呼んでシーンを保存する", async () => {
    await useForeshadowStore.getState().adoptInsertedNewSetup("f-1", 0);

    expect(mockSaveForeshadowAnchors).toHaveBeenCalledWith(
      "scene-ai",
      expect.anything(),
    );
    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-ai",
      expect.any(String),
    );
  });

  it("createRevision を 1 回だけ呼ぶ", async () => {
    await useForeshadowStore.getState().adoptInsertedNewSetup("f-1", 0);

    expect(mockCreateRevision).toHaveBeenCalledTimes(1);
    expect(mockCreateRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "scene",
        entityId: "scene-ai",
        snapshotType: "auto",
      }),
    );
  });

  it("採用後に候補リストから除去する", async () => {
    await useForeshadowStore.getState().adoptInsertedNewSetup("f-1", 0);

    const results = useForeshadowStore.getState().proposeResults["f-1"] ?? [];
    expect(results).toHaveLength(0);
  });

  it("wrong sceneId のときは何も実行しない", async () => {
    useForeshadowStore.setState({
      proposeResults: {
        "f-1": [{ ...INSERTED_NEW_CANDIDATE, sceneId: "scene-other" }],
      },
    });

    await useForeshadowStore.getState().adoptInsertedNewSetup("f-1", 0);

    expect(mockCreateForeshadowSetup).not.toHaveBeenCalled();
    expect(mockCreateRevision).not.toHaveBeenCalled();
  });
});
