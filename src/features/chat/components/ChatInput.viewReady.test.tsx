// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput, readChatInputEditorState } from "./ChatInput";

const h = vi.hoisted(() => {
  let successfulViewReads = 0;
  const editor = {
    isDestroyed: false,
    get view() {
      if (successfulViewReads > 0) {
        successfulViewReads -= 1;
        return { dom: {} };
      }
      throw new Error("The editor view is not available");
    },
    on: vi.fn(),
    off: vi.fn(),
    setEditable: vi.fn(),
    getText: vi.fn(() => ""),
    storage: {},
    state: {
      doc: { descendants: vi.fn() },
    },
    commands: {
      clearContent: vi.fn(),
      focus: vi.fn(),
      setContent: vi.fn(),
    },
  };
  return {
    editor,
    setSuccessfulViewReads(value: number) {
      successfulViewReads = value;
    },
  };
});

vi.mock("@tiptap/react", () => ({
  EditorContent: () => null,
  useEditor: () => h.editor,
  useEditorState: () => ({ hasText: false, text: "", hasMentions: false }),
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

describe("ChatInput editor view readiness", () => {
  beforeEach(() => {
    h.setSuccessfulViewReads(0);
  });

  it("does not access view.dom before TipTap mounts the editor view", () => {
    expect(() => render(<ChatInput onSend={vi.fn()} />)).not.toThrow();
  });

  it("rechecks view readiness when React reconnects passive effects", () => {
    // Initial render sees a mounted view, but TipTap detaches it before passive
    // effects reconnect. The effect must probe again instead of trusting the
    // render-time readiness snapshot.
    h.setSuccessfulViewReads(2);
    expect(() => render(<ChatInput onSend={vi.fn()} />)).not.toThrow();
  });

  it("returns an empty state when the subscribed editor has been destroyed", () => {
    const getText = vi.fn(() => {
      throw new Error("schema is no longer available");
    });
    const destroyedEditor = {
      isDestroyed: true,
      get view(): never {
        throw new Error("view is no longer available");
      },
      getText,
    };

    expect(readChatInputEditorState(destroyedEditor as never)).toEqual({
      hasText: false,
      text: "",
      hasMentions: false,
    });
    expect(getText).not.toHaveBeenCalled();
  });
});
