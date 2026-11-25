import { invoke } from "@/lib/tauri";

// 変更レビューの読み取り（`nir1_change_review_read`）。起動時の graph に入れないため、
// この file は遅延読み込みする画面の code だけが import する。

export type Nir1ChangeReviewObjectChangeKind =
  | "added"
  | "removed"
  | "unchanged"
  | "content-changed"
  | "unresolved";

export type Nir1ChangeReviewEvidenceChangeKind =
  | "unchanged"
  | "relocated"
  | "lost"
  | "gained";

export interface Nir1ChangeReviewEvidence {
  readonly sourceRef: string;
  readonly quote: string;
  readonly change: Nir1ChangeReviewEvidenceChangeKind;
}

export interface Nir1ChangeReviewObject {
  /** `codex:{entityId}` か `codex-relation:{edgeId}`。 */
  readonly identity: string;
  readonly change: Nir1ChangeReviewObjectChangeKind;
  readonly evidence: readonly Nir1ChangeReviewEvidence[];
  readonly evidenceWithheld: boolean;
}

export interface Nir1ChangeReview {
  readonly revisionId: string;
  readonly previousRevisionIds: readonly string[];
  readonly objects: readonly Nir1ChangeReviewObject[];
}

export type Nir1ChangeReviewResponse =
  | { readonly status: "available"; readonly result: Nir1ChangeReview }
  | {
      readonly status: "unavailable";
      readonly result: { readonly reason: string };
    };

export function readNir1ChangeReview(request: {
  readonly expectedWorkspacePath: string;
  readonly projectId: string;
  readonly revisionId: string;
}): Promise<Nir1ChangeReviewResponse> {
  return invoke("nir1_change_review_read", {
    expectedWorkspacePath: request.expectedWorkspacePath,
    projectId: request.projectId,
    revisionId: request.revisionId,
  });
}
