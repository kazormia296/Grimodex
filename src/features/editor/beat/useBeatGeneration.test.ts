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

import { renderHook, act, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { findGeneratedBlockForBeat, findBeatById } from "./insertBeatStream";
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
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);

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
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          status: null,
          createdAt: "2026-01-01",
        },
      ],
    });
    useWorkspaceStore.setState({ activeWorkspaceName: "テスト作品" });
    useCodexStore.setState({ entries: [] });
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
});
