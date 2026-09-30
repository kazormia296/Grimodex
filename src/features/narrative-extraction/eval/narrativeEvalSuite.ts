import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";
import { sha256Digest } from "../source/digest";
import { validateNarrativeEvalCase } from "./caseSchema";
import type { NarrativeEvalCaseV1 } from "./types";

export const DEFAULT_NARRATIVE_EVAL_SUITE_ID = "chronicle-micro-v1";

const NARRATIVE_MANIFEST_RELATIVE = "evals/narrative/manifest.yaml";
const NARRATIVE_ROOT_RELATIVE = "evals/narrative";
const NARRATIVE_CASES_RELATIVE = "evals/narrative/cases";
const NARRATIVE_SCHEMAS_RELATIVE = "evals/narrative/schemas";

interface NarrativeEvalSuiteManifestEntry {
  readonly id: string;
  readonly version: number;
  readonly slice: string;
  readonly tier: string;
  readonly caseSchema: string;
  readonly caseFile: string;
  readonly caseCount: number;
  readonly requirementIds?: readonly string[];
  readonly certification?: {
    readonly diagnosticOnly?: boolean;
    readonly requiresProductionPrompt?: boolean;
    readonly requiresProductionParser?: boolean;
    readonly legacyBaselineIsCertification?: boolean;
  };
}

interface NarrativeEvalManifest {
  readonly schemaVersion: number;
  readonly id: string;
  readonly suites: readonly NarrativeEvalSuiteManifestEntry[];
}

export interface LoadedNarrativeEvalSuite {
  readonly suiteId: string;
  readonly version: number;
  /** Path relative to evals/narrative, as declared in the manifest. */
  readonly caseFile: string;
  /** Path relative to evals/narrative, as declared in the manifest. */
  readonly caseSchema: string;
  readonly caseCount: number;
  readonly diagnosticOnly: boolean;
  readonly manifestDigest: string;
  readonly caseFileDigest: string;
  readonly caseSchemaDigest: string;
  readonly cases: readonly NarrativeEvalCaseV1[];
}

export interface LoadNarrativeEvalSuiteOptions {
  readonly repoRoot?: string;
  readonly suiteId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid narrative evaluation manifest: ${field} is required`,
    );
  }
  return value;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(
      `Invalid narrative evaluation manifest: ${field} must be a non-negative safe integer`,
    );
  }
  return Number(value);
}

function parseManifest(raw: unknown): NarrativeEvalManifest {
  if (!isRecord(raw)) {
    throw new Error(
      "Invalid narrative evaluation manifest: expected an object",
    );
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(
      "Invalid narrative evaluation manifest: schemaVersion must be 1",
    );
  }
  if (raw.id !== "narrative-extraction-eval") {
    throw new Error(
      "Invalid narrative evaluation manifest: id must be narrative-extraction-eval",
    );
  }
  if (!Array.isArray(raw.suites) || raw.suites.length === 0) {
    throw new Error(
      "Invalid narrative evaluation manifest: suites must be a non-empty array",
    );
  }
  const suites = raw.suites.map((rawSuite, index) => {
    if (!isRecord(rawSuite)) {
      throw new Error(
        `Invalid narrative evaluation manifest: suites[${index}] must be an object`,
      );
    }
    const id = requiredString(rawSuite.id, `suites[${index}].id`);
    const version = requiredSafeInteger(
      rawSuite.version,
      `suites[${index}].version`,
    );
    const slice = requiredString(rawSuite.slice, `suites[${index}].slice`);
    const tier = requiredString(rawSuite.tier, `suites[${index}].tier`);
    const caseSchema = requiredString(
      rawSuite.caseSchema,
      `suites[${index}].caseSchema`,
    );
    const caseFile = requiredString(
      rawSuite.caseFile,
      `suites[${index}].caseFile`,
    );
    const caseCount = requiredSafeInteger(
      rawSuite.caseCount,
      `suites[${index}].caseCount`,
    );
    const certification = rawSuite.certification;
    if (certification !== undefined && !isRecord(certification)) {
      throw new Error(
        `Invalid narrative evaluation manifest: suites[${index}].certification must be an object`,
      );
    }
    if (
      certification !== undefined &&
      certification.diagnosticOnly !== undefined &&
      typeof certification.diagnosticOnly !== "boolean"
    ) {
      throw new Error(
        `Invalid narrative evaluation manifest: suites[${index}].certification.diagnosticOnly must be boolean`,
      );
    }
    return {
      id,
      version,
      slice,
      tier,
      caseSchema,
      caseFile,
      caseCount,
      ...(certification
        ? {
            certification: {
              ...(typeof certification.diagnosticOnly === "boolean"
                ? { diagnosticOnly: certification.diagnosticOnly }
                : {}),
            },
          }
        : {}),
    } satisfies NarrativeEvalSuiteManifestEntry;
  });
  const suiteIds = new Set<string>();
  for (const suite of suites) {
    if (suiteIds.has(suite.id)) {
      throw new Error(
        `Invalid narrative evaluation manifest: duplicate suite id ${suite.id}`,
      );
    }
    suiteIds.add(suite.id);
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    suites,
  };
}

function assertContainedPath(
  baseDirectory: string,
  candidate: string,
  label: string,
): string {
  if (path.isAbsolute(candidate)) {
    throw new Error(`${label} must be relative to the narrative eval root`);
  }
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside ${base}`);
  }
  return resolved;
}

