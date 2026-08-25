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

const createMock = vi.fn();
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({ create: createMock }),
  },
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() => Promise.resolve({ language: "ja" })),
}));

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { generateBeatAlternative } from "./generateBeatAlternative";

function emit(event: string, payload: unknown) {
  listeners.get(event)?.({
    streamId: "execution-test",
    ...(payload as Record<string, unknown>),
  });
}

async function waitForStreamDispatch() {
  // A single timer turn is not enough to guarantee that a dynamic import has
  // evaluated under full-suite load. The invoke is the real provider start
  // boundary and must only occur after all stream listeners exist.
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

function createEditorWithBeat(
  beatId: string,
  instructions = "主人公が決断する",
) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content: "<p>冒頭文。</p>",
  });
  editor
    .chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id: beatId, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: instructions }],
    })
    .run();
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
  });
  return editor;
}

describe("generateBeatAlternative", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    createMock.mockReset();
    createMock.mockResolvedValue({ id: "s1", title: "test" });

    useTreeStore.setState({
      projectId: "p1",
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
    useWorkspaceStore.setState({
      activeWorkspaceName: "テスト作品",
      activeWorkspacePath: "/workspace/test.gdx",
      workspaceSwitchInProgress: false,
    });
    useCodexStore.setState({ entries: [] });
  });

  it("ストリーム完了後に snippetStore.create が呼ばれる", async () => {
    const editor = createEditorWithBeat("b1");
    const onDone = vi.fn();

    const promise = generateBeatAlternative(editor, "b1", "scene-1", {
      onDone,
    });

    await waitForStreamDispatch();

    emit("inline-ai:stream-chunk", {
      delta: "代替案テキスト",
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    expect(createMock).toHaveBeenCalledOnce();
    const callArg = createMock.mock.calls[0][0] as {
      content: string;
      sceneId: string;
      contentSource: string;
    };
    expect(callArg.content).toContain("代替案テキスト");
    expect(callArg.sceneId).toBe("scene-1");
    expect(callArg.contentSource).toBe("ai");
    expect(onDone).toHaveBeenCalledOnce();
    editor.destroy();
  });

  it("snippet のタイトルは生成テキストの先頭から作られる", async () => {
    const editor = createEditorWithBeat("b1", "決断シーン");

    const promise = generateBeatAlternative(editor, "b1", "scene-1");
    await waitForStreamDispatch();

    const longText =
      "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも";
    emit("inline-ai:stream-chunk", {
      delta: longText,
      block_type: "text",
    });
    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });

    await promise;

    const title = (createMock.mock.calls[0][0] as { title: string }).title;
    expect(title.length).toBeLessThanOrEqual(43); // 40 chars + "..."
    editor.destroy();
  });

  it("エラー時は snippetStore.create が呼ばれず onError が呼ばれる", async () => {
    const editor = createEditorWithBeat("b1");
    const onError = vi.fn();

    const promise = generateBeatAlternative(editor, "b1", "scene-1", {
      onError,
    });
    await waitForStreamDispatch();

    emit("inline-ai:stream-error", { message: "API error" });

    await promise;

    expect(createMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("API error");
    editor.destroy();
  });

  it("beat のモデル属性(provider/variant/endpoint)を send_inline_ai_stream に渡す", async () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        AuthorshipMark,
        SceneBeatNode,
        GeneratedProseBlockNode,
      ],
      content: "<p>冒頭文。</p>",
    });
    editor
      .chain()
      .focus("end")
      .insertContent({
        type: "sceneBeat",
        attrs: {
          id: "b1",
          beatType: "free",
          pov: null,
          collapsed: false,
          // 別プロバイダ(OpenAI)のモデルを beat に固定。endpoint override は
          // openai-compatible 専用で、他プロバイダとの組み合わせは
          // resolveChatAuditRoute が fail-closed に拒否する契約のため null。
          model: "gpt-4o",
          modelProvider: "openai",
          modelVariant: "v1",
          modelEndpointId: null,
        },
        content: [{ type: "text", text: "主人公が決断する" }],
      })
      .run();
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
    });

    const promise = generateBeatAlternative(editor, "b1", "scene-1");
    await waitForStreamDispatch();

    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "send_inline_ai_stream",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      model: "gpt-4o",
      provider: "openai",
      apiVariant: "v1",
      endpointId: null,
    });

    emit("inline-ai:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 0,
      output_tokens: 0,
    });
    await promise;
    editor.destroy();
  });

  it("beat が存在しない場合は何もしない", async () => {
    const editor = createEditorWithBeat("b1");
    await generateBeatAlternative(editor, "ghost", "scene-1");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("beat の instructions が空の場合は何もしない", async () => {
    const editor = createEditorWithBeat("b1", "");
    await generateBeatAlternative(editor, "b1", "scene-1");
    expect(invokeMock).not.toHaveBeenCalled();
    editor.destroy();
  });
});
