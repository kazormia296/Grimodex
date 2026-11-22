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
export function reconcileSeedsWithProposals(input: {
  seedHashes: Iterable<string>;
  proposalHashes: Iterable<string>;
  droppedRelationalHashes?: Iterable<string>;
  droppedDismissedHashes?: Iterable<string>;
}): {
  seed: number;
  proposal: number;
  droppedRelational: number;
  droppedFoldedDismissed: number;
  droppedNotInSeed: number;
  droppedAndProposed: number;
  relationalAndDismissed: number;
  seedOnlyUnexplained: number;
  proposalOnlyUnexplained: number;
  ok: boolean;
};

export const STORED_PROPOSAL_KIND_FIELDS: Readonly<Record<string, string>>;
export const STORED_PROPOSAL_KINDS: readonly string[];
export const STORED_PROPOSAL_STATUSES: readonly string[];
export const STORED_RUN_STATUSES: readonly string[];
export const STORED_SET_STATUSES: readonly string[];
export const STORED_RUN_LIST_LIMIT: number;
export const STORED_RESTORE_LIST_LIMIT: number;
export const STORED_RESUMABLE_RUN_STATUSES: readonly string[];
export const STORED_RUN_ROLES: readonly string[];
export const STORED_DEFINITION: string;
export const STORED_NOT_MEASURED_REASONS: readonly string[];
export interface StoredProposalRun {
  role: "current" | "prior";
  listedByProduct: boolean;
  tracked?: boolean;
  /** その段が失敗して採用されなかった run（前の回に数えない）。 */
  failedStage?: boolean;
  /** 製品の restore が作者に出す run（planProductVisibleRuns）。無ければ見えるとは数えない。 */
  visibleToAuthor?: boolean;
  /** scope の folder の識別子が読めた run（読めない run は「作者に見える run」の判定が当てにならない）。 */
  folderKnown?: boolean;
  runStatus: string;
  setStatus: string | null;
  proposals: readonly { kind: string; status: string; applied: boolean }[];
}
export interface StoredUnreviewedMeasured {
  status: "measured";
  definition: string;
  listLimit: number;
  restoreListLimit: number;
  listedByProductCount: number;
  listTruncated: boolean;
  runCount: number;
  currentRunCount: number;
  priorRunCount: number;
  notAdoptedRunCount: number;
  failedStageRunCount: number;
  untrackedRunCount: number;
  visibleToAuthorRunCount: number;
  folderUnknownRunCount: number;
  trackedNotListedByProductCount: number;
  unreviewed: {
    total: number;
    currentRun: number;
    priorRuns: number;
    notAdoptedRuns: number;
    visibleToAuthor: number;
    notVisibleToAuthor: number;
    byKind: Record<string, number>;
    currentRunByKind: Record<string, number>;
    priorRunsByKind: Record<string, number>;
    visibleToAuthorByKind: Record<string, number>;
  };
  stored: {
    total: number;
    currentRun: number;
    priorRuns: number;
    notAdoptedRuns: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    currentRunByKind: Record<string, number>;
    applied: number;
  };
  perRun: {
    role: "current" | "prior" | "failed-stage" | "untracked";
    listedByProduct: boolean;
    tracked: boolean;
    visibleToAuthor: boolean;
    folderKnown: boolean;
    runStatus: string;
    setStatus: string;
    total: number;
    unreviewed: number;
    unreviewedByKind: Record<string, number>;
  }[];
}
export interface StoredUnreviewedNotMeasured {
  status: "not-measured";
  reason: "persist-skipped" | "persist-failed" | "read-failed";
  error?: unknown;
}
export function summarizeStoredProposals(input: {
  runs: readonly StoredProposalRun[];
  listedCount: number;
}): StoredUnreviewedMeasured;
export function planStoredRuns(input: {
  listedIds: readonly string[];
  trackedIds: readonly string[];
  failedIds?: readonly string[];
}): {
  runId: string;
  role: "current" | "prior";
  listedByProduct: boolean;
  tracked: boolean;
  failedStage: boolean;
}[];
export function planProductVisibleRuns(input: {
  listed: readonly {
    runId: string;
    runStatus: string;
    folderKey?: string | null;
  }[];
}): Set<string>;
export function storedNotMeasured(
  reason: string,
  error?: unknown,
): StoredUnreviewedNotMeasured;
export function planStoredRead(
  persistAttempt: { status?: string } | null | undefined,
): { read: true } | { read: false; result: StoredUnreviewedNotMeasured };
export function compareStoredWithProjection(
  stored:
    | StoredUnreviewedMeasured
    | StoredUnreviewedNotMeasured
    | null
    | undefined,
  extract: Record<string, number | undefined> | null | undefined,
): { compared: boolean; ok: boolean | null; differingKinds: string[] };

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
  relationalSurfaces?: string[];
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
  narrator?: string | null;
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
): { code: string; entityId: string; count: number; field?: string }[];
export function checkSurfacesAgainstScenes(
  roster: unknown,
  scenes: readonly { paragraphs: readonly string[] }[],
): { code: string; entityId: string; count: number; field?: string }[];

export function scenesTextsForScan(
  scenes: readonly { paragraphs: readonly string[] }[],
): string[];

export function runGuardedJudge<T>(deps: {
  sendArmed: boolean;
  blockedByPolicyOrLicense: () => boolean;
  visibleCount: number;
  assertRoleDefaults: () => Promise<{
    nonDefaultRoleKeys: number;
    roleProvidersNonDefault: boolean;
    sendOverrideClear: boolean;
  }>;
  countHiddenInSentWindow: () => Promise<number>;
  judge: () => Promise<T>;
}): Promise<{ ok: false; kind: string; durationMs: number } | T>;

export const RETRYABLE_FAILURE_KINDS: readonly string[];
export function classifyJudgmentFailure(error: unknown): {
  kind: string;
  httpStatus: number | null;
};

export function checkEntryTypesInCatalog(input: {
  entries: readonly { id: string; type: string }[];
  existingCatalog: readonly { sourceKey: string; typeRef: string }[];
  typeCatalog: readonly { ref: string; slug: string }[];
}): {
  determinable: boolean;
  checked: number;
  missingFromCatalog: number;
  typeMismatch: number;
};
export function assertEntryTypesInCatalog(input: {
  entries: readonly { id: string; type: string }[];
  existingCatalog: readonly { sourceKey: string; typeRef: string }[];
  typeCatalog: readonly { ref: string; slug: string }[];
}): {
  determinable: boolean;
  checked: number;
  missingFromCatalog: number;
  typeMismatch: number;
};
