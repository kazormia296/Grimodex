import { generateHTML } from "@tiptap/core";
import { memo, type CSSProperties } from "react";
import { getStickyEditorExtensions } from "@/features/editor/extensions";

function parseBody(body: string): object | undefined {
  if (!body) return undefined;
  try {
    return JSON.parse(body) as object;
  } catch {
    return undefined;
  }
}

export const StickyRichTextBody = memo(function StickyRichTextBody({
  body,
  fontSize = 12,
}: {
  body: string;
  fontSize?: CSSProperties["fontSize"];
}) {
  const json = parseBody(body);
  let html = "";
  if (json) {
    try {
      html = generateHTML(json, getStickyEditorExtensions());
    } catch {
      html = "";
    }
  }

  return (
    <div
      data-testid="sticky-body-view"
      data-editor-sticky-ignore="true"
      className="sticky-body-view"
      style={{
        fontSize,
        lineHeight: 1.5,
        color: "rgba(0,0,0,0.68)",
        wordBreak: "break-word",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export { parseBody as parseStickyBody };
