// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ForeshadowSetupMark } from "./marks/ForeshadowSetupMark";
import { ForeshadowPayoffMark } from "./marks/ForeshadowPayoffMark";

// Mock the db module
vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

import { extractSetupAnchors, extractPayoffAnchors } from "./saveAnchors";

function createTestEditor(content = "<p>テスト</p>") {
  return new Editor({
    extensions: [StarterKit, ForeshadowSetupMark, ForeshadowPayoffMark],
    content,
  });
}

describe("extractSetupAnchors", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createTestEditor();
  });

  it("returns empty array when no setup marks present", () => {
    const result = extractSetupAnchors("scene-1", editor.state.doc);
    expect(result).toEqual([]);
  });

  it("extracts setup mark with correct positions and attrs", () => {
    editor.chain().focus().setContent("<p>前振りテキスト</p>").run();
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const setupMarkType = editor.schema.marks["foreshadowSetup"];
        const from = 1;
        const to = editor.state.doc.content.size - 1;
        tr.addMark(
          from,
          to,
          setupMarkType.create({ setupId: "s-001", foreshadowId: "f-001" }),
        );
        return true;
      })
      .run();

    const result = extractSetupAnchors("scene-1", editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s-001");
    expect(result[0].foreshadowId).toBe("f-001");
    expect(result[0].sceneId).toBe("scene-1");
    expect(result[0].fromPos).toBeGreaterThanOrEqual(1);
    expect(result[0].toPos).toBeGreaterThan(result[0].fromPos);
    editor.destroy();
  });

  it("extracts multiple setup marks", () => {
    editor.chain().focus().setContent("<p>テキストA</p><p>テキストB</p>").run();
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const setupMarkType = editor.schema.marks["foreshadowSetup"];
        tr.addMark(
          1,
          5,
          setupMarkType.create({ setupId: "s-A", foreshadowId: "f-1" }),
        );
        tr.addMark(
          9,
          14,
          setupMarkType.create({ setupId: "s-B", foreshadowId: "f-2" }),
        );
        return true;
      })
      .run();

    const result = extractSetupAnchors("scene-2", editor.state.doc);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("s-A");
    expect(ids).toContain("s-B");
    editor.destroy();
  });
});

describe("extractPayoffAnchors", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createTestEditor();
  });

  it("returns empty array when no payoff marks present", () => {
    const result = extractPayoffAnchors("scene-1", editor.state.doc);
    expect(result).toEqual([]);
  });

  it("extracts payoff mark with correct positions and foreshadowId", () => {
    editor.chain().focus().setContent("<p>回収テキスト</p>").run();
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const payoffMarkType = editor.schema.marks["foreshadowPayoff"];
        const from = 1;
        const to = editor.state.doc.content.size - 1;
        tr.addMark(
          from,
          to,
          payoffMarkType.create({ foreshadowId: "f-payoff" }),
        );
        return true;
      })
      .run();

    const result = extractPayoffAnchors("scene-1", editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].foreshadowId).toBe("f-payoff");
    expect(result[0].sceneId).toBe("scene-1");
    expect(result[0].fromPos).toBeGreaterThanOrEqual(1);
    expect(result[0].toPos).toBeGreaterThan(result[0].fromPos);
    editor.destroy();
  });
});
