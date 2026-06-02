// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";

// DELETE+INSERT を別々の IPC ではなく 1 つの db_execute_batch(BEGIN..COMMIT)で
// 実行することを検証する。間でクラッシュすると帰属メタが全損する atomicity バグの回帰防止。
const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

vi.mock("@/db/client", () => ({
  db: {
    delete: () => ({
      where: () => ({
        toSQL: () => ({
          sql: "DELETE FROM authorship_spans WHERE node_id = ?",
          params: ["n1"],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        toSQL: () => ({
          sql: "INSERT INTO authorship_spans (id, node_id) VALUES (?, ?)",
          params: ["span-1", "n1"],
        }),
      }),
    }),
  },
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

  it("DELETE+INSERT を 1 回の db_execute_batch で原子的に実行する", async () => {
    const editor = createEditor("<p>AIの文章</p>");
    addAuthorshipMark(editor);

    await saveAuthorshipSpans("n1", editor.state.doc);

    expect(mockInvoke).toHaveBeenCalledOnce();
    const [cmd, payload] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("db_execute_batch");
    const stmts = (payload as { statements: { sql: string }[] }).statements;
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain("DELETE");
    expect(stmts[1].sql).toContain("INSERT");
    editor.destroy();
  });

  it("マーク無しでも DELETE だけは batch で実行する(scene-clear 掃除を維持)", async () => {
    const editor = createEditor("<p>マーク無し本文</p>");

    await saveAuthorshipSpans("n1", editor.state.doc);

    expect(mockInvoke).toHaveBeenCalledOnce();
    const payload = mockInvoke.mock.calls[0][1] as {
      statements: { sql: string }[];
    };
    expect(payload.statements).toHaveLength(1);
    expect(payload.statements[0].sql).toContain("DELETE");
    editor.destroy();
  });
});
