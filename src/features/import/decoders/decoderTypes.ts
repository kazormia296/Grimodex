import type { ImportDiagnostic } from "../core/importDiagnostics";

export type DecodedResourceKind =
  | "text"
  | "markdown"
  | "json"
  | "html"
  | "table"
  | "binary"
  | "unknown";

export interface ImportSourceLocator {
  readonly resourceKey: string;
  readonly relativePath: string;
  /** Inclusive UTF-16 code unit offset within decoded text, when applicable. */
  readonly startOffset?: number;
  /** Exclusive UTF-16 code unit offset within decoded text, when applicable. */
  readonly endOffset?: number;
  /** 1-based line number when line-oriented. */
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ImportContentBlock {
  readonly blockId: string;
  readonly kind: "paragraph" | "heading" | "table-row" | "json-leaf" | "raw";
  readonly level?: number;
  readonly text: string;
  readonly locator: ImportSourceLocator;
}

export interface DecodedImportResource {
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly kind: DecodedResourceKind;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly encoding?: string;
  readonly blocks: readonly ImportContentBlock[];
  readonly structuredData?: unknown;
  readonly diagnostics: readonly ImportDiagnostic[];
}

export interface ImportDecoderDescriptor {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly mimeTypes?: readonly string[];
  readonly magicPrefixes?: readonly string[];
}

export interface ImportDecoderInput {
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly encoding?: string;
}

export interface ImportDecoder {
  readonly descriptor: ImportDecoderDescriptor;
  decode(input: ImportDecoderInput): DecodedImportResource;
}

export function decoderKey(id: string, version: string): string {
  return `${id}@${version}`;
}
