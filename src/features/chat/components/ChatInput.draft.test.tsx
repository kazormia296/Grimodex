// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef } from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiSettingsStore } from "../store";
import { useChatStore } from "../chatStore";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  chatInputDraftKey,
  readChatInputDraft,
  writeChatInputDraft,
} from "../chatInputDraftStorage";
import { resetChatInputDraftPurgesForTests } from "../chatInputDraftPurge";
import { CHAT_INPUT_DRAFT_DEBOUNCE_MS } from "./useChatInputDraftPersistence";
import { ChatInput } from "./ChatInput";

vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));

vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));

vi.mock("../useChatModelCatalog", () => ({
  useChatModelCatalog: () => ({ sections: [], loading: false }),
}));

const KEY = chatInputDraftKey({
  workspacePath: "/ws/chat-input-draft",
  projectId: "p1",
  sessionId: "s1",
  scopeSlot: "project:::",
});

function renderInput(onSend: () => Promise<boolean>) {
  const editorRef =
    createRef<Editor | null>() as MutableRefObject<Editor | null>;
  render(<ChatInput onSend={onSend} editorRef={editorRef} />);
  const editor = () => {
    if (!editorRef.current) throw new Error("editor is not created");
    return editorRef.current;
  };
  return { editor };
}

describe("ChatInput の書きかけの保存", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetChatInputDraftPurgesForTests();
    setCurrentWorkspaceIdentity({
      path: "/ws/chat-input-draft",
      openRevision: 1,
    });
    useAiSettingsStore.setState({ settings: null, models: [] });
    useChatStore.setState({
      agentMode: false,
      messages: [],
      activeProjectId: "p1",
      activeSessionId: "s1",
      chatScope: "project",
      activeSceneId: "",
      scopeAnchorId: null,
      isLoadingSessions: false,
      isLoadingMessages: false,
      isStreaming: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setCurrentWorkspaceIdentity(null);
  });

  async function typeAndSend(onSend: () => Promise<boolean>) {
    const { editor } = renderInput(onSend);
    act(() => {
      editor().commands.insertContent("送信する文");
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_INPUT_DRAFT_DEBOUNCE_MS);
    });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-send"));
    });
    // debounce を待たずに判定する（空の update による削除と区別する）。
    return editor;
  }

  it("送信が受け付けられたら保存を消す", async () => {
    const onSend = vi.fn(async () => true);
    const editor = await typeAndSend(onSend);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(editor().getText()).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("送信が受け付けられなければ保存を残す", async () => {
    const onSend = vi.fn(async () => false);
    const editor = await typeAndSend(onSend);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(editor().getText()).toBe("送信する文");
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("送信の準備中に既存の session へ移ったら、受付の後も移り先の下書きを消さない", async () => {
    const target = {
      workspacePath: "/ws/chat-input-draft",
      projectId: "p1",
      sessionId: "x",
      scopeSlot: "project:::",
    };
    const keyX = chatInputDraftKey(target);
    writeChatInputDraft(keyX, target, 0, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x の下書き" }],
          },
        ],
      },
      commandId: null,
    });
    useChatStore.setState({
      activeSessionId: null,
      sessions: [{ id: "x" }] as never,
    });
    let accept!: (value: boolean) => void;
    const onSend = vi.fn(
      () => new Promise<boolean>((resolve) => (accept = resolve)),
    );
    const { editor } = renderInput(onSend);
    act(() => {
      editor().commands.insertContent("新しいチャットの文");
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-send"));
    });
    act(() => {
      useChatStore.setState({ activeSessionId: "x" });
    });
    expect(editor().getText()).toBe("x の下書き");
    await act(async () => {
      accept(true);
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_INPUT_DRAFT_DEBOUNCE_MS);
    });
    expect(editor().getText()).toBe("x の下書き");
    expect(readChatInputDraft(keyX)).not.toBeNull();
  });
});
