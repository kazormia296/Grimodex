// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// DA-2b M (TASK: "拒否のとき … foreshadowStore … が以前と同じ"; DR-DA2B-R3):
// when the version writer refuses the adoption's revision
// (`REVISION_WRITE_REFUSED:not-found`, e.g. the scene was deleted meanwhile),
// `createRevision` answers null as it does for an unchanged body, and the
// adoption completes as before: the scene is saved, the candidate is removed,
// the success toast shows and no new error reaches the user.

const {
  mockCreateForeshadowSetup,
  mockSaveForeshadowAnchors,
  mockSaveSceneContent,
  invokeMock,
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
    command: vi.fn().mockReturnThis(),
    insertContentAt: vi.fn().mockReturnThis(),
    setTextSelection: vi.fn().mockReturnThis(),
    setMark: vi.fn().mockReturnThis(),
    run: vi.fn(),
  };
  mockEditor.chain.mockReturnValue(chainResult);

  return {
    mockCreateForeshadowSetup: vi.fn(),
    mockSaveForeshadowAnchors: vi.fn().mockResolvedValue([]),
    mockSaveSceneContent: vi.fn().mockResolvedValue(undefined),
    invokeMock: vi.fn(),
    mockLoadSetups: vi.fn().mockResolvedValue(undefined),
    mockEditor,
    chainResult,
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
  loadSceneContents: vi.fn().mockResolvedValue(new Map()),
}));

// The real version writer: its typed refusal reaches the adoption as it
// would from Native (DR-DA2B-R3).
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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

import { toast } from "sonner";
import { useForeshadowStore } from "./foreshadowStore";

function makeForeshadowItem(version = 0) {
  return {
    id: "f-1",
    projectId: "p-1",
    title: "test foreshadow",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: false,
    loadBearing: null,
    version,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    label: "planned" as const,
    setupCount: 0,
  };
}

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

describe("adoptInsertedNewSetup when the version writer refuses", () => {
  beforeEach(() => {
    mockCreateForeshadowSetup.mockClear();
    mockSaveSceneContent.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "revision_create") {
        throw new Error("REVISION_WRITE_REFUSED:not-found");
      }
      return undefined;
    });
    mockCreateForeshadowSetup.mockResolvedValue({
      setup: { id: "setup-ai-1" },
      foreshadow: makeForeshadowItem(1),
    });
    useForeshadowStore.setState({
      items: [makeForeshadowItem()],
      proposeResults: { "f-1": [INSERTED_NEW_CANDIDATE] },
      setupsByForeshadowId: {},
    });
  });

  it("completes the adoption with no new error", async () => {
    await useForeshadowStore.getState().adoptInsertedNewSetup("f-1", 0);

    // The refusal was the writer's answer, not a skipped request.
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "revision_create",
      ),
    ).toHaveLength(1);
    expect(mockSaveSceneContent).toHaveBeenCalledTimes(1);
    expect(useForeshadowStore.getState().proposeResults["f-1"]).toEqual([]);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
