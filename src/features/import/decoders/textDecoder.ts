import { importDiagnostic } from "../core/importDiagnostics";
import type {
  DecodedImportResource,
  ImportContentBlock,
  ImportDecoder,
  ImportDecoderInput,
} from "./decoderTypes";

const DESCRIPTOR = {
  id: "text",
  version: "1",
  label: "Plain Text",
  extensions: ["txt", "text"] as const,
} as const;

function splitParagraphs(text: string): readonly string[] {
  return text
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildBlocks(
  input: ImportDecoderInput,
  text: string,
): readonly ImportContentBlock[] {
  const paragraphs = splitParagraphs(text);
  let offset = 0;
  return paragraphs.map((paragraph, index) => {
    const start = text.indexOf(paragraph, offset);
    const end = start + paragraph.length;
    offset = end;
    return {
      blockId: `${input.resourceKey}:p${index}`,
      kind: "paragraph" as const,
      text: paragraph,
      locator: {
        resourceKey: input.resourceKey,
        relativePath: input.relativePath,
        startOffset: start >= 0 ? start : undefined,
        endOffset: start >= 0 ? end : undefined,
      },
    };
  });
}

function decodeText(bytes: Uint8Array, encoding?: string): string {
  const decoder = new TextDecoder(encoding ?? "utf-8", { fatal: false });
  return decoder.decode(bytes);
}

export const textDecoder: ImportDecoder = {
  descriptor: DESCRIPTOR,
  decode(input: ImportDecoderInput): DecodedImportResource {
    const text = decodeText(input.bytes, input.encoding);
    return {
      resourceKey: input.resourceKey,
      relativePath: input.relativePath,
      kind: "text",
      decoderId: DESCRIPTOR.id,
      decoderVersion: DESCRIPTOR.version,
      encoding: input.encoding ?? "utf-8",
      blocks: buildBlocks(input, text),
      diagnostics:
        text.length === 0
          ? [
              importDiagnostic(
                "warn",
                "empty-content",
                "Decoded text is empty",
                input.relativePath,
              ),
            ]
          : [],
    };
  },
};

export { splitParagraphs, buildBlocks as buildTextBlocks, decodeText };
