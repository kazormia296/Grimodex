import { describe, it, expect } from "vitest";
import { stripToolProtocol } from "./toolProtocol";

describe("stripToolProtocol", () => {
  it("removes a single <tool_call> block", () => {
    const input = 'A\n<tool_call>{"name":"web_search"}</tool_call>\nB';
    expect(stripToolProtocol(input)).toBe("A\n\nB");
  });

  it("removes multiple <tool_call> blocks", () => {
    const input =
      'X<tool_call>{"a":1}</tool_call>Y<tool_call>{"b":2}</tool_call>Z';
    expect(stripToolProtocol(input)).toBe("XYZ");
  });

  it("removes a <tool_response> block", () => {
    const input = 'pre<tool_response>{"success":true}</tool_response>post';
    expect(stripToolProtocol(input)).toBe("prepost");
  });

  it("removes both tool_call and tool_response and keeps the answer that follows (reported fixture)", () => {
    const input =
      "検索を行います。\n" +
      '<tool_call>\n{"name": "web_search", "arguments": {"query": "雨ざらし 意味"}}\n</tool_call>\n' +
      '<tool_response>\n{"success": true, "results": [{"title": "Weblio"}]}\n</tool_response>\n' +
      "検索結果をお伝えします。\n\n---\n\n## 「雨ざらし」の意味";
    const out = stripToolProtocol(input);
    // 生のツール記法は消える。
    expect(out).not.toContain("<tool_call>");
    expect(out).not.toContain("</tool_call>");
    expect(out).not.toContain("<tool_response>");
    expect(out).not.toContain("web_search");
    expect(out).not.toContain('"success"');
    // ブロック後の本文（実際の回答）は残る。
    expect(out).toContain("検索を行います。");
    expect(out).toContain("検索結果をお伝えします。");
    expect(out).toContain("## 「雨ざらし」の意味");
  });

  it("leaves content without tool tags byte-identical (no trim, no collapse)", () => {
    const input = "  普通の回答です。\n\n\n余分な改行も保持。  ";
    expect(stripToolProtocol(input)).toBe(input);
  });

  it("drops the rest on an unclosed <tool_call> (streaming partial tail)", () => {
    const input = 'prefix の文章\n<tool_call>\n{"name":"web_s';
    expect(stripToolProtocol(input)).toBe("prefix の文章");
  });

  it("keeps the answer before an unclosed trailing tool_response", () => {
    const input =
      '<tool_call>{"name":"x"}</tool_call>\n回答本文\n<tool_response>{partial';
    expect(stripToolProtocol(input)).toBe("回答本文");
  });

  it("returns empty string when the message is only a tool block", () => {
    const input = '<tool_call>{"name":"web_search"}</tool_call>';
    expect(stripToolProtocol(input)).toBe("");
  });

  it("collapses blank-line runs left behind by removed blocks", () => {
    const input =
      'A\n\n<tool_call>{"a":1}</tool_call>\n\n<tool_response>{"b":2}</tool_response>\n\nB';
    expect(stripToolProtocol(input)).toBe("A\n\nB");
  });

  it("handles empty input", () => {
    expect(stripToolProtocol("")).toBe("");
  });

  // d0766f59 緩和の回避を塞ぐ: 大文字 / 属性付き / タグ内空白の変種も除去する。
  it("removes uppercase tag variants", () => {
    const input = 'A<TOOL_CALL>{"name":"web_search"}</TOOL_CALL>B';
    expect(stripToolProtocol(input)).toBe("AB");
  });

  it("removes opening tags that carry attributes", () => {
    const input = 'A<tool_call type="function" data-x="1">{"n":1}</tool_call>B';
    const out = stripToolProtocol(input);
    expect(out).toBe("AB");
    expect(out).not.toContain("tool_call");
  });

  it("removes tags with whitespace before the closing bracket", () => {
    const input = "pre<tool_response >{...}</tool_response >post";
    expect(stripToolProtocol(input)).toBe("prepost");
  });

  it("removes mixed-case attribute variant of tool_response", () => {
    const input = 'x<Tool_Response status="ok">{"a":1}</Tool_Response>y';
    expect(stripToolProtocol(input)).toBe("xy");
  });
});
