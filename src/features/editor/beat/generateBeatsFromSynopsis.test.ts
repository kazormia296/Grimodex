// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

type ListenHandler = (event: { payload: unknown }) => void;
const listeners = new Map<string, ListenHandler>();
const invokeMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: ListenHandler) => {
    listeners.set(eventName, handler);
    return () => {
      if (listeners.get(eventName) === handler) listeners.delete(eventName);
    };
  }),
}));

const addBeatMock = vi.fn();
vi.mock("@/features/editor/beat/unplacedBeatsStore", () => ({
  useUnplacedBeatsStore: {
    getState: () => ({ addBeat: addBeatMock }),
  },
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      projectId: "p1",
      nodes: [
        {
          id: "scene-1",
          projectId: "p1",
          parentId: null,
          nodeType: "scene",
          title: "第1話",
          synopsis: "主人公が旅立ちの決断をする場面。",
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          status: null,
          createdAt: "2026-01-01",
        },
      ],
    }),
  },
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspaceName: "テスト作品" }),
  },
}));

import { generateBeatsFromSynopsis } from "./generateBeatsFromSynopsis";

function emit(event: string, payload: unknown) {
  listeners.get(event)?.({ payload });
}

const validJson = JSON.stringify({
  beats: [
    { beatType: "free", instructions: "主人公が決断する" },
    { beatType: "dialogue", instructions: "友人との別れの会話" },
  ],
});

describe("generateBeatsFromSynopsis", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    addBeatMock.mockReset();
  });

  it("ストリーム完了後に addBeat が各ビートごとに呼ばれる", async () => {
    const onDone = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onDone });
    await Promise.resolve();

    emit("inline-ai:stream-chunk", {
      delta: validJson,
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(addBeatMock).toHaveBeenCalledTimes(2);
    const firstCall = addBeatMock.mock.calls[0];
    expect(firstCall[0]).toBe("scene-1");
    expect(firstCall[1]).toMatchObject({
      beatType: "free",
      content: [{ type: "text", text: "主人公が決断する" }],
    });
    const secondCall = addBeatMock.mock.calls[1];
    expect(secondCall[1]).toMatchObject({
      beatType: "dialogue",
      content: [{ type: "text", text: "友人との別れの会話" }],
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("synopsis が空の場合は何もしない（存在しないシーンIDで確認）", async () => {
    // Using a scene ID that has no matching node — synopsis resolves to ""
    await generateBeatsFromSynopsis("scene-no-synopsis");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(addBeatMock).not.toHaveBeenCalled();
  });

  it("JSON が不正な場合は onError が呼ばれ addBeat は呼ばれない", async () => {
    const onError = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onError });
    await Promise.resolve();

    emit("inline-ai:stream-chunk", {
      delta: "これは JSON ではありません",
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(addBeatMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("beats 配列が存在しない JSON の場合は onError が呼ばれる", async () => {
    const onError = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onError });
    await Promise.resolve();

    emit("inline-ai:stream-chunk", {
      delta: JSON.stringify({ something: "else" }),
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(addBeatMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("不正な beatType は free にフォールバックする", async () => {
    const promise = generateBeatsFromSynopsis("scene-1");
    await Promise.resolve();

    emit("inline-ai:stream-chunk", {
      delta: JSON.stringify({
        beats: [{ beatType: "invalid_type", instructions: "テスト" }],
      }),
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(addBeatMock).toHaveBeenCalledOnce();
    expect(addBeatMock.mock.calls[0][1]).toMatchObject({ beatType: "free" });
  });

  it("ストリームエラー時は onError が呼ばれ addBeat は呼ばれない", async () => {
    const onError = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onError });
    await Promise.resolve();

    emit("inline-ai:stream-error", { message: "API error" });

    await promise;

    expect(addBeatMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("API error");
  });

  it("onStart が呼ばれる", async () => {
    const onStart = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onStart });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledOnce();

    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await promise;
  });

  it("markdown フェンスで囲まれた JSON も正しくパースできる", async () => {
    const onDone = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onDone });
    await Promise.resolve();

    const fencedJson = "```json\n" + validJson + "\n```";
    emit("inline-ai:stream-chunk", {
      delta: fencedJson,
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(addBeatMock).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("前置きテキスト付きの JSON もブレース抽出でパースできる", async () => {
    const onDone = vi.fn();

    const promise = generateBeatsFromSynopsis("scene-1", { onDone });
    await Promise.resolve();

    const withPreamble = "以下が提案です:\n" + validJson;
    emit("inline-ai:stream-chunk", {
      delta: withPreamble,
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(addBeatMock).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledOnce();
  });
});
