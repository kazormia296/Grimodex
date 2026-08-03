// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";

// Renderer が SQL ではなく owner lane + span DTO を 1 typed command へ渡すことを
// 検証する。DELETE+INSERT の transaction は Rust 側が所有する。
const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

vi.mock("@/db/client", () => ({
  db: {},
}));

import { saveAuthorshipSpans } from "./api";

function createEditor(content: string) {
  return new Editor({ extensions: [StarterKit, AuthorshipMark], content });
}

function addAuthorshipMark(editor: Editor) {
  const markType = editor.schema.marks["authorship"];
  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      tr.addMark(
        1,
        editor.state.doc.content.size - 1,
        markType.create({ source: "ai" }),
      );
      return true;
    })
    .run();
}

describe("saveAuthorshipSpans atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ rows: [] });
  });

  it("owner lane と span を typed aggregate command へ渡す", async () => {
    const editor = createEditor("<p>AIの文章</p>");
    addAuthorshipMark(editor);

    await saveAuthorshipSpans("n1", editor.state.doc);

    expect(mockInvoke).toHaveBeenCalledOnce();
    const [cmd, payload] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("authorship_replace_lane");
    expect(payload).toMatchObject({
      payload: {
        lane: { kind: "node", nodeId: "n1" },
        spans: [
          {
            source: "ai",
            model: null,
            chatMsgId: null,
            traceId: null,
          },
        ],
      },
    });
    editor.destroy();
  });

  it("マーク無しでも空 spans を送る(scene-clear 掃除を維持)", async () => {
    const editor = createEditor("<p>マーク無し本文</p>");

    await saveAuthorshipSpans("n1", editor.state.doc);

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke.mock.calls[0][0]).toBe("authorship_replace_lane");
    expect(mockInvoke.mock.calls[0][1]).toEqual({
      payload: {
        lane: { kind: "node", nodeId: "n1" },
        spans: [],
      },
    });
    editor.destroy();
  });
});
