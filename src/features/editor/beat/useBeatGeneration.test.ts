// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock Tauri streaming primitives BEFORE importing the hook so the import
// chain picks up the stub.
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

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));

const insertGenerationLogMock = vi.fn();
vi.mock("@/features/attribution/generationLogApi", () => ({
  insertGenerationLog: (...args: unknown[]) => insertGenerationLogMock(...args),
}));

// Mock inference dependencies for C-7 tests.
const inferMentionRolesMock = vi.fn();
vi.mock("./inferMentionRoles", () => ({
  inferMentionRoles: (...args: unknown[]) => inferMentionRolesMock(...args),
}));

const extractBeatMentionsMock = vi.fn();
vi.mock("./extractBeatMentions", () => ({
  extractBeatMentions: (...args: unknown[]) => extractBeatMentionsMock(...args),
}));

import { renderHook, act, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { useTreeStore } from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { findGeneratedBlockForBeat, findBeatById } from "./insertBeatStream";
import { useRoleSuggestionsStore } from "./roleSuggestionsStore";
import { useBeatGeneration } from "./useBeatGeneration";

function emit(event: string, payload: unknown) {
  listeners.get(event)?.({ payload });
}

function createEditorWithBeat(beatId: string) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content: "<p>シーン冒頭の文。</p>",
  });
  editor
    .chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id: beatId, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: "雨の夜、廃社の前で立ち止まる朱音" }],
    })
    .run();
  // Trailing paragraph so the beat isn't the last node.
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
  });
  return editor;
}

