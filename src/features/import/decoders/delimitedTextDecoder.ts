import { importDiagnostic } from "../core/importDiagnostics";
import type {
  DecodedImportResource,
  ImportContentBlock,
  ImportDecoder,
  ImportDecoderInput,
} from "./decoderTypes";
import { decodeText } from "./textDecoder";

const DESCRIPTOR = {
  id: "delimited-text",
  version: "1",
  label: "Delimited Text (CSV/TSV)",
  extensions: ["csv", "tsv"] as const,
} as const;

function detectDelimiter(relativePath: string, firstLine: string): string {
  if (relativePath.toLocaleLowerCase("en-US").endsWith(".tsv")) return "\t";
  const tabCount = (firstLine.match(/\t/gu) ?? []).length;
  const commaCount = (firstLine.match(/,/gu) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseDelimitedLine(
  line: string,
  delimiter: string,
): readonly string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseDelimitedTable(
  input: ImportDecoderInput,
  text: string,
): {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  blocks: ImportContentBlock[];
} {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [], blocks: [] };
  }
  const delimiter = detectDelimiter(input.relativePath, lines[0] ?? "");
  const headers = parseDelimitedLine(lines[0] ?? "", delimiter);
  const rows: string[][] = [];
  const blocks: ImportContentBlock[] = [];

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
    const cells = [...parseDelimitedLine(lines[rowIndex] ?? "", delimiter)];
    rows.push(cells);
    const rowText = headers
      .map((header, colIndex) => `${header}=${cells[colIndex] ?? ""}`)
      .join(" | ");
    blocks.push({
      blockId: `${input.resourceKey}:row${rowIndex}`,
      kind: "table-row",
      text: rowText,
      locator: {
        resourceKey: input.resourceKey,
        relativePath: input.relativePath,
        startLine: rowIndex + 1,
        endLine: rowIndex + 1,
      },
    });
  }

  return { headers, rows, blocks };
}

export const delimitedTextDecoder: ImportDecoder = {
  descriptor: DESCRIPTOR,
  decode(input: ImportDecoderInput): DecodedImportResource {
    const text = decodeText(input.bytes, input.encoding);
    const { headers, rows, blocks } = parseDelimitedTable(input, text);
    const diagnostics = [];
    if (headers.length === 0) {
      diagnostics.push(
        importDiagnostic(
          "warn",
          "empty-table",
          "No table headers found",
          input.relativePath,
        ),
      );
    }
    return {
      resourceKey: input.resourceKey,
      relativePath: input.relativePath,
      kind: "table",
      decoderId: DESCRIPTOR.id,
      decoderVersion: DESCRIPTOR.version,
      encoding: input.encoding ?? "utf-8",
      blocks,
      structuredData: { headers, rows },
      diagnostics,
    };
  },
};

export { parseDelimitedLine, parseDelimitedTable, detectDelimiter };
