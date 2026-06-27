// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SceneBeatNode } from "./SceneBeatNode";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, SceneBeatNode],
    content,
  });
}

describe("SceneBeatNode", () => {
  it("registers as a block node with inline content", () => {
    const editor = createTestEditor();
    const nodeType = editor.schema.nodes["sceneBeat"];
    expect(nodeType).toBeDefined();
    expect(nodeType.isBlock).toBe(true);
    expect(nodeType.spec.content).toBe("inline*");
    editor.destroy();
  });

  it("declares the documented attributes with sensible defaults", () => {
    const editor = createTestEditor();
    const attrs = editor.schema.nodes["sceneBeat"].spec.attrs!;
    expect(attrs.id).toBeDefined();
    expect(attrs.collapsed.default).toBe(false);
    expect(attrs.beatType.default).toBe("free");
    expect(attrs.pov.default).toBeNull();
    editor.destroy();
  });

  it("round-trips attrs through HTML parse/render", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: {
          id: "beat-1",
          collapsed: true,
          beatType: "dialogue",
          pov: "char-42",
        },
        content: [{ type: "text", text: "雨の夜、廃社の前で立ち止まる朱音" }],
      })
      .run();

    const html = editor.getHTML();
    expect(html).toContain('data-type="scene-beat"');
    expect(html).toContain('data-beat-id="beat-1"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('data-beat-type="dialogue"');
    expect(html).toContain('data-pov="char-42"');

    const round = createTestEditor(html);
    let found = false;
    round.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") {
        found = true;
        expect(node.attrs.id).toBe("beat-1");
        expect(node.attrs.collapsed).toBe(true);
        expect(node.attrs.beatType).toBe("dialogue");
        expect(node.attrs.pov).toBe("char-42");
      }
    });
    expect(found).toBe(true);
    editor.destroy();
    round.destroy();
  });

  it("declares the multi-provider model routing attrs with null defaults", () => {
    const editor = createTestEditor();
    const attrs = editor.schema.nodes["sceneBeat"].spec.attrs!;
    expect(attrs.model.default).toBeNull();
    expect(attrs.modelProvider.default).toBeNull();
    expect(attrs.modelVariant.default).toBeNull();
    expect(attrs.modelEndpointId.default).toBeNull();
    editor.destroy();
  });

  it("round-trips multi-provider model routing attrs through HTML", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: {
          id: "beat-2",
          model: "gpt-4o",
          modelProvider: "openai",
          modelVariant: "v1",
          modelEndpointId: "ep-1",
        },
        content: [{ type: "text", text: "x" }],
      })
      .run();

    const html = editor.getHTML();
    expect(html).toContain('data-beat-model="gpt-4o"');
    expect(html).toContain('data-beat-model-provider="openai"');
    expect(html).toContain('data-beat-model-variant="v1"');
    expect(html).toContain('data-beat-model-endpoint="ep-1"');

    const round = createTestEditor(html);
    let found = false;
    round.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") {
        found = true;
        expect(node.attrs.model).toBe("gpt-4o");
        expect(node.attrs.modelProvider).toBe("openai");
        expect(node.attrs.modelVariant).toBe("v1");
        expect(node.attrs.modelEndpointId).toBe("ep-1");
      }
    });
    expect(found).toBe(true);
    editor.destroy();
    round.destroy();
  });

  it("omits model routing attributes from HTML when null (legacy beats)", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: { id: "beat-3" },
        content: [{ type: "text", text: "y" }],
      })
      .run();
    const html = editor.getHTML();
    expect(html).not.toContain("data-beat-model");
    expect(html).not.toContain("data-beat-model-provider");
    editor.destroy();
  });

  it("falls back to free beatType when value is unknown", () => {
    const editor = createTestEditor(
      '<div data-type="scene-beat" data-beat-type="bogus">x</div>',
    );
    let beatType: unknown;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") beatType = node.attrs.beatType;
    });
    expect(beatType).toBe("free");
    editor.destroy();
  });

  it("rejects block content (paragraphs cannot nest inside)", () => {
    const editor = createTestEditor();
    // PM auto-coerces invalid structure; we just verify the schema
    // refuses paragraphs as children.
    const sceneBeat = editor.schema.nodes["sceneBeat"];
    const paragraph = editor.schema.nodes["paragraph"];
    const text = editor.schema.text("hello");
    const para = paragraph.create(null, text);
    expect(() => sceneBeat.createChecked(null, para)).toThrow();
    editor.destroy();
  });
});
