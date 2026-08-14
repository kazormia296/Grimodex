// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachNativeMutationMetadata } from "@/lib/nativeMutationMetadata";

const {
  mockUpdateForeshadow,
  mockListForeshadowsWithLabels,
  mockUnsetPayoffMarks,
  mockSaveSceneContent,
  editorRef,
} = vi.hoisted(() => {
  const mockEditor = {
    state: {
      tr: {},
      doc: { type: "doc" },
    },
    view: { dispatch: vi.fn() },
    getJSON: vi.fn().mockReturnValue({ type: "doc", content: [] }),
  };

  // Mutable ref so individual tests can set editor to null
  const editorRef = { current: mockEditor as typeof mockEditor | null };

  return {
    mockUpdateForeshadow: vi.fn(),
    mockListForeshadowsWithLabels: vi.fn().mockResolvedValue({
      items: [],
      sceneInfoBySceneId: {},
    }),
    mockUnsetPayoffMarks: vi.fn(),
    mockSaveSceneContent: vi.fn().mockResolvedValue(undefined),
    editorRef,
  };
});

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    updateForeshadow: mockUpdateForeshadow,
    listForeshadowsWithLabels: mockListForeshadowsWithLabels,
    listSetups: vi.fn().mockResolvedValue([]),
    auditChapter: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./saveAnchors", () => ({
  unsetForeshadowPayoffMarksByForeshadowIds: mockUnsetPayoffMarks,
  saveForeshadowAnchors: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/tree/api", () => ({
  saveSceneContent: mockSaveSceneContent,
  loadSceneContent: vi.fn().mockResolvedValue(null),
  loadSceneContents: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: {
    getState: () => ({ editor: editorRef.current }),
  },
}));

vi.mock("@/features/tree/store", () => ({
  useSceneStore: {
    getState: () => ({
      activeSceneId: "scene-1",
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

function makeForeshadowRow(version = 0) {
  return {
    id: "f-1",
    projectId: "p-1",
    title: "old title",
    intent: null,
    notes: null,
    payoffSceneId: "scene-1",
    payoffFromPos: 1,
    payoffToPos: 3,
    payoffConfirmed: false,
    abandoned: false,
    secret: false,
    loadBearing: null,
    version,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("ForeshadowStore.update", () => {
  beforeEach(() => {
    mockUpdateForeshadow.mockClear();
    mockListForeshadowsWithLabels.mockClear();
    mockUnsetPayoffMarks.mockClear();
    mockSaveSceneContent.mockClear();
    mockUpdateForeshadow.mockResolvedValue(
      attachNativeMutationMetadata(makeForeshadowRow(1), {
        maintenanceTransactionId: "foreshadow-test-maintenance-1",
      }),
    );
    editorRef.current = {
      state: { tr: {}, doc: { type: "doc" } },
      view: { dispatch: vi.fn() },
      getJSON: vi.fn().mockReturnValue({ type: "doc", content: [] }),
    };
    useForeshadowStore.setState({
      items: [
        { ...makeForeshadowRow(), label: "seeded", setupCount: 0 } as const,
      ],
      setupsByForeshadowId: {},
    });
  });

  it("updateForeshadow を呼び、load（listForeshadowsWithLabels）を実行する", async () => {
    await useForeshadowStore
      .getState()
      .update("f-1", { title: "新タイトル" }, "p-1");

    expect(mockUpdateForeshadow).toHaveBeenCalledWith(
      "f-1",
      { title: "新タイトル" },
      0,
      "p-1",
    );
    expect(mockListForeshadowsWithLabels).toHaveBeenCalledWith("p-1");
    expect(mockUnsetPayoffMarks).not.toHaveBeenCalled();
  });

  it("payoffSceneId=null のとき mark sweep と saveSceneContent を呼ぶ", async () => {
    await useForeshadowStore
      .getState()
      .update("f-1", { payoffSceneId: null }, "p-1");

    expect(mockUnsetPayoffMarks).toHaveBeenCalledOnce();
    const [applyTr, ids] = mockUnsetPayoffMarks.mock.calls[0] as [
      (fn: (tr: object) => void) => void,
      string[],
    ];
    expect(ids).toEqual(["f-1"]);

    // applyTr コールバックが dispatch を実行することを確認
    const fakeFn = vi.fn();
    applyTr(fakeFn);
    expect(fakeFn).toHaveBeenCalledWith(editorRef.current!.state.tr);
    expect(editorRef.current!.view.dispatch).toHaveBeenCalled();

    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-1",
      expect.any(String),
    );
  });

  it("エディタが無いとき sweep と saveSceneContent をスキップする", async () => {
    editorRef.current = null;

    await useForeshadowStore
      .getState()
      .update("f-1", { payoffSceneId: null }, "p-1");

    expect(mockUnsetPayoffMarks).not.toHaveBeenCalled();
    expect(mockSaveSceneContent).not.toHaveBeenCalled();
    expect(mockUpdateForeshadow).toHaveBeenCalledOnce();
  });
});
