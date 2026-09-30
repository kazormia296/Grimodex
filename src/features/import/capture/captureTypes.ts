import type { Sha256Digest } from "@/features/narrative-extraction/source/types";

/** Lifecycle state of an import capture inventory. */
export type ImportCaptureState = "capturing" | "sealed";

/** Per-entry selection during capture review. */
export type ImportCaptureEntryStatus = "selected" | "excluded";

/** Kind of captured filesystem entry (aligns with Rust capture inventory). */
export type ImportCaptureEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "unknown";

export interface ImportCaptureBudget {
  readonly maxArchiveBytes: number;
  readonly maxTextBytes: number;
  readonly maxFolderBytes: number;
  readonly maxFolderFiles: number;
  readonly maxFolderDepth: number;
}

export interface ImportCaptureEntry {
  readonly entryId: string;
  readonly resourceKey: string;
  readonly parentResourceKey?: string;
  readonly relativePath: string;
  readonly kind: ImportCaptureEntryKind;
  readonly byteLength: number;
  readonly extension?: string;
  readonly captureStatus: ImportCaptureEntryStatus;
  readonly rawDigest?: Sha256Digest;
  readonly blobRef?: string;
}

export interface ImportCaptureManifest {
  readonly captureId: string;
  readonly sourceKind: string;
  readonly state: ImportCaptureState;
  readonly budget: ImportCaptureBudget;
  readonly entries: readonly ImportCaptureEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sealedDigest?: Sha256Digest;
}

export interface ImportCapture extends ImportCaptureManifest {
  readonly version: number;
}