describe("useBeatGeneration", () => {
  beforeEach(() => {
    listeners.clear();
    insertGenerationLogMock.mockClear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    // Reset call history AND return values for inference mocks between tests.
    extractBeatMentionsMock.mockReset();
    extractBeatMentionsMock.mockReturnValue([]);
    inferMentionRolesMock.mockReset();
    inferMentionRolesMock.mockResolvedValue([]);
    // Reset role suggestion store.
    useRoleSuggestionsStore.setState({ byBeatId: {} });
    // Reset settings to defaults (beat.inferRoles = true).
    useSettingsStore.setState((s) => ({
      cache: { ...s.cache, "beat.inferRoles": "true" },
    }));

    // Seed stores with a minimal scene + project + codex.
    useTreeStore.setState({
      nodes: [
        {
          id: "scene-1",
          projectId: "p1",
          parentId: null,
          nodeType: "scene",
          title: "第1話",
          synopsis: null,

          intent: null,
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          status: null,
          createdAt: "2026-01-01",

          charCount: 0,
          updatedAt: "2026-01-01",
        },
      ],
    });
    useWorkspaceStore.setState({ activeWorkspaceName: "テスト作品" });
    useCodexStore.setState({ entries: [] });
    // policy 既定はクリア（projects 空 → fail-open=full）。bodyWrite ガードを
    // 素通りさせ、既存テストの generate を従来どおり走らせる。
    useProjectStore.setState({ currentProjectId: null, projects: [] });
  });

  it("happy path: streams chunks into a generatedProseBlock and ends in idle state", async () => {
    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    expect(result.current.state.status).toBe("idle");

    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.generate();
      // Wait a tick for the listener registration before emitting events.
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.state.status).toBe("generating"));

    await act(async () => {
      emit("inline-ai:stream-chunk", { delta: "ドロシー", block_type: "text" });
      emit("inline-ai:stream-chunk", {
        delta: "は走った。",
        block_type: "text",
      });
      emit("inline-ai:stream-done", {
        stop_reason: "end_turn",
        input_tokens: 0,
        output_tokens: 0,
      });
      await pending!;
    });

    await waitFor(() => expect(result.current.state.status).toBe("idle"));

    const block = findGeneratedBlockForBeat(editor, "b1");
    expect(block).not.toBeNull();
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode?.textContent).toBe("ドロシーは走った。");
    expect(blockNode?.attrs.modified).toBe(false);

    // Sanity: invoke called the right Tauri command.
    expect(invokeMock).toHaveBeenCalledWith(
      "send_inline_ai_stream",
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ]),
      }),
    );
    expect(insertGenerationLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "beat",
        commandId: "free",
        instruction: "雨の夜、廃社の前で立ち止まる朱音",
        sceneNodeId: "scene-1",
        model: "claude-sonnet-4-6",
        traceId: expect.any(String),
      }),
    );
    editor.destroy();
  });

  it("error path: stream-error sets status=error", async () => {
    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.generate();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.state.status).toBe("generating"));

    await act(async () => {
      emit("inline-ai:stream-error", { message: "boom" });
      await pending!;
    });

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state.error).toBe("boom");
    editor.destroy();
  });

  it("guard: empty instructions trigger error without invoking the stream", async () => {
    const editor = createEditorWithBeat("b1");
    // Wipe the beat's instructions.
    const beat = findBeatById(editor, "b1");
    const node = editor.state.doc.nodeAt(beat!.beatPos);
    const tr = editor.state.tr;
    tr.delete(beat!.beatPos + 1, beat!.beatPos + 1 + (node?.content.size ?? 0));
    editor.view.dispatch(tr);

    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.state.status).toBe("error");
    expect(invokeMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("running a second generation after the first completes does not double-insert chunks", async () => {
    // Regression for the listener-leak bug: onDone was setting state but
    // never calling the cleanup() the previous run returned. Two listeners
    // would then fire for every chunk of the next generation.
    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    // First generation
    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.generate();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.status).toBe("generating"));
    await act(async () => {
      emit("inline-ai:stream-chunk", { delta: "first.", block_type: "text" });
      emit("inline-ai:stream-done", {
        stop_reason: "end_turn",
        input_tokens: 0,
        output_tokens: 0,
      });
      await pending!;
    });
    await waitFor(() => expect(result.current.state.status).toBe("idle"));

    // Second generation — should register only one fresh listener, not two.
    await act(async () => {
      pending = result.current.generate();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.status).toBe("generating"));
    await act(async () => {
      emit("inline-ai:stream-chunk", { delta: "second.", block_type: "text" });
      emit("inline-ai:stream-done", {
        stop_reason: "end_turn",
        input_tokens: 0,
        output_tokens: 0,
      });
      await pending!;
    });
    await waitFor(() => expect(result.current.state.status).toBe("idle"));

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    // If the leak were still present, the second-generation chunk would be
    // inserted twice ("second.second.") because the first run's listener is
    // still alive.
    expect(blockNode?.textContent).toBe("first.second.");
    editor.destroy();
  });

  it("a second generate() while one is in flight is a no-op (in-flight guard)", async () => {
    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.generate();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.status).toBe("generating"));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Second click while still generating should bail out before invoke.
    await act(async () => {
      await result.current.generate();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit("inline-ai:stream-done", {
        stop_reason: "end_turn",
        input_tokens: 0,
        output_tokens: 0,
      });
      await pending!;
    });
    editor.destroy();
  });

  it("guard: missing sceneId silently no-ops", async () => {
    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() => useBeatGeneration(editor, "b1", null));

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.state.status).toBe("idle");
    expect(invokeMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("policy bypass: bodyWrite=off blocks generate before invoking the stream", async () => {
    useProjectStore.setState({
      currentProjectId: "p1",
      projects: [
        {
          id: "p1",
          aiPolicy: JSON.stringify({
            preset: "assist-off",
            toggles: { chat: true, bodyWrite: false, analysis: true },
          }),
        },
      ] as never,
    });

    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    await act(async () => {
      await result.current.generate();
    });

    expect(result.current.state.status).toBe("idle");
    expect(invokeMock).not.toHaveBeenCalled();
    editor.destroy();
  });
});

// Helper: run a full generate → stream-chunk → stream-done cycle.
async function runGeneration(
  result: { current: ReturnType<typeof useBeatGeneration> },
  chunks: string[] = ["散文テキスト"],
) {
  let pending: Promise<void>;
  await act(async () => {
    pending = result.current.generate();
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current.state.status).toBe("generating"));
  await act(async () => {
    for (const chunk of chunks) {
      emit("inline-ai:stream-chunk", { delta: chunk, block_type: "text" });
    }
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await pending!;
  });
  await waitFor(() => expect(result.current.state.status).toBe("idle"));
}

