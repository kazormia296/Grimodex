// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { collectBeatIds, renumberDuplicateBeatIds } from "./pasteSanitize";

function createEditor(content = "") {
  return new Editor({
    extensions: [
      StarterKit,
      SceneBeatNode,
      GeneratedProseBlockNode,
      AuthorshipMark,
    ],
    content,
  });
}

function insertBeat(editor: Editor, id: string, text = "beat text") {
  editor
    .chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text }],
    })
    .run();
}

describe("collectBeatIds", () => {
  it("ドキュメント内の sceneBeat id を収集する", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    insertBeat(editor, "b2");
    const ids = collectBeatIds(editor.state.doc);
    expect(ids).toEqual(new Set(["b1", "b2"]));
    editor.destroy();
  });

  it("ビートがなければ空 Set を返す", () => {
    const editor = createEditor("<p>本文のみ</p>");
    const ids = collectBeatIds(editor.state.doc);
    expect(ids).toEqual(new Set());
    editor.destroy();
  });
});

describe("renumberDuplicateBeatIds", () => {
  it("既存 ID と重複する JSON を renumber する", () => {
    const existingIds = new Set(["b1", "b2"]);
    const input = {
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "重複ビート" }],
        },
      ],
    };
    const result = renumberDuplicateBeatIds(input, existingIds);
    const beat = (result as { content: { attrs: { id: string } }[] })
      .content[0];
    expect(beat.attrs.id).not.toBe("b1");
    expect(beat.attrs.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("重複しない ID はそのまま保持する", () => {
    const existingIds = new Set(["b1"]);
    const input = {
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: { id: "b99", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "重複なし" }],
        },
      ],
    };
    const result = renumberDuplicateBeatIds(input, existingIds);
    const beat = (result as { content: { attrs: { id: string } }[] })
      .content[0];
    expect(beat.attrs.id).toBe("b99");
  });

  it("renumber された場合、対応する generatedProseBlock の beatId も更新される", () => {
    const existingIds = new Set(["b1"]);
    const input = {
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "重複ビート" }],
        },
        {
          type: "generatedProseBlock",
          attrs: { beatId: "b1", modified: false },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "生成prose" }],
            },
          ],
        },
      ],
    };
    const result = renumberDuplicateBeatIds(input, existingIds) as {
      content: { type: string; attrs: { id?: string; beatId?: string } }[];
    };
    const newBeatId = result.content[0].attrs.id!;
    const block = result.content[1];
    expect(newBeatId).not.toBe("b1");
    expect(block.attrs.beatId).toBe(newBeatId);
  });

  it("renumber された beat に対応しない generatedProseBlock は beatId が null になる（orphan 化）", () => {
    const existingIds = new Set(["b1"]);
    // beatId="b1" の block だが、対応する sceneBeat は同じ input 内に存在しない
    const input = {
      type: "doc",
      content: [
        {
          type: "generatedProseBlock",
          attrs: { beatId: "b1", modified: false },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "orphan prose" }],
            },
          ],
        },
      ],
    };
    // existingIds に b1 があるが、input 内に sceneBeat はない → orphan → beatId=null
    const result = renumberDuplicateBeatIds(input, existingIds) as {
      content: { type: string; attrs: { beatId: string | null } }[];
    };
    expect(result.content[0].attrs.beatId).toBeNull();
  });

  it("ネストした ID なし（content なし）でもクラッシュしない", () => {
    const existingIds = new Set<string>();
    const input = { type: "doc", content: [] };
    expect(() => renumberDuplicateBeatIds(input, existingIds)).not.toThrow();
  });
});
