import { importDiagnostic } from "../core/importDiagnostics";
import type {
  DecodedImportResource,
  ImportContentBlock,
  ImportDecoder,
  ImportDecoderInput,
} from "./decoderTypes";
import { decodeText } from "./textDecoder";

const DESCRIPTOR = {
  id: "markdown",
  version: "1",
  label: "Markdown",
  extensions: ["md", "markdown"] as const,
} as const;

function parseMarkdownBlocks(
  input: ImportDecoderInput,
  text: string,
): readonly ImportContentBlock[] {
  const lines = text.split("\n");
  const blocks: ImportContentBlock[] = [];
  let paragraphLines: string[] = [];
  let paragraphStartLine = 1;
  let charOffset = 0;

  const flushParagraph = (endLine: number) => {
    if (paragraphLines.length === 0) return;
    const paragraphText = paragraphLines.join("\n").trim();
    if (!paragraphText) {
      paragraphLines = [];
      return;
    }
    blocks.push({
      blockId: `${input.resourceKey}:p${blocks.length}`,
      kind: "paragraph",
      text: paragraphText,
      locator: {
        resourceKey: input.resourceKey,
        relativePath: input.relativePath,
        startLine: paragraphStartLine,
        endLine,
      },
    });
    paragraphLines = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex] ?? "";
    const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
    if (headingMatch) {
      flushParagraph(lineNumber - 1);
      const level = headingMatch[1]?.length ?? 1;
      const headingText = headingMatch[2]?.trim() ?? "";
      blocks.push({
        blockId: `${input.resourceKey}:h${blocks.length}`,
        kind: "heading",
        level,
        text: headingText,
        locator: {
          resourceKey: input.resourceKey,
          relativePath: input.relativePath,
          startLine: lineNumber,
          endLine: lineNumber,
          startOffset: charOffset,
          endOffset: charOffset + line.length,
        },
      });
      charOffset += line.length + 1;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph(lineNumber - 1);
      charOffset += line.length + 1;
      continue;
    }
    if (paragraphLines.length === 0) paragraphStartLine = lineNumber;
    paragraphLines.push(line);
    charOffset += line.length + 1;
  }
  flushParagraph(lines.length);
  return blocks;
}

export const markdownDecoder: ImportDecoder = {
  descriptor: DESCRIPTOR,
  decode(input: ImportDecoderInput): DecodedImportResource {
    const text = decodeText(input.bytes, input.encoding);
    const blocks = parseMarkdownBlocks(input, text);
    return {
      resourceKey: input.resourceKey,
      relativePath: input.relativePath,
      kind: "markdown",
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
                "No markdown blocks extracted",
                input.relativePath,
              ),
            ]
          : [],
    };
  },
};

export { parseMarkdownBlocks };
