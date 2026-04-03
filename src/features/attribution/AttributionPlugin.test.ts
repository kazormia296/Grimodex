// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { attributionKey, createAttributionPlugin } from "./AttributionPlugin";
import { useAttributionStore } from "./attributionStore";

function createTestEditor(content = "") {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
  editor.registerPlugin(createAttributionPlugin());
  return editor;
}

function insertAiText(editor: Editor, text: string) {
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: "text",
        text,
        marks: [
          {
            type: "authorship",
            attrs: {
              source: "ai",
              chatMessageId: "msg-1",
              timestamp: "2026-03-31T00:00:00.000Z",
              model: "claude-sonnet-4.6",
            },
          },
        ],
      },
    ])
    .run();
}

// ProseMirror inline Decoration stores attrs in type.attrs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDecoAttrs(deco: any): Record<string, string> {
  return deco.type?.attrs ?? {};
}

describe("AttributionPlugin", () => {
  beforeEach(() => {
    useAttributionStore.setState({ showAttribution: false });
  });

  it("returns empty decorations when attribution is hidden", () => {
    const editor = createTestEditor("<p>テスト</p>");
    insertAiText(editor, "AI文章");

    const decoSet = attributionKey.getState(editor.state);
    const decos = decoSet.find();
    expect(decos).toHaveLength(0);
    editor.destroy();
  });

  it("creates decorations for AI text when attribution is shown", () => {
    useAttributionStore.setState({ showAttribution: true });
    const editor = createTestEditor("<p>テスト</p>");
    insertAiText(editor, "AI文章");

    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    const decoSet = attributionKey.getState(editor.state);
    const decos = decoSet.find();
    expect(decos.length).toBeGreaterThan(0);

    const attrs = getDecoAttrs(decos[0]);
    expect(attrs.class).toBe("attribution-ai");
    expect(attrs["data-attribution-source"]).toBe("ai");
    expect(attrs["data-attribution-model"]).toBe("claude-sonnet-4.6");
    editor.destroy();
  });

  it("does not decorate human-source text", () => {
    useAttributionStore.setState({ showAttribution: true });
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "人間の文章",
          marks: [
            {
              type: "authorship",
              attrs: { source: "human" },
            },
          ],
        },
      ])
      .run();

    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    const decoSet = attributionKey.getState(editor.state);
    const decos = decoSet.find();
    expect(decos).toHaveLength(0);
    editor.destroy();
  });

  it("applies unknown class for unknown source", () => {
    useAttributionStore.setState({ showAttribution: true });
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "編集済み",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "unknown",
                timestamp: "2026-03-31T00:00:00.000Z",
              },
            },
          ],
        },
      ])
      .run();

    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    const decoSet = attributionKey.getState(editor.state);
    const decos = decoSet.find();
    expect(decos.length).toBeGreaterThan(0);
    expect(getDecoAttrs(decos[0]).class).toBe("attribution-unknown");
    editor.destroy();
  });

  it("applies unknown class for unknown source", () => {
    useAttributionStore.setState({ showAttribution: true });
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "不明テキスト",
          marks: [
            {
              type: "authorship",
              attrs: { source: "unknown" },
            },
          ],
        },
      ])
      .run();

    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    const decoSet = attributionKey.getState(editor.state);
    const decos = decoSet.find();
    expect(decos.length).toBeGreaterThan(0);
    expect(getDecoAttrs(decos[0]).class).toBe("attribution-unknown");
    editor.destroy();
  });

  it("clears decorations when toggled off", () => {
    useAttributionStore.setState({ showAttribution: true });
    const editor = createTestEditor("<p>テスト</p>");
    insertAiText(editor, "AI文章");

    let { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    let decos = attributionKey.getState(editor.state).find();
    expect(decos.length).toBeGreaterThan(0);

    // Toggle off
    useAttributionStore.setState({ showAttribution: false });
    tr = editor.state.tr;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    decos = attributionKey.getState(editor.state).find();
    expect(decos).toHaveLength(0);
    editor.destroy();
  });

  it("adds manual-override class and data attribute for overridden marks", () => {
    useAttributionStore.setState({ showAttribution: true });
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "上書き済み",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "human",
                manualOverride: true,
              },
            },
          ],
        },
      ])
      .run();

    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);

    // human source is not decorated, so test with ai + manualOverride
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "手動AI",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai",
                manualOverride: true,
              },
            },
          ],
        },
      ])
      .run();

    const tr2 = editor.state.tr;
    tr2.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr2);

    const decoSet = attributionKey.getState(editor.state);
    const decos = decoSet.find();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overrideDeco = decos.find((d: any) => {
      const attrs = getDecoAttrs(d);
      return attrs["data-manual-override"] === "true";
    });
    expect(overrideDeco).toBeDefined();
    expect(getDecoAttrs(overrideDeco!).class).toContain(
      "attribution-manual-override",
    );
    editor.destroy();
  });
});
