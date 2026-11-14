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
export function expectedCanonicalText(paragraphs: readonly string[]): string;
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
  substringWithinSet: number;
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

export function buildAsciiTokenSet(
  texts: readonly string[],
  minLength?: number,
): Set<string>;
export function countAsciiTokenHits(
  output: unknown,
  tokens: ReadonlySet<string>,
  minLength?: number,
): number;
export const EXTERNAL_COMMANDS: readonly string[];
export function findAiCommands(commandNames: readonly string[]): string[];
export function sanitizeError(text: string): string;
export function safeErrorSummary(error: unknown): {
  name: string;
  tag: string;
  codes: string[];
  pairs: string[];
};
export function isBulkApprovableRow(row: {
  applicability: string;
  status: string;
  safe: boolean;
}): boolean;
export function countBulkApprovable(
  rows: readonly { applicability: string; status: string; safe: boolean }[],
): number;
export function compareHashSets(
  left: Iterable<string>,
  right: Iterable<string>,
): {
  left: number;
  right: number;
  both: number;
  leftOnly: number;
  rightOnly: number;
};

export const REVIEWED_WORKS: readonly string[];
export function rubyBaseText(paragraph: string): string;
export function countRubyNotations(paragraphs: readonly string[]): number;
export function paragraphSegments(
  paragraph: string,
): { base: string; reading: string | null }[];
export function proseMirrorParagraphTexts(content: string | object): {
  paragraphs: string[];
  rubyCount: number;
  rubyBases: string[];
  rubyPairs: { base: string; annotation: string }[];
  nonParagraphBlocks: number;
};
export function comparePersistedScene(
  expectedParagraphs: readonly string[],
  content: string | object,
): {
  paragraphCountOk: boolean;
  textOk: boolean;
  rubyOk: boolean;
  rubyPairMismatchCount: number;
  rubyCount: number;
  rubyBases: string[];
};
export function rubySurfaceRelation(
  rubyBaseKeys: readonly string[],
  surfaces: readonly string[],
): { exact: number; containing: number; exactSurfaces: string[] };
export function seedMissingFromCandidates(
  rubyBaseKeys: readonly string[],
  seedOccurrence: readonly (readonly [string, number])[],
  candidateOccurrence: readonly (readonly [string, number])[],
): {
  seedDistinct: number;
  candidateDistinct: number;
  missing: number;
  presentOccurrenceDiff: number;
  classes: {
    exact: { surfaces: number; occurrences: number; keys: string[] };
    containing: {
      surfaces: number;
      occurrences: number;
      keys: string[];
      shortOnly: number;
    };
    other: { surfaces: number; occurrences: number; keys: string[] };
  };
};

export const ROSTER_SCHEMA: string;
export const ENTITY_TYPES: readonly string[];
export const ALIAS_LEVELS: readonly string[];
export const LINEAGES: readonly string[];
export const REVIEW_STATUSES: readonly string[];
export const REVIEW_VERDICTS: readonly string[];
export const REVIEW_VERDICT_CODES: Readonly<Record<string, string>>;
export const ROSTER_LEVELS: readonly string[];

export interface RosterAlias {
  surface: string;
  level: "L1" | "L2" | "L3";
}
export interface RosterEntity {
  id: string;
  type: "character" | "location" | "other";
  name: string;
  nameIsRole?: boolean;
  frequentSurface?: string;
  aliases: RosterAlias[];
  honorificSurfaces?: string[];
  ambiguousSurfaces?: { surface: string; sceneRanges: [number, number][] }[];
  evidence: { scene: number; paragraph: number }[];
  lineage: "A" | "B" | "adjudicated";
  origin?: { A?: string[]; B?: string[] };
  packets?: string[];
  review?: { status: string; verdict?: string; note?: string };
}
export interface Roster {
  schemaVersion: string;
  work: string;
  lineage: "A" | "B" | "adjudicated";
  entities: RosterEntity[];
  reviewSummary?: unknown;
}
export interface RosterViolation {
  code: string;
  entityId: string | null;
  path: string;
}
export function isHonorificForm(surface: string): boolean;
export function entityKeys(entity: RosterEntity): string[];
export function validateRoster(
  roster: unknown,
  options?: { sceneCount?: number; paragraphCounts?: readonly number[] },
): { ok: boolean; errors: RosterViolation[] };
export function findCollisions(roster: Roster): {
  kind: "ambiguous" | "name-over-alias";
  key: string;
  entityIds: string[];
  resolvesTo?: string;
  declared: boolean;
}[];
export function rosterAtLevel(
  roster: Roster,
  level: string,
): { id: string; type: string; name: string; aliases: string[] }[];
export function firstSceneOf(entity: RosterEntity): number | null;
export function wilsonUpper(k: number, n: number, z?: number): number;

export function checkRosterAgainstScenes(
  roster: unknown,
  scenes: readonly { paragraphs: readonly string[] }[],
): { code: string; entityId: string; count: number }[];

export function scenesTextsForScan(
  scenes: readonly { paragraphs: readonly string[] }[],
): string[];