async function assertExistingContainedPath(
  baseDirectory: string,
  candidate: string,
  label: string,
): Promise<string> {
  const resolvedBase = await realpath(baseDirectory);
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside ${resolvedBase}`);
  }
  return resolvedCandidate;
}

function validateCorpusCase(
  candidate: unknown,
  suiteId: string,
  index: number,
): NarrativeEvalCaseV1 {
  const result = validateNarrativeEvalCase(candidate);
  if (!result.ok) {
    throw new Error(
      `Invalid narrative evaluation case for ${suiteId} at index ${index}: ${result.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }
  return result.value;
}

function validateCorpusCaseWithSchema(
  candidate: unknown,
  suiteId: string,
  index: number,
  validateSchema: (candidate: unknown) => boolean,
): NarrativeEvalCaseV1 {
  if (!validateSchema(candidate)) {
    throw new Error(
      `Invalid narrative evaluation case for ${suiteId} at index ${index}: JSON schema validation failed`,
    );
  }
  return validateCorpusCase(candidate, suiteId, index);
}

export function narrativeEvalSuiteIdFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const requested = env.NARRATIVE_EVAL_SUITE_ID?.trim();
  return requested || DEFAULT_NARRATIVE_EVAL_SUITE_ID;
}

/**
 * Resolve one versioned Narrative evaluation suite through its manifest.
 *
 * The manifest is the only authority for suite-to-corpus mapping. Corpus
 * files and schema paths are constrained to their respective directories,
 * including symlink targets, before any case is parsed or dispatched.
 */
export async function loadNarrativeEvalSuite({
  repoRoot = path.resolve(import.meta.dirname, "../../../.."),
  suiteId = DEFAULT_NARRATIVE_EVAL_SUITE_ID,
}: LoadNarrativeEvalSuiteOptions = {}): Promise<LoadedNarrativeEvalSuite> {
  const manifestPath = path.join(repoRoot, NARRATIVE_MANIFEST_RELATIVE);
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(yaml.load(manifestSource));
  const suite = manifest.suites.find((candidate) => candidate.id === suiteId);
  if (!suite) {
    throw new Error(`Unknown narrative evaluation suite: ${suiteId}`);
  }

  const narrativeRoot = path.join(repoRoot, NARRATIVE_ROOT_RELATIVE);
  const casesDirectory = path.join(repoRoot, NARRATIVE_CASES_RELATIVE);
  const schemasDirectory = path.join(repoRoot, NARRATIVE_SCHEMAS_RELATIVE);
  const casePath = assertContainedPath(
    narrativeRoot,
    suite.caseFile,
    "Narrative evaluation case file",
  );
  const schemaPath = assertContainedPath(
    narrativeRoot,
    suite.caseSchema,
    "Narrative evaluation case schema",
  );
  const expectedCasePath = assertContainedPath(
    casesDirectory,
    path.relative(casesDirectory, casePath),
    "Narrative evaluation case file",
  );
  assertContainedPath(
    schemasDirectory,
    path.relative(schemasDirectory, schemaPath),
    "Narrative evaluation case schema",
  );
  const resolvedCasePath = await assertExistingContainedPath(
    casesDirectory,
    expectedCasePath,
    "Narrative evaluation case file",
  );
  const caseSource = await readFile(resolvedCasePath, "utf8");
  const rawCorpus = yaml.load(caseSource);
  if (!isRecord(rawCorpus)) {
    throw new Error(
      `Invalid narrative evaluation corpus for ${suite.id}: expected an object`,
    );
  }
  if (rawCorpus.schemaVersion !== 1) {
    throw new Error(
      `Invalid narrative evaluation corpus for ${suite.id}: schemaVersion must be 1`,
    );
  }
  if (rawCorpus.suiteId !== suite.id) {
    throw new Error(
      `Narrative evaluation corpus suiteId mismatch: manifest=${suite.id}, corpus=${String(
        rawCorpus.suiteId,
      )}`,
    );
  }
  if (!Array.isArray(rawCorpus.cases)) {
    throw new Error(
      `Invalid narrative evaluation corpus for ${suite.id}: cases must be an array`,
    );
  }
  if (suite.caseCount === 0 || rawCorpus.cases.length !== suite.caseCount) {
    throw new Error(
      `Narrative evaluation corpus caseCount mismatch for ${suite.id}: manifest=${suite.caseCount}, corpus=${rawCorpus.cases.length}`,
    );
  }
  const resolvedSchemaPath = await assertExistingContainedPath(
    schemasDirectory,
    schemaPath,
    "Narrative evaluation case schema",
  );
  const schemaSource = await readFile(resolvedSchemaPath, "utf8");
  let validateSchema: (candidate: unknown) => boolean;
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    validateSchema = ajv.compile(JSON.parse(schemaSource));
  } catch (error) {
    throw new Error(
      `Invalid narrative evaluation case schema for ${suite.id}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const cases = rawCorpus.cases.map((candidate, index) =>
    validateCorpusCaseWithSchema(candidate, suite.id, index, validateSchema),
  );
  const caseIds = new Set<string>();
  for (const evalCase of cases) {
    if (caseIds.has(evalCase.id)) {
      throw new Error(
        `Narrative evaluation corpus contains duplicate case id: ${evalCase.id}`,
      );
    }
    caseIds.add(evalCase.id);
  }
  return {
    suiteId: suite.id,
    version: suite.version,
    caseFile: suite.caseFile,
    caseSchema: suite.caseSchema,
    caseCount: suite.caseCount,
    diagnosticOnly: suite.certification?.diagnosticOnly === true,
    manifestDigest: await sha256Digest(manifestSource),
    caseFileDigest: await sha256Digest(caseSource),
    caseSchemaDigest: await sha256Digest(schemaSource),
    cases,
  };
}
