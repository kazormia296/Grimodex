import type { NarrativeInvalidationPolicy } from "@/features/narrative-extraction/maintenance/invalidationPolicy";

export type ForeshadowChangeSignal =
  | "setup-or-payoff-content"
  | "reading-order"
  | "codex-link"
  | "payoff-quote-removed";

export function adviseForeshadowInvalidation(signal: ForeshadowChangeSignal): {
  readonly signal: ForeshadowChangeSignal;
  readonly policy: NarrativeInvalidationPolicy;
  readonly autoApply: false;
  readonly autoDeleteRoot: false;
  readonly notes: string;
} {
  switch (signal) {
    case "setup-or-payoff-content":
      return {
        signal,
        policy: "rerun-cluster",
        autoApply: false,
        autoDeleteRoot: false,
        notes: "Anchor / Support Edge / Lifecycle / Quality を再評価する",
      };
    case "reading-order":
      return {
        signal,
        policy: "resolve-only",
        autoApply: false,
        autoDeleteRoot: false,
        notes: "Setup-before-Payoff 関係を再評価する",
      };
    case "codex-link":
      return {
        signal,
        policy: "resolve-only",
        autoApply: false,
        autoDeleteRoot: false,
        notes: "関連 Entity Resolution と Quality Review を再評価する",
      };
    case "payoff-quote-removed":
      return {
        signal,
        policy: "revalidate-exact",
        autoApply: false,
        autoDeleteRoot: false,
        notes: "Root は削除せず Lifecycle 再計算候補だけ出す",
      };
  }
}
