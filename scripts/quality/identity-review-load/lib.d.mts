export const WORKS: Readonly<Record<string, number>>;
export const FOLDER_PERCENTS: readonly number[];
export const HONORIFIC_SUFFIXES: readonly string[];

export interface NestedFolderPlan {
  percent: number;
  cumulativeSceneCount: number;
  childFolderPercent: number | null;
  addedSceneIndexes: number[];
  parentPercent: number | null;
}
export function nestedFolderSceneCounts(sceneCount: number): number[];
export function planNestedFolders(sceneCount: number): {
  counts: number[];
  folders: NestedFolderPlan[];
};
export function expectedSceneText(paragraphs: readonly string[]): string;
export function scenesFromWork(work: {
  scenes: { index: number; paragraphs: string[] }[];
}): { index: number; paragraphs: string[] }[];
export function countTextMismatches(
  expectedTexts: readonly string[],
  actualTexts: readonly string[],
): { expected: number; actual: number; mismatched: number };
export function hashSurface(surface: string): Promise<string>;
export function candidateKey(surface: string): string;
export function stripHonorific(surface: string): string;

export interface Distribution {
  n: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}
export function surfaceOverlapCounts(surfaces: readonly string[]): {
  distinct: number;
  honorificStrippable: number;
  honorificOverlap: number;
  substringOfOther: number;
};
export function summarizeSeedInventory(
  seeds: readonly {
    surface: string;
    occurrenceCount: number;
    sceneIds: readonly string[];
    appearsAsProperName: boolean;
  }[],
): Record<string, number | Distribution>;
export function summarizeCandidateInventory(
  candidates: readonly { surface: string; count: number }[],
): Record<string, number | Distribution>;
export function crossSetCounts(
  seedSurfaces: readonly string[],
  candidateSurfaces: readonly string[],
): { seedOnly: number; candidateOnly: number; both: number };

export function findUnsafeStrings(value: unknown, trail?: string): string[];
export function buildShingleSet(
  texts: readonly string[],
  size?: number,
): Set<string>;
export function countShingleHits(
  output: string,
  shingles: ReadonlySet<string>,
  size?: number,
): number;
export function assertOutputClean(
  output: unknown,
  scenesTexts: readonly string[],
): void;
