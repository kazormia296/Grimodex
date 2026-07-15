export const SCAN_LIMITS = {
  maxTitleLength: 200,
  maxFingerprintLength: 160,
  maxPipelineVersionLength: 80,
  maxPromptVersions: 64,
  maxSections: 2_000,
  maxParagraphs: 50_000,
  maxEntities: 5_000,
  maxRelations: 10_000,
  maxPhases: 2_000,
  maxEvents: 20_000,
  maxFindings: 10_000,
  maxAliasesPerEntity: 64,
  maxEvidencePerItem: 64,
  maxExcerptLength: 280,
  maxTextLength: 4_000,
  maxEntityNameLength: 240,
  maxRelationTypeLength: 80,
  maxIdLength: 96,
} as const;

export const ID_PATTERNS = {
  section: /^section:\d+:[a-z0-9]{8}$/,
  paragraph: /^paragraph:\d+:\d+:[a-z0-9]{8}$/,
  entity: /^entity:[0-9a-f-]{36}$/,
  relation: /^relation:[0-9a-f-]{36}$/,
  phase: /^phase:[0-9a-f-]{36}$/,
  event: /^event:[0-9a-f-]{36}$/,
  finding: /^finding:[0-9a-f-]{36}$/,
} as const;

export type ScanIdKind = keyof typeof ID_PATTERNS;
