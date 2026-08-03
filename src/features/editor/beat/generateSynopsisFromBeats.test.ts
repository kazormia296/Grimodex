// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

type ListenHandler = (payload: unknown) => void;
const listeners = new Map<string, ListenHandler>();
const invokeMock = vi.fn();
const auditMocks = vi.hoisted(() => ({
  begin: vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace/test.gdx",
    operationId: "operation-test",
    executionId: "execution-test",
    parentExecutionId: null,
    startedAt: 1,
  })),
  dispatched: vi.fn(async () => undefined),
  complete: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  partials: vi.fn(async () => undefined),
  recovery: vi.fn(async () => undefined),
}));

vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: auditMocks.begin,
  markAiAuditDispatched: auditMocks.dispatched,
  completeAiAuditExecution: auditMocks.complete,
  failAiAuditExecution: auditMocks.fail,
  cancelAiAuditExecution: auditMocks.cancel,
  recordAiAuditPartials: auditMocks.partials,
  attemptAiAuditPersistenceFailureTerminal: auditMocks.recovery,
}));

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: vi.fn(async (eventName: string, handler: ListenHandler) => {
    listeners.set(eventName, handler);
    return () => {
      if (listeners.get(eventName) === handler) listeners.delete(eventName);
    };
  }),
}));

const updateSynopsisMock = vi.fn();
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
          synopsis: "既存のシノプシス",
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          status: null,
          createdAt: "2026-01-01",
        },
      ],
      updateSynopsis: updateSynopsisMock,
    }),
  },
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspaceName: "テスト作品",
      activeWorkspacePath: "/workspace/test.gdx",
      workspaceSwitchInProgress: false,
    }),
  },
}));

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { generateSynopsisFromBeats } from "./generateSynopsisFromBeats";

function emit(event: string, payload: unknown) {
  listeners.get(event)?.({
    streamId: "execution-test",
    ...(payload as Record<string, unknown>),
  });
}

async function waitForStreamListeners() {
  // The lazy transport import may require a macrotask while the full suite is
  // evaluating other modules. Wait for the backend dispatch boundary: in
  // production the provider cannot emit its first event before this invoke.
  await vi.waitFor(() =>
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "send_inline_ai_stream",
      ),
    ).toBe(true),
  );
  expect(listeners.has("inline-ai:stream-chunk")).toBe(true);
  expect(listeners.has("inline-ai:stream-done")).toBe(true);
  expect(listeners.has("inline-ai:stream-error")).toBe(true);
}

function createEditorWithBeats(beats: { id: string; instructions: string }[]) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content: "<p>冒頭文。</p>",
  });
  for (const beat of beats) {
    editor
      .chain()
      .focus("end")
      .insertContent({
        type: "sceneBeat",
        attrs: { id: beat.id, beatType: "free", pov: null, collapsed: false },
        content: [{ type: "text", text: beat.instructions }],
      })
      .run();
  }
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
  });
  return editor;
}

describe("generateSynopsisFromBeats", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    updateSynopsisMock.mockReset();
    updateSynopsisMock.mockResolvedValue(undefined);
  });

  it("ストリーム完了後に updateSynopsis が呼ばれる", async () => {
    const editor = createEditorWithBeats([
      { id: "b1", instructions: "主人公が決断する" },
    ]);
    const onDone = vi.fn();

    const promise = generateSynopsisFromBeats(editor, "scene-1", { onDone });

    await waitForStreamListeners();

    emit("inline-ai:stream-chunk", {
      delta: "主人公は重要な決断を下した。",
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(updateSynopsisMock).toHaveBeenCalledOnce();
    expect(updateSynopsisMock).toHaveBeenCalledWith(
      "scene-1",
      "主人公は重要な決断を下した。",
    );
    expect(onDone).toHaveBeenCalledOnce();
    editor.destroy();
  });

  it("beat が存在しない場合は何もしない", async () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        AuthorshipMark,
        SceneBeatNode,
        GeneratedProseBlockNode,
      ],
      content: "<p>本文のみ。</p>",
    });

    await generateSynopsisFromBeats(editor, "scene-1");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(updateSynopsisMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("エラー時は updateSynopsis が呼ばれず onError が呼ばれる", async () => {
    const editor = createEditorWithBeats([
      { id: "b1", instructions: "決断シーン" },
    ]);
    const onError = vi.fn();

    const promise = generateSynopsisFromBeats(editor, "scene-1", { onError });
    await waitForStreamListeners();

    emit("inline-ai:stream-error", { message: "API error" });

    await promise;

    expect(updateSynopsisMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("API error");
    editor.destroy();
  });

  it("複数 beat の指示をすべて収集してプロンプトに含める", async () => {
    const editor = createEditorWithBeats([
      { id: "b1", instructions: "第一ビート" },
      { id: "b2", instructions: "第二ビート" },
      { id: "b3", instructions: "第三ビート" },
    ]);

    const promise = generateSynopsisFromBeats(editor, "scene-1");
    await waitForStreamListeners();

    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await promise;

    // invoke (send_inline_ai_stream) が呼ばれ、messages に全ビートが含まれる。
    // N4: recordAiUsage が db_execute invoke を別途発火するため、呼び出し回数は
    // 固定せず send_inline_ai_stream 呼び出しを特定して検証する。
    const callArgs = invokeMock.mock.calls.find(
      (c) => c[0] === "send_inline_ai_stream",
    );
    expect(callArgs).toBeDefined();
    const messagesArg = JSON.stringify(callArgs);
    expect(messagesArg).toContain("第一ビート");
    expect(messagesArg).toContain("第二ビート");
    expect(messagesArg).toContain("第三ビート");
    editor.destroy();
  });

  it("onStart が呼ばれる", async () => {
    const editor = createEditorWithBeats([
      { id: "b1", instructions: "ビート" },
    ]);
    const onStart = vi.fn();

    const promise = generateSynopsisFromBeats(editor, "scene-1", { onStart });
    await waitForStreamListeners();

    expect(onStart).toHaveBeenCalledOnce();

    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await promise;
    editor.destroy();
  });

  it("空のAIレスポンスは onError を呼び updateSynopsis を呼ばない", async () => {
    const editor = createEditorWithBeats([
      { id: "b1", instructions: "ビート" },
    ]);
    const onError = vi.fn();

    const promise = generateSynopsisFromBeats(editor, "scene-1", { onError });
    await waitForStreamListeners();

    // 空のチャンクを送ってから done
    emit("inline-ai:stream-chunk", { delta: "   ", block_type: "text" });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(updateSynopsisMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    editor.destroy();
  });
});
