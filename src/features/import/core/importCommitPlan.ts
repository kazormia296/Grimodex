import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { ImportTargetSpec } from "./importTargetSpec";

export interface ImportBaseline {
  readonly sourceSetId: string;
  readonly packageDigest: Sha256Digest;
  readonly committedAt: string;
  readonly projectId: string;
}

export interface ImportCommitMapEntry {
  readonly sourceKey: string;
  readonly targetNodeId: string;
  readonly targetKind: "folder" | "scene" | "document" | "codex" | "snippet";
}

export interface ImportCommitMap {
  readonly sessionId: string;
  readonly entries: readonly ImportCommitMapEntry[];
  readonly baseline?: ImportBaseline;
}

export type ImportCommitOperationKind =
  | "create-node"
  | "update-document"
  | "create-codex"
  | "create-snippet";

export interface ImportCommitOperation {
  readonly id: string;
  readonly kind: ImportCommitOperationKind;
  readonly sourceKey: string;
  readonly label: string;
}

export interface ImportCommitPlan {
  readonly sessionId: string;
  readonly target: ImportTargetSpec;
  readonly packageDigest: Sha256Digest;
  readonly operations: readonly ImportCommitOperation[];
  readonly commitMap: ImportCommitMap;
}
