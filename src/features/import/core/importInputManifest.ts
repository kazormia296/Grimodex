import type { ImportInputKind } from "../adapters/adapterTypes";

export interface ImportInputManifestEntry {
  readonly kind: ImportInputKind;
  readonly label: string;
  readonly byteSize?: number;
  readonly mimeType?: string;
}

export interface ImportInputManifest {
  readonly entries: readonly ImportInputManifestEntry[];
}
