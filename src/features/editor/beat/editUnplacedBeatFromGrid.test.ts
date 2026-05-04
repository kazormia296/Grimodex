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
  },
}));

import { loadSceneFull, saveSceneBeatsOnly } from "@/features/tree/api";
import {
  beatToPlainText,
  editUnplacedBeatFromGrid,
  loadBeatTextByIndex,
} from "./editUnplacedBeatFromGrid";

const mockLoadSceneFull = vi.mocked(loadSceneFull);
const mockSaveSceneBeatsOnly = vi.mocked(saveSceneBeatsOnly);

function makeBeat(
  id: string,
  content: { type?: string; text?: string }[],
): UnplacedBeat {
  return {
    id,
    beatType: "free",
    pov: null,
    collapsed: false,
    content,
  };
}

beforeEach(() => {
  useUnplacedBeatsStore.setState({ sceneBeats: {} });
  vi.clearAllMocks();
  mockSaveSceneBeatsOnly.mockResolvedValue({ unplacedBeatPreview: "preview" });
});

describe("beatToPlainText", () => {
  it("複数テキストノードを連結する", () => {
    const beat = makeBeat("b1", [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
    expect(beatToPlainText(beat)).toBe("Hello world");
  });

  it("text 以外のノードは空文字として扱う", () => {
    const beat = makeBeat("b1", [
      { type: "text", text: "head" },
      { type: "hardBreak" },
      { type: "text", text: "tail" },
    ]);
    expect(beatToPlainText(beat)).toBe("headtail");
  });
});

describe("loadBeatTextByIndex", () => {
  it("ストアが空のとき DB から hydrate して index で解決する", async () => {
    const beats = [makeBeat("b1", [{ type: "text", text: "first" }])];
    mockLoadSceneFull.mockResolvedValue({
      content: "",
      unplacedBeatsDoc: JSON.stringify(beats),
    });

    const result = await loadBeatTextByIndex("s1", 0);
    expect(result).toEqual({ id: "b1", text: "first" });
  });

  it("index が範囲外なら null", async () => {
    useUnplacedBeatsStore
      .getState()
      .setBeats(
        "s1",
        [makeBeat("b1", [{ type: "text", text: "only" }])],
        "load",
      );
    expect(await loadBeatTextByIndex("s1", 5)).toBeNull();
  });
});

describe("editUnplacedBeatFromGrid", () => {
  it("既存 beat の content を新しい text 1 ノードに置き換える", async () => {
    const beats = [makeBeat("b1", [{ type: "text", text: "old" }])];
    useUnplacedBeatsStore.getState().setBeats("s1", beats, "load");

    await editUnplacedBeatFromGrid("s1", "b1", "new text");

    const saved = JSON.parse(
      mockSaveSceneBeatsOnly.mock.calls[0][1].unplacedBeatsDoc,
    ) as UnplacedBeat[];
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toEqual([{ type: "text", text: "new text" }]);
  });

  it("空テキストで commit すると beat を削除する", async () => {
    const beats = [
      makeBeat("b1", [{ type: "text", text: "keep" }]),
      makeBeat("b2", [{ type: "text", text: "delete me" }]),
    ];
    useUnplacedBeatsStore.getState().setBeats("s1", beats, "load");

    await editUnplacedBeatFromGrid("s1", "b2", "   ");

    const saved = JSON.parse(
      mockSaveSceneBeatsOnly.mock.calls[0][1].unplacedBeatsDoc,
    ) as UnplacedBeat[];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("b1");
  });

  it("対象 beat が見つからないなら save しない", async () => {
    useUnplacedBeatsStore
      .getState()
      .setBeats("s1", [makeBeat("b1", [{ type: "text", text: "x" }])], "load");

    await editUnplacedBeatFromGrid("s1", "missing", "noop");

    expect(mockSaveSceneBeatsOnly).not.toHaveBeenCalled();
  });

  it("DB 書き込み失敗時はストアを元に戻す", async () => {
    const beats = [makeBeat("b1", [{ type: "text", text: "original" }])];
    useUnplacedBeatsStore.getState().setBeats("s1", beats, "load");
    mockSaveSceneBeatsOnly.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      editUnplacedBeatFromGrid("s1", "b1", "edited"),
    ).rejects.toThrow("disk full");

    const restored = useUnplacedBeatsStore.getState().getBeats("s1");
    expect(restored[0].content).toEqual([{ type: "text", text: "original" }]);
  });
});
