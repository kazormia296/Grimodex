import type { LayoutInput, LayoutOutput } from "./types";
import { clusterByCodexRef } from "./cluster";

export function layoutPOV(input: LayoutInput): LayoutOutput {
  const { scenes, codexEntries } = input;

  const characterIds = codexEntries
    .filter((e) => e.type === "character")
    .map((e) => e.id);

  const codexPositions: LayoutOutput = new Map();

  const sceneLayout = clusterByCodexRef(
    scenes,
    characterIds,
    (s) => s.povCharacterId,
    codexPositions,
  );

  // Merge codex positions into result
  const result: LayoutOutput = new Map([...sceneLayout, ...codexPositions]);
  return result;
}
