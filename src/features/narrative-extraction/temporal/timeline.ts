import { hasLoneSurrogate } from "../source/digest";

export type TemporalTimelineRef =
  | { readonly kind: "primary" }
  | { readonly kind: "alternate"; readonly key: string }
  | { readonly kind: "embedded-fiction"; readonly key: string }
  | { readonly kind: "hypothetical"; readonly key: string };

export type TemporalTimelineKey = string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function isTimelineKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value)
  );
}

export function isTemporalTimelineRef(
  value: unknown,
): value is TemporalTimelineRef {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "primary") return hasExactKeys(value, ["kind"]);
  if (
    value.kind !== "alternate" &&
    value.kind !== "embedded-fiction" &&
    value.kind !== "hypothetical"
  ) {
    return false;
  }
  return hasExactKeys(value, ["kind", "key"]) && isTimelineKey(value.key);
}

export function temporalTimelineKey(
  timeline: TemporalTimelineRef,
): TemporalTimelineKey {
  if (!isTemporalTimelineRef(timeline)) {
    throw new TypeError("Invalid temporal timeline reference");
  }
  return timeline.kind === "primary"
    ? "primary"
    : `${timeline.kind}:${timeline.key}`;
}
