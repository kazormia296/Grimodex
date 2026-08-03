export type BeatType =
  | "free"
  | "summary"
  | "guided"
  | "dialogue"
  | "setting"
  | "micro";

export const BEAT_TYPES: readonly BeatType[] = [
  "free",
  "summary",
  "guided",
  "dialogue",
  "setting",
  "micro",
] as const;

export function isBeatType(value: unknown): value is BeatType {
  return (
    typeof value === "string" &&
    (BEAT_TYPES as readonly string[]).includes(value)
  );
}
