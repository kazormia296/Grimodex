import type { ImportDiagnostic } from "../core/importDiagnostics";
import type { ImportSourcePackageDraft } from "../core/importSourcePackage";

export type ImportInputKind =
  | "file"
  | "zip"
  | "scan-bundle"
  | "editor-seed"
  | "markdown"
  | "plain-text"
  | "unknown";

export interface ImportAdapterCapabilities {
  readonly supportsStructure: boolean;
  readonly supportsCodex: boolean;
  readonly supportsSnippets: boolean;
  readonly supportsReimport: boolean;
}

export interface ImportAdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly inputKinds: readonly ImportInputKind[];
  readonly capabilities: ImportAdapterCapabilities;
}

export interface ImportAdapterParseInput {
  readonly kind: ImportInputKind;
  readonly label: string;
  readonly data: unknown;
}

export interface ImportAdapterParseResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly draft?: ImportSourcePackageDraft;
}

export interface ImportAdapter {
  readonly descriptor: ImportAdapterDescriptor;
  parse(input: ImportAdapterParseInput): ImportAdapterParseResult | Promise<ImportAdapterParseResult>;
}

export function adapterKey(id: string, version: string): string {
  return `${id}@${version}`;
}
