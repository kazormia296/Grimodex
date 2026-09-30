import {
  defaultTreeAdapter,
  parseFragment,
  type DefaultTreeAdapterMap,
} from "parse5";
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

type HtmlNode = DefaultTreeAdapterMap["node"];

const SKIPPED_ELEMENTS = new Set(["script", "style", "template"]);
const PARAGRAPH_ELEMENTS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

function appendHtmlText(node: HtmlNode, chunks: string[]): void {
  if (defaultTreeAdapter.isTextNode(node)) {
    chunks.push(defaultTreeAdapter.getTextNodeContent(node));
    return;
  }

  if (!defaultTreeAdapter.isElementNode(node)) return;

  const tagName = defaultTreeAdapter.getTagName(node).toLowerCase();
  if (SKIPPED_ELEMENTS.has(tagName)) return;

  if (tagName === "br") {
    chunks.push("\n");
    return;
  }

  for (const child of defaultTreeAdapter.getChildNodes(node)) {
    appendHtmlText(child, chunks);
  }

  if (PARAGRAPH_ELEMENTS.has(tagName)) chunks.push("\n\n");
}

function stripHtmlToText(html: string): string {
  const fragment = parseFragment(html);
  const chunks: string[] = [];
  for (const child of defaultTreeAdapter.getChildNodes(fragment)) {
    appendHtmlText(child, chunks);
  }

  return chunks
    .join("")
    .replace(/\u00a0/gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
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
