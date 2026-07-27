// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { CodexContentEditor } from "./CodexContentEditor";
import type { DocumentKey } from "@/features/editor/document/documentKey";

const contentEditorMocks = vi.hoisted(() => ({
  capturedContent: vi.fn(),
  setContent: vi.fn(),
  setLiveContent: vi.fn(),
  subscribeLiveContent: vi.fn(
    (_document: unknown, _source: unknown, _apply: (content: object) => void) =>
      () => {},
  ),
  latestEditorConfig: {
    current: undefined as
      | {
          onUpdate?: (args: { editor: { getJSON: () => object } }) => void;
        }
      | undefined,
  },
}));
const {
  capturedContent,
  setContent,
  setLiveContent,
  subscribeLiveContent,
  latestEditorConfig,
} = contentEditorMocks;

vi.mock("@tiptap/react", () => ({
  useEditor: (config: {
    content?: unknown;
    onUpdate?: (args: { editor: { getJSON: () => object } }) => void;
  }) => {
    contentEditorMocks.capturedContent(config.content);
    contentEditorMocks.latestEditorConfig.current = config;
    return {
      getHTML: () => "",
      commands: { setContent: contentEditorMocks.setContent },
      setEditable: vi.fn(),
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
      setLiveContent: contentEditorMocks.setLiveContent,
    }),
  },
  subscribeLiveContentRafCoalesced: contentEditorMocks.subscribeLiveContent,
}));

describe("CodexContentEditor", () => {
  beforeEach(() => {
    capturedContent.mockClear();
    setContent.mockClear();
    setLiveContent.mockClear();
    subscribeLiveContent.mockClear();
    latestEditorConfig.current = undefined;
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

  it("editor.spellCheck 設定 (default false) がラッパーの spellcheck 属性に届く", () => {
    // 設定UIのみ存在し contenteditable に届かなかった配線漏れの regression
    // gate。属性が無いとブラウザ既定 (=有効) にフォールバックする。
    const { getByTestId } = render(
      <CodexContentEditor content="" onContentChange={vi.fn()} />,
    );
    expect(getByTestId("codex-content-editor").getAttribute("spellcheck")).toBe(
      "false",
    );
  });

  it("publishes and subscribes with an explicit exact Phase DocumentKey", () => {
    const phaseDocumentKey: DocumentKey = {
      kind: "codex",
      id: "entry-1",
      phaseId: "phase-1",
    };
    const onContentChange = vi.fn();
    render(
      <CodexContentEditor
        content=""
        onContentChange={onContentChange}
        liveDocumentKey={phaseDocumentKey}
      />,
    );

    expect(subscribeLiveContent).toHaveBeenCalledWith(
      phaseDocumentKey,
      99,
      expect.any(Function),
    );

    const next = {
      type: "doc",
      content: [{ type: "paragraph" }],
    };
    latestEditorConfig.current?.onUpdate?.({
      editor: { getJSON: () => next },
    });
    expect(onContentChange).toHaveBeenCalledWith(JSON.stringify(next));
    expect(setLiveContent).toHaveBeenCalledWith(phaseDocumentKey, next, 99);
  });

  it("applies exact-Phase peer content and reports it to the session owner", () => {
    const phaseDocumentKey: DocumentKey = {
      kind: "codex",
      id: "entry-1",
      phaseId: "phase-1",
    };
    const onExternalSync = vi.fn();
    render(
      <CodexContentEditor
        content=""
        onContentChange={vi.fn()}
        liveDocumentKey={phaseDocumentKey}
        onExternalSync={onExternalSync}
      />,
    );
    setContent.mockClear();

    const next = {
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    };
    const apply = subscribeLiveContent.mock.calls[0]?.[2] as
      | ((content: object) => void)
      | undefined;
    apply?.(next);

    expect(setContent).toHaveBeenCalledWith(next, { emitUpdate: false });
    expect(onExternalSync).toHaveBeenCalledWith(JSON.stringify(next));
  });

  it("explicit null disables live sync even when entryId is present", () => {
    render(
      <CodexContentEditor
        content=""
        onContentChange={vi.fn()}
        entryId="entry-1"
        liveDocumentKey={null}
      />,
    );

    expect(subscribeLiveContent).not.toHaveBeenCalled();
    latestEditorConfig.current?.onUpdate?.({
      editor: { getJSON: () => ({ type: "doc" }) },
    });
    expect(setLiveContent).not.toHaveBeenCalled();
  });
});
