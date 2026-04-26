import type { LayoutInput, LayoutOutput } from "./types";
import { clusterByCodexRef } from "./cluster";

export function layoutPlace(input: LayoutInput): LayoutOutput {
  const { scenes, codexEntries } = input;

  const locationIds = codexEntries
    .filter((e) => e.type === "location")
    .map((e) => e.id);

  const codexPositions: LayoutOutput = new Map();

  const sceneLayout = clusterByCodexRef(
    scenes,
    locationIds,
    (s) => s.locationId,
    codexPositions,
  );

  const result: LayoutOutput = new Map([...sceneLayout, ...codexPositions]);
  return result;
}
