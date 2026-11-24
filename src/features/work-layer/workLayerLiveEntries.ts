import type { WorkLayerLiveEntry, WorkLayerModel } from "./types";

export function isValidWorkLayerLiveEntry(entry: WorkLayerLiveEntry): boolean {
  switch (entry.status) {
    case "ready":
      return (
        typeof entry.count === "number" &&
        Number.isInteger(entry.count) &&
        entry.count >= 0
      );
    case "not-counted":
    case "unavailable":
      return entry.count === null;
    default:
      return false;
  }
}

export function selectAttentionCount(model: WorkLayerModel): {
  readonly total: number;
  readonly complete: boolean;
} {
  if (model.liveEntries == null) {
    return { total: model.attention.length, complete: true };
  }

  let total = 0;
  let complete = true;
  const seen = new Set<string>();

  for (const entry of model.liveEntries) {
    if (seen.has(entry.id)) {
      complete = false;
      continue;
    }
    seen.add(entry.id);

    if (!isValidWorkLayerLiveEntry(entry) || entry.status !== "ready") {
      complete = false;
      continue;
    }
    if (entry.count === null) {
      complete = false;
      continue;
    }
    total += entry.count;
  }

  return { total, complete };
}
