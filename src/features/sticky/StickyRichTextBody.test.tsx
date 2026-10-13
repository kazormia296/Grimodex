// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StickyRichTextBody } from "./StickyRichTextBody";

// 付箋本文は generateHTML の結果を dangerouslySetInnerHTML で描画する唯一の経路。
// 安全性は TipTap のスキーマと Link の URI 検査に依存しているため、
// 付箋用拡張の変更でその前提が崩れたら検知する。
function renderBody(doc: object) {
  render(<StickyRichTextBody body={JSON.stringify(doc)} />);
  return screen.getByTestId("sticky-body-view");
}

function paragraph(...content: object[]) {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

describe("StickyRichTextBody HTML injection guard", () => {
  it("renders markup-looking text as plain text", () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const view = renderBody(paragraph({ type: "text", text: payload }));

    expect(view.querySelector("img, script")).toBeNull();
    expect(view).toHaveTextContent(payload);
  });

  it("strips javascript: hrefs from links", () => {
    const view = renderBody(
      paragraph({
        type: "text",
        text: "click",
        marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
      }),
    );

    const anchor = view.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
  });

  it("drops undeclared attributes and escapes declared attribute values", () => {
    const view = renderBody(
      paragraph({
        type: "text",
        text: "ai text",
        marks: [
          {
            type: "authorship",
            attrs: {
              source: '"><img src=x onerror="alert(1)">',
              onmouseover: "alert(2)",
            },
          },
        ],
      }),
    );

    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector("[onmouseover], [onerror]")).toBeNull();
    expect(view.querySelector("[data-authorship]")).toHaveTextContent(
      "ai text",
    );
  });

  it("renders nothing for node types outside the sticky schema", () => {
    const view = renderBody({
      type: "doc",
      content: [{ type: "script", content: [{ type: "text", text: "x" }] }],
    });

    expect(view).toBeEmptyDOMElement();
  });
});
