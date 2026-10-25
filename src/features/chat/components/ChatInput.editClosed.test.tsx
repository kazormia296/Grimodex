// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// K3/2 "chat の書込みの入口" 4 (DR-DA2B-R6): while restricted, the input's
// edit-the-last-message entrance (the editLast key) of a conversation that is
// not a scene's is closed, as the message actions are. The closure is D
// wording behind `PROFILE_ACTIVATION_UI_ENABLED` (D-13 (a)): with the real
// constant (false) the entrance behaves as before.

const h = vi.hoisted(() => {
  const editor = {
    isDestroyed: false,
    // Not mounted: the input never reads the view's DOM in this test.
    get view(): never {
      throw new Error("The editor view is not available");
    },
    on: vi.fn(),
    off: vi.fn(),
    setEditable: vi.fn(),
    getText: vi.fn(() => ""),
    storage: {},
    state: { doc: { descendants: vi.fn() } },
    commands: {
      clearContent: vi.fn(),
      focus: vi.fn(),
      setContent: vi.fn(),
    },
  };
  return {
    editor,
    enabled: { value: true },
    onEditLast: { current: (() => {}) as () => void },
  };
});

vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  get PROFILE_ACTIVATION_UI_ENABLED() {
    return h.enabled.value;
  },
}));

vi.mock("@tiptap/react", () => ({
  EditorContent: () => null,
  useEditor: () => h.editor,
  useEditorState: () => ({ hasText: false, text: "", hasMentions: false }),
}));

vi.mock("../extensions/chatInputExtensions", () => ({
  getChatInputExtensions: (options: { onEditLast: () => void }) => {
    h.onEditLast.current = options.onEditLast;
    return [];
  },
}));

vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));

vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));

vi.mock("../useChatModelCatalog", () => ({
  useChatModelCatalog: () => ({ sections: [], loading: false }),
}));

import { useChatStore } from "../chatStore";
import { ChatInput } from "./ChatInput";

function renderInput(editDisabled: boolean) {
  const editUserMessage = vi.fn(() => ({ content: "last question" }));
  // 場面の会話（同期の経路）。非場面の会話の状態の読取は
  // `ChatInput.nonSceneEdit.test.tsx`（DR-DA2B-R17）。
  useChatStore.setState({
    agentMode: false,
    chatScope: "scene",
    activeSceneId: "scene-1",
    scopeAnchorId: null,
    threadFocusOverride: null,
    editUserMessage,
    messages: [
      {
        id: "u1",
        sessionId: "s1",
        role: "user",
        content: "last question",
        createdAt: "2026-10-25T00:00:00.000Z",
      },
    ] as never,
  });
  render(<ChatInput onSend={vi.fn()} editDisabled={editDisabled} />);
  return { editUserMessage };
}

describe("the input's closed edit-the-last-message entrance", () => {
  beforeEach(() => {
    h.editor.commands.setContent.mockClear();
  });

  it("edits nothing while closed", () => {
    h.enabled.value = true;
    const { editUserMessage } = renderInput(true);
    h.onEditLast.current();
    expect(editUserMessage).not.toHaveBeenCalled();
    expect(h.editor.commands.setContent).not.toHaveBeenCalled();
  });

  it("edits the last user message when open", () => {
    h.enabled.value = true;
    const { editUserMessage } = renderInput(false);
    h.onEditLast.current();
    expect(editUserMessage).toHaveBeenCalledWith("u1");
    expect(h.editor.commands.setContent).toHaveBeenCalledWith("last question");
  });

  it("keeps the edit with the real constant (false) even if a closure is passed", async () => {
    h.enabled.value = false;
    const actual = await vi.importActual<
      typeof import("@/features/profile-egress/profileActivationAvailability")
    >("@/features/profile-egress/profileActivationAvailability");
    expect(actual.PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
    const { editUserMessage } = renderInput(true);
    h.onEditLast.current();
    expect(editUserMessage).toHaveBeenCalledWith("u1");
  });
});