describe("runRoleInference (C-7)", () => {
  beforeEach(() => {
    listeners.clear();
    insertGenerationLogMock.mockClear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    extractBeatMentionsMock.mockReset();
    extractBeatMentionsMock.mockReturnValue([]);
    inferMentionRolesMock.mockReset();
    inferMentionRolesMock.mockResolvedValue([]);
    useRoleSuggestionsStore.setState({ byBeatId: {} });
    useSettingsStore.setState((s) => ({
      cache: { ...s.cache, "beat.inferRoles": "true" },
    }));
    useTreeStore.setState({
      nodes: [
        {
          id: "scene-1",
          projectId: "p1",
          parentId: null,
          nodeType: "scene",
          title: "第1話",
          synopsis: null,

          intent: null,
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          status: null,
          createdAt: "2026-01-01",

          charCount: 0,
          updatedAt: "2026-01-01",
        },
      ],
    });
    useWorkspaceStore.setState({ activeWorkspaceName: "テスト作品" });
    useCodexStore.setState({ entries: [] });
    // policy 既定はクリア（projects 空 → fail-open=full）。bodyWrite ガードを
    // 素通りさせ、既存テストの generate を従来どおり走らせる。
    useProjectStore.setState({ currentProjectId: null, projects: [] });
  });

  it("onDone 後に inferMentionRoles が呼ばれ、提案が store に保存される", async () => {
    extractBeatMentionsMock.mockReturnValue([
      { beatId: "b1", codexId: "c1", role: "mentioned" },
    ]);
    inferMentionRolesMock.mockResolvedValue([
      { codexId: "c1", role: "actor", confidence: 0.9 },
    ]);

    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );
    await runGeneration(result);

    await waitFor(() => expect(inferMentionRolesMock).toHaveBeenCalled());

    const suggestions = useRoleSuggestionsStore.getState().byBeatId["b1"];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestedRole).toBe("actor");
    expect(suggestions[0].codexId).toBe("c1");
    editor.destroy();
  });

  it("mention が 0 件のとき inferMentionRoles を呼ばない", async () => {
    // extractBeatMentionsMock already returns [] by default.
    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );
    await runGeneration(result);

    // Give a tick for any async work.
    await act(async () => {
      await Promise.resolve();
    });

    expect(inferMentionRolesMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("beat.inferRoles が OFF のとき API を呼ばない", async () => {
    useSettingsStore.setState((s) => ({
      cache: { ...s.cache, "beat.inferRoles": "false" },
    }));
    extractBeatMentionsMock.mockReturnValue([
      { beatId: "b1", codexId: "c1", role: "mentioned" },
    ]);

    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );
    await runGeneration(result);

    await act(async () => {
      await Promise.resolve();
    });

    expect(inferMentionRolesMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("beat が削除済みのとき setSuggestions を呼ばない（孤立チェック）", async () => {
    extractBeatMentionsMock.mockReturnValue([
      { beatId: "b1", codexId: "c1", role: "mentioned" },
    ]);
    // Controlled promise — resolves only when we call resolveInference.
    let resolveInference!: (
      v: { codexId: string; role: string; confidence: number }[],
    ) => void;
    inferMentionRolesMock.mockReturnValue(
      new Promise((res) => {
        resolveInference = res;
      }),
    );

    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );

    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.generate();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.status).toBe("generating"));
    await act(async () => {
      emit("inline-ai:stream-chunk", {
        delta: "散文テキスト",
        block_type: "text",
      });
      emit("inline-ai:stream-done", {
        stop_reason: "end_turn",
        input_tokens: 0,
        output_tokens: 0,
      });
      await pending!;
    });
    await waitFor(() => expect(result.current.state.status).toBe("idle"));

    // Delete the beat from the doc while inference is in flight.
    const beat = findBeatById(editor, "b1");
    if (beat) {
      const tr = editor.state.tr;
      tr.delete(beat.beatPos, beat.beatPos + beat.beatSize);
      editor.view.dispatch(tr);
    }

    // Resolve inference now that the beat is gone.
    await act(async () => {
      resolveInference([{ codexId: "c1", role: "actor", confidence: 0.9 }]);
      await Promise.resolve();
    });

    expect(useRoleSuggestionsStore.getState().byBeatId["b1"]).toBeUndefined();
    editor.destroy();
  });

  it("信頼度しきい値未満・同 role の提案はフィルタされる", async () => {
    extractBeatMentionsMock.mockReturnValue([
      { beatId: "b1", codexId: "c1", role: "actor" }, // same role
      { beatId: "b1", codexId: "c2", role: "mentioned" }, // low confidence
    ]);
    inferMentionRolesMock.mockResolvedValue([
      { codexId: "c1", role: "actor", confidence: 0.9 }, // same role → excluded
      { codexId: "c2", role: "target", confidence: 0.5 }, // below 0.7 → excluded
    ]);

    const editor = createEditorWithBeat("b1");
    const { result } = renderHook(() =>
      useBeatGeneration(editor, "b1", "scene-1"),
    );
    await runGeneration(result);

    await waitFor(() => expect(inferMentionRolesMock).toHaveBeenCalled());

    const suggestions = useRoleSuggestionsStore.getState().byBeatId["b1"];
    expect(suggestions).toBeUndefined();
    editor.destroy();
  });
});
