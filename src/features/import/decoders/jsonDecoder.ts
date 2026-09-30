import type { ImportDiagnostic } from "../core/importDiagnostics";
import { importDiagnostic } from "../core/importDiagnostics";
import type {
  DecodedImportResource,
  ImportContentBlock,
  ImportDecoder,
  ImportDecoderInput,
} from "./decoderTypes";
import { decodeText } from "./textDecoder";

const DESCRIPTOR = {
  id: "json",
  version: "1",
  label: "JSON",
  extensions: ["json"] as const,
  magicPrefixes: ["{", "["] as const,
} as const;

const MAX_JSON_DEPTH = 8;
const MAX_JSON_LEAF_BLOCKS = 256;

function collectJsonLeaves(
  input: ImportDecoderInput,
  value: unknown,
  path: string,
  depth: number,
  blocks: ImportContentBlock[],
): void {
  if (blocks.length >= MAX_JSON_LEAF_BLOCKS) return;
  if (depth > MAX_JSON_DEPTH) return;

  if (value === null || typeof value !== "object") {
    blocks.push({
      blockId: `${input.resourceKey}:json:${blocks.length}`,
      kind: "json-leaf",
      text: `${path}: ${String(value)}`,
      locator: {
        resourceKey: input.resourceKey,
        relativePath: input.relativePath,
      },
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectJsonLeaves(input, item, `${path}[${index}]`, depth + 1, blocks);
    });
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    collectJsonLeaves(input, child, childPath, depth + 1, blocks);
  }
}

export const jsonDecoder: ImportDecoder = {
  descriptor: DESCRIPTOR,
  decode(input: ImportDecoderInput): DecodedImportResource {
    const text = decodeText(input.bytes, input.encoding);
    const diagnostics: ImportDiagnostic[] = [];
    let structuredData: unknown;
    try {
      structuredData = JSON.parse(text);
    } catch {
      diagnostics.push(
        importDiagnostic(
          "error",
          "json-parse-failed",
          "Invalid JSON",
          input.relativePath,
        ),
      );
      return {
        resourceKey: input.resourceKey,
        relativePath: input.relativePath,
        kind: "json",
        decoderId: DESCRIPTOR.id,
        decoderVersion: DESCRIPTOR.version,
        encoding: input.encoding ?? "utf-8",
        blocks: [],
        diagnostics,
      };
    }

    const blocks: ImportContentBlock[] = [];
    collectJsonLeaves(input, structuredData, "", 0, blocks);
    return {
      resourceKey: input.resourceKey,
      relativePath: input.relativePath,
      kind: "json",
      decoderId: DESCRIPTOR.id,
      decoderVersion: DESCRIPTOR.version,
      encoding: input.encoding ?? "utf-8",
      blocks,
      structuredData,
      diagnostics,
    };
  },
};

export { collectJsonLeaves };
