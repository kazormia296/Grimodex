// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { CodexContentEditor } from "./CodexContentEditor";

const capturedContent = vi.fn();

vi.mock("@tiptap/react", () => ({
  useEditor: (config: { content?: unknown }) => {
    capturedContent(config.content);
    return {
      getHTML: () => "",
      commands: { setContent: vi.fn() },
      destroy: vi.fn(),
    };
  },
  EditorContent: () => <div />,
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: () => ({}) },
}));

vi.mock("@/features/attribution/AuthorshipMark", () => ({
  AuthorshipMark: {},
}));

vi.mock("@/features/attribution/useAttribution", () => ({
  useAttribution: vi.fn(),
}));

vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));

vi.mock("@/features/editor/sceneContentStore", () => ({
  useSceneContentStore: {
    getState: () => ({
      subscribe: vi.fn(() => () => {}),
      setLiveContent: vi.fn(),
    }),
  },
}));

describe("CodexContentEditor", () => {
  beforeEach(() => {
    capturedContent.mockClear();
  });

  it("JSON文字列をパースしてオブジェクトとしてuseEditorに渡す", () => {
    const jsonString = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "入力した内容" }],
        },
      ],
    });

    render(
      <CodexContentEditor content={jsonString} onContentChange={vi.fn()} />,
    );

    const passed = capturedContent.mock.calls[0][0];
    // 文字列ではなくオブジェクトとして渡されること（生JSONの表示を防ぐ）
    expect(typeof passed).toBe("object");
    expect(passed).toMatchObject({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it('"{}"は空文字列としてuseEditorに渡す', () => {
    render(<CodexContentEditor content="{}" onContentChange={vi.fn()} />);

    expect(capturedContent.mock.calls[0][0]).toBe("");
  });

  it("空文字列は空文字列としてuseEditorに渡す", () => {
    render(<CodexContentEditor content="" onContentChange={vi.fn()} />);

    expect(capturedContent.mock.calls[0][0]).toBe("");
  });
});
