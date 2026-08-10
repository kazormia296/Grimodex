import { importDiagnostic } from "../core/importDiagnostics";
import type {
  DecodedImportResource,
  ImportContentBlock,
  ImportDecoder,
  ImportDecoderInput,
} from "./decoderTypes";
import { decodeText } from "./textDecoder";

const DESCRIPTOR = {
  id: "html",
  version: "1",
  label: "HTML",
  extensions: ["html", "htm"] as const,
} as const;

function stripHtmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ");
  text = text.replace(/<!--[\s\S]*?-->/gu, " ");
  text = text.replace(/<br\s*\/?>/giu, "\n");
  text = text.replace(/<\/p>/giu, "\n\n");
  text = text.replace(/<\/h[1-6]>/giu, "\n\n");
  text = text.replace(/<[^>]+>/gu, " ");
  text = text
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
  return text.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function buildParagraphBlocks(
  input: ImportDecoderInput,
  text: string,
): readonly ImportContentBlock[] {
  return text
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({
      blockId: `${input.resourceKey}:html-p${index}`,
      kind: "paragraph" as const,
      text: paragraph,
      locator: {
        resourceKey: input.resourceKey,
        relativePath: input.relativePath,
      },
    }));
}

export const htmlDecoder: ImportDecoder = {
  descriptor: DESCRIPTOR,
  decode(input: ImportDecoderInput): DecodedImportResource {
    const html = decodeText(input.bytes, input.encoding);
    const text = stripHtmlToText(html);
    const blocks = buildParagraphBlocks(input, text);
    return {
      resourceKey: input.resourceKey,
      relativePath: input.relativePath,
      kind: "html",
      decoderId: DESCRIPTOR.id,
      decoderVersion: DESCRIPTOR.version,
      encoding: input.encoding ?? "utf-8",
      blocks,
      diagnostics:
        blocks.length === 0
          ? [
              importDiagnostic(
                "warn",
                "empty-content",
                "No text extracted from HTML",
                input.relativePath,
              ),
            ]
          : [],
    };
  },
};

export { stripHtmlToText, buildParagraphBlocks as buildHtmlParagraphBlocks };
