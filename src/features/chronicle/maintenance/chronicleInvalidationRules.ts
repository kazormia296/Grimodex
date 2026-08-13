import type { NarrativeInvalidationPolicy } from "@/features/narrative-extraction/maintenance/invalidationPolicy";

export type ChronicleChangeSignal =
  | "scene-content"
  | "scene-title"
  | "event-title-human-edit"
  | "event-link"
  | "calendar";

export interface ChronicleInvalidationAdvice {
  readonly signal: ChronicleChangeSignal;
  readonly policy: NarrativeInvalidationPolicy;
  readonly autoApply: false;
  readonly autoDeleteEvent: false;
  readonly notes: string;
}

/** Chronicle: Evidence 再検証と Projection 更新。Event 本体は自動削除しない。 */
export function adviseChronicleInvalidation(
  signal: ChronicleChangeSignal,
): ChronicleInvalidationAdvice {
  switch (signal) {
    case "scene-content":
      return {
        signal,
        policy: "revalidate-exact",
        autoApply: false,
        autoDeleteEvent: false,
        notes: "重なった Event Evidence だけ Exact Quote 再検証する",
      };
    case "scene-title":
      return {
        signal,
        policy: "repreview-only",
        autoApply: false,
        autoDeleteEvent: false,
        notes: "タイトルを Context に含む表示名候補だけ再評価する",
      };
    case "event-title-human-edit":
      return {
        signal,
        policy: "manual",
        autoApply: false,
        autoDeleteEvent: false,
        notes: "Title Contribution を user-owned にし、Scene Link は維持する",
      };
    case "event-link":
      return {
        signal,
        policy: "revalidate-exact",
        autoApply: false,
        autoDeleteEvent: false,
        notes: "根拠 Scene が消えても Event は残し partially-supported にする",
      };
    case "calendar":
      return {
        signal,
        policy: "resolve-only",
        autoApply: false,
        autoDeleteEvent: false,
        notes: "Temporal Projection だけ solver-stale。Literal は維持する",
      };
  }
}
