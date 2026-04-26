// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateForeshadowSetup, mockLoadSetups, mockToastError } =
  vi.hoisted(() => ({
    mockCreateForeshadowSetup: vi.fn().mockResolvedValue({ id: "setup-1" }),
    mockLoadSetups: vi.fn().mockResolvedValue(undefined),
    mockToastError: vi.fn(),
  }));

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

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));
vi.mock("i18next", () => ({
  default: { t: (_k: string, fallback: string) => fallback },
}));
vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: { getState: () => ({ editor: null }) },
}));
vi.mock("@/features/tree/store", () => ({
  useSceneStore: { getState: () => ({ activeSceneId: null, nodes: [] }) },
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
vi.mock("@/lib/debugLog", () => ({
  debugLog: { error: vi.fn() },
  errorDetail: vi.fn(),
  rootCause: vi.fn((e: unknown) => String(e)),
}));

import { useForeshadowStore } from "./foreshadowStore";

const BASE_CANDIDATE = {
  sceneId: "scene-1",
  kind: "designated_existing" as const,
  suggestedText: undefined,
  rationale: "意図的な描写",
  predictedStrength: "moderate" as const,
  existingExcerpt: "古い剣が壁に掛かっていた",
  fromPosHint: 42,
  toPosHint: 60,
  suggestedInsertionPoint: undefined,
};

describe("adoptProposedSetup", () => {
  beforeEach(() => {
    mockCreateForeshadowSetup.mockClear();
    mockLoadSetups.mockClear();
    mockToastError.mockClear();

    useForeshadowStore.setState({
      items: [],
      proposeResults: { "f-1": [BASE_CANDIDATE] },
      setupsByForeshadowId: {},
    });
  });

  it("fromPosHint が null のとき createForeshadowSetup を呼ばずに toast エラーを出す", async () => {
    useForeshadowStore.setState({
      proposeResults: {
        "f-1": [{ ...BASE_CANDIDATE, fromPosHint: undefined }],
      },
    });

    await useForeshadowStore.getState().adoptProposedSetup("f-1", 0);

    expect(mockCreateForeshadowSetup).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("位置情報"),
    );
  });

  it("toPosHint が null のとき createForeshadowSetup を呼ばずに toast エラーを出す", async () => {
    useForeshadowStore.setState({
      proposeResults: {
        "f-1": [{ ...BASE_CANDIDATE, toPosHint: undefined }],
      },
    });

    await useForeshadowStore.getState().adoptProposedSetup("f-1", 0);

    expect(mockCreateForeshadowSetup).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("fromPosHint/toPosHint が揃っているとき createForeshadowSetup を正しい位置で呼ぶ", async () => {
    await useForeshadowStore.getState().adoptProposedSetup("f-1", 0);

    expect(mockCreateForeshadowSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        foreshadowId: "f-1",
        sceneId: "scene-1",
        fromPos: 42,
        toPos: 60,
        kind: "designated_existing",
        attribution: "ai",
      }),
    );
  });

  it("採用後に候補リストから除去する", async () => {
    await useForeshadowStore.getState().adoptProposedSetup("f-1", 0);

    const results = useForeshadowStore.getState().proposeResults["f-1"] ?? [];
    expect(results).toHaveLength(0);
  });
});
