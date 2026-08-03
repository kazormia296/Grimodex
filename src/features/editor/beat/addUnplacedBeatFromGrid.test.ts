import { describe, it, expect, vi, beforeEach } from "vitest";
import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import type { UnplacedBeat } from "./unplacedBeatsStore";

vi.mock("@/features/tree/api", () => ({
  loadSceneFull: vi.fn(),
  saveSceneBeatsOnly: vi
    .fn()
    .mockResolvedValue({ unplacedBeatPreview: "preview" }),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({ setNodePreview: vi.fn() })),
  },
}));

import { loadSceneFull, saveSceneBeatsOnly } from "@/features/tree/api";
import { addUnplacedBeatFromGrid } from "./addUnplacedBeatFromGrid";
import { _resetGridBeatMutationQueueForTests } from "./gridBeatMutationQueue";

const mockLoadSceneFull = vi.mocked(loadSceneFull);
const mockSaveSceneBeatsOnly = vi.mocked(saveSceneBeatsOnly);

function makeExistingBeat(id: string, text: string): UnplacedBeat {
  return {
    id,
    beatType: "free",
    pov: null,
    collapsed: false,
    content: [{ type: "text", text }],
  };
}

beforeEach(() => {
  _resetGridBeatMutationQueueForTests();
  useUnplacedBeatsStore.setState({ sceneBeats: {} });
  vi.clearAllMocks();
  mockLoadSceneFull.mockResolvedValue({
    content: "",
    unplacedBeatsDoc: "[]",
    projectId: "project-1",
    version: 0,
  });
  mockSaveSceneBeatsOnly.mockResolvedValue({
    unplacedBeatPreview: "preview",
    contentVersion: 1,
    contentUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("addUnplacedBeatFromGrid", () => {
  it("空テキストは何もしない", async () => {
    await addUnplacedBeatFromGrid("s1", "   ");
    expect(mockSaveSceneBeatsOnly).not.toHaveBeenCalled();
  });

  it("ストアが空のとき DB から既存 beat を hydrate してから追加する（データ消失防止）", async () => {
    const existingBeats = [makeExistingBeat("b-old", "古いBeat")];
    mockLoadSceneFull.mockResolvedValue({
      content: "",
      unplacedBeatsDoc: JSON.stringify(existingBeats),
      projectId: "project-1",
      version: 0,
    });

    await addUnplacedBeatFromGrid("s1", "新しいBeat");

    const savedDoc = JSON.parse(
      mockSaveSceneBeatsOnly.mock.calls[0][1].unplacedBeatsDoc,
    ) as UnplacedBeat[];
    expect(savedDoc).toHaveLength(2);
    expect(savedDoc[0].id).toBe("b-old");
    expect(savedDoc[1].content[0]).toMatchObject({
      type: "text",
      text: "新しいBeat",
    });
  });

  it("ストアに既存 beat があるときも最新の OCC revision を読む", async () => {
    const existing = [makeExistingBeat("b-existing", "既存")];
    useUnplacedBeatsStore.getState().setBeats("s1", existing, "load");

    await addUnplacedBeatFromGrid("s1", "追加Beat");

    expect(mockLoadSceneFull).toHaveBeenCalledOnce();

    const savedDoc = JSON.parse(
      mockSaveSceneBeatsOnly.mock.calls[0][1].unplacedBeatsDoc,
    ) as UnplacedBeat[];
    expect(savedDoc).toHaveLength(2);
  });

  it("DB の unplacedBeatsDoc が空配列の場合に新規追加だけ保存する", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: "",
      unplacedBeatsDoc: "[]",
      projectId: "project-1",
      version: 0,
    });

    await addUnplacedBeatFromGrid("s1", "初beat");

    const savedDoc = JSON.parse(
      mockSaveSceneBeatsOnly.mock.calls[0][1].unplacedBeatsDoc,
    ) as UnplacedBeat[];
    expect(savedDoc).toHaveLength(1);
    expect(savedDoc[0].content[0]).toMatchObject({
      type: "text",
      text: "初beat",
    });
  });

  it("DB が壊れた JSON を返したら保存せず、既存Beat上書きを拒否する", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: "",
      unplacedBeatsDoc: "invalid-json",
      projectId: "project-1",
      version: 0,
    });

    await expect(addUnplacedBeatFromGrid("s1", "beat")).rejects.toThrow();
    expect(mockSaveSceneBeatsOnly).not.toHaveBeenCalled();
  });

  it("DB の空配列も hydrated として保持し、strict commit時の再読込を不要にする", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: "",
      unplacedBeatsDoc: "[]",
      projectId: "project-1",
      version: 0,
    });

    await addUnplacedBeatFromGrid("s1", "first");
    await addUnplacedBeatFromGrid("s1", "second");

    expect(mockLoadSceneFull).toHaveBeenCalledTimes(2);
  });

  it("追加後に saveSceneBeatsOnly を呼ぶ", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: "",
      unplacedBeatsDoc: "[]",
      projectId: "project-1",
      version: 0,
    });

    await addUnplacedBeatFromGrid("s1", "テスト");

    expect(mockSaveSceneBeatsOnly).toHaveBeenCalledOnce();
    expect(mockSaveSceneBeatsOnly.mock.calls[0][0]).toBe("s1");
  });

  it("DB 書き込み失敗時はストアを元に戻して例外を伝播する", async () => {
    const existing = [makeExistingBeat("b-existing", "既存")];
    useUnplacedBeatsStore.getState().setBeats("s1", existing, "load");
    mockSaveSceneBeatsOnly.mockRejectedValueOnce(new Error("disk full"));

    await expect(addUnplacedBeatFromGrid("s1", "失敗するbeat")).rejects.toThrow(
      "disk full",
    );

    const beats = useUnplacedBeatsStore.getState().getBeats("s1");
    expect(beats).toHaveLength(1);
    expect(beats[0].id).toBe("b-existing");
  });
});
