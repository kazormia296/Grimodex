import type { NarrativeInvalidationPolicy } from "@/features/narrative-extraction/maintenance/invalidationPolicy";

export type CodexChangeSignal =
  | "name-or-alias"
  | "summary-or-content"
  | "type"
  | "detail-definition"
  | "relation-human-edit";

export function adviseCodexInvalidation(signal: CodexChangeSignal): {
  readonly signal: CodexChangeSignal;
  readonly policy: NarrativeInvalidationPolicy;
  readonly autoApply: false;
  readonly rerunMentionObservations: boolean;
  readonly notes: string;
} {
  switch (signal) {
    case "name-or-alias":
      return {
        signal,
        policy: "resolve-only",
        autoApply: false,
        rerunMentionObservations: false,
        notes: "Entity Binding / Relation match を再評価。本文 Mention は維持",
      };
    case "summary-or-content":
      return {
        signal,
        policy: "rerun-local",
        autoApply: false,
        rerunMentionObservations: false,
        notes:
          "Context 依存 Synthesis だけ context-stale。Exact Evidence は維持",
      };
    case "type":
      return {
        signal,
        policy: "resolve-only",
        autoApply: false,
        rerunMentionObservations: false,
        notes:
          "Type Resolution / Detail Mapping を再評価。Entity Identity は維持",
      };
    case "detail-definition":
      return {
        signal,
        policy: "recompile-only",
        autoApply: false,
        rerunMentionObservations: false,
        notes: "Detail Projection / Phase Compiler を再実行",
      };
    case "relation-human-edit":
      return {
        signal,
        policy: "manual",
        autoApply: false,
        rerunMentionObservations: false,
        notes: "Relation Contribution を user-owned にする",
      };
  }
}
