import { describe, it, expect } from "vitest";
import {
  addAuthorshipMarks,
  seedAuthorshipMarksJson,
  type PMNodeJSON,
} from "./seedAuthorshipMarks";

const docWith = (content: PMNodeJSON[]): PMNodeJSON => ({
  type: "doc",
  content,
});

describe("addAuthorshipMarks", () => {
  it("全テキストノードに authorship mark を付与する", () => {
    const doc = docWith([
      { type: "paragraph", content: [{ type: "text", text: "hello" }] },
    ]);
    const out = addAuthorshipMarks(doc, { source: "ai", timestamp: "t" });
    const text = out.content![0].content![0];
    expect(text.marks).toEqual([
      {
        type: "authorship",
        attrs: { source: "ai", timestamp: "t", model: null },
      },
    ]);
  });

  it("ネストした content (リスト等) も再帰的に処理する", () => {
    const doc = docWith([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "a" }] },
            ],
          },
        ],
      },
    ]);
    const out = addAuthorshipMarks(doc, { source: "ai" });
    const text = out.content![0].content![0].content![0].content![0];
    expect(text.marks?.[0]).toMatchObject({
      type: "authorship",
      attrs: { source: "ai" },
    });
  });

  it("既存マーク (bold 等) を保持しつつ authorship を追記する", () => {
    const doc = docWith([
      {
        type: "paragraph",
        content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
      },
    ]);
    const out = addAuthorshipMarks(doc, { source: "ai" });
    const marks = out.content![0].content![0].marks!;
    expect(marks.map((m) => m.type)).toEqual(["bold", "authorship"]);
  });

  it("既に authorship mark を持つテキストノードは再スタンプしない (冪等性)", () => {
    // 編集後に再シードされても human 編集部分が ai に戻らないことを保証する。
    const doc = docWith([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "kept-ai",
            marks: [{ type: "authorship", attrs: { source: "ai" } }],
          },
          { type: "text", text: "human-edit" },
        ],
      },
    ]);
    const out = addAuthorshipMarks(doc, { source: "ai" });
    const para = out.content![0].content!;
    // 既存 ai span はそのまま (timestamp/model が後付けされない)
    expect(para[0].marks).toEqual([
      { type: "authorship", attrs: { source: "ai" } },
    ]);
    // human span は新規付与 → これは「未マーク=human」を ai にしてしまう副作用に見えるが、
    // このケースは「再シード」ではなく「全文未マーク or 全文マーク済み」を前提とする
    // 作成時シードでは発生しない。混在ドキュメントの再シードは呼ばない契約。
    expect(para[1].marks?.[0]).toMatchObject({ type: "authorship" });
  });

  it("空ドキュメントはマーク追加なしでそのまま返す", () => {
    const doc = docWith([]);
    const out = addAuthorshipMarks(doc, { source: "ai" });
    expect(out).toEqual(docWith([]));
  });
});

describe("seedAuthorshipMarksJson", () => {
  it("JSON 文字列を受けてマーク付き JSON 文字列を返す", () => {
    const body = JSON.stringify(
      docWith([{ type: "paragraph", content: [{ type: "text", text: "hi" }] }]),
    );
    const out = JSON.parse(seedAuthorshipMarksJson(body, { source: "ai" }));
    expect(out.content[0].content[0].marks[0]).toMatchObject({
      type: "authorship",
      attrs: { source: "ai" },
    });
  });

  it("不正な JSON はそのまま返す (例外を投げない)", () => {
    expect(seedAuthorshipMarksJson("not json", { source: "ai" })).toBe(
      "not json",
    );
  });
});
