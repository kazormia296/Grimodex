#!/usr/bin/env node
/**
 * Freeze one production dense+FTS candidate pool per Gate 2 query.
 *
 * This intentionally calls the Electron N-API backend used by the product:
 * medium public sample workspace -> production chunker/int8 embedder -> dense
 * top-30 and FTS5 top-10 -> current RRF ordering. Rerankers never run retrieval.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  EN_EVAL_SET,
  JA_EVAL_SET,
} from "../../../src/features/semantic-search/searchEvalSets";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(EXPERIMENT_ROOT, "../..");
const RRF_K = 60;

interface Arguments {
  nativeModule: string;
  resources: string;
  jaWorkspace: string;
  enWorkspace: string;
  outputDir: string;
}

interface DenseHit {
  sceneId: string;
  sceneTitle: string;
  chunkText: string;
  charStart: number;
  charEnd: number;
  score: number;
}

interface SparseHit {
  sourceType: string;
  id: string;
  title: string;
}

interface QueryDefinition {
  queryId: string;
  language: "ja" | "en";
  query: string;
  slice: "semantic" | "lexical" | "morphology" | "no_match";
  expectedSceneTitles: string[];
}

interface EvalSetShape {
  relevant: { query: string; expect: string[] }[];
  junk: string[];
}

interface NativeBackend {
  openWorkspace(workspace: string): Promise<string>;
  dbExecute(
    sql: string,
    params: unknown[],
    method: "all",
  ): Promise<string>;
  semanticReindexAll(projectId: string, runId?: string): Promise<string>;
  semanticIndexStatus(projectId: string): Promise<string>;
  semanticSearch(
    projectId: string,
    query: string,
    limit: number,
    sceneScope?: string,
    descriptionMode?: boolean,
  ): Promise<string>;
  ftsSearch(
    projectId: string,
    query: string,
    scope: string,
    limit: number,
  ): Promise<string>;
}

interface BackendConstructor {
  new (appDataDir: string, semanticResourceRoot: string): NativeBackend;
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`invalid argument sequence near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const required = [
    "native-module",
    "resources",
    "ja-workspace",
    "en-workspace",
    "output-dir",
  ];
  for (const key of required) {
    if (!values.get(key)?.trim()) throw new Error(`--${key} is required`);
  }
  return {
    nativeModule: path.resolve(values.get("native-module")!),
    resources: path.resolve(values.get("resources")!),
    jaWorkspace: path.resolve(values.get("ja-workspace")!),
    enWorkspace: path.resolve(values.get("en-workspace")!),
    outputDir: path.resolve(values.get("output-dir")!),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

function stableSceneId(language: string, sceneTitle: string): string {
  return `${language}-scene-${sha256(`${language}\0${sceneTitle}`).slice(0, 16)}`;
}

function stableCandidateId(language: string, hit: DenseHit): string {
  return `${language}-chunk-${sha256(
    [
      language,
      hit.sceneTitle,
      String(hit.charStart),
      String(hit.charEnd),
      hit.chunkText,
    ].join("\0"),
  ).slice(0, 20)}`;
}

function definitions(
  evalSet: EvalSetShape,
  language: "ja" | "en",
): QueryDefinition[] {
  const relevant = evalSet.relevant.map((item, index) => {
    let slice: QueryDefinition["slice"] = "semantic";
    if (language === "en" && index >= 13 && index < 17) slice = "lexical";
    if (language === "en" && index >= 17) slice = "morphology";
    return {
      queryId: `${language}-r${String(index + 1).padStart(2, "0")}`,
      language,
      query: item.query,
      slice,
      expectedSceneTitles: [...item.expect],
    };
  });
  const noMatch = evalSet.junk.map((query, index) => ({
    queryId: `${language}-n${String(index + 1).padStart(2, "0")}`,
    language,
    query,
    slice: "no_match" as const,
    expectedSceneTitles: [],
  }));
  return [...relevant, ...noMatch];
}

function currentRrfRanks(
  denseHits: DenseHit[],
  sparseSceneIds: string[],
): Map<number, number> {
  const bestIndexByScene = new Map<string, number>();
  denseHits.forEach((hit, index) => {
    if (!bestIndexByScene.has(hit.sceneId)) {
      bestIndexByScene.set(hit.sceneId, index);
    }
  });
  const denseSceneRank = new Map<string, number>();
  [...bestIndexByScene.keys()].forEach((sceneId, rank) => {
    denseSceneRank.set(sceneId, rank);
  });
  const sparseRank = new Map<string, number>();
  for (const sceneId of sparseSceneIds) {
    if (!sparseRank.has(sceneId)) sparseRank.set(sceneId, sparseRank.size);
  }

  const distinct = [...bestIndexByScene.entries()]
    .map(([sceneId, candidateIndex]) => {
      const denseRank = denseSceneRank.get(sceneId)!;
      const lexicalRank = sparseRank.get(sceneId);
      return {
        candidateIndex,
        rrf:
          1 / (RRF_K + denseRank) +
          (lexicalRank === undefined ? 0 : 1 / (RRF_K + lexicalRank)),
      };
    })
    .sort(
      (left, right) =>
        right.rrf - left.rrf ||
        denseHits[right.candidateIndex].score -
          denseHits[left.candidateIndex].score ||
        denseHits[left.candidateIndex].sceneId.localeCompare(
          denseHits[right.candidateIndex].sceneId,
        ),
    );
  const bestIndexes = new Set(distinct.map((item) => item.candidateIndex));
  const leftovers = denseHits
    .map((_hit, index) => index)
    .filter((index) => !bestIndexes.has(index));
  return new Map(
    [...distinct.map((item) => item.candidateIndex), ...leftovers].map(
      (candidateIndex, rank) => [candidateIndex, rank + 1],
    ),
  );
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const staging = `${filePath}.tmp-${process.pid}`;
  await writeFile(staging, contents, "utf8");
  await rename(staging, filePath);
}

async function freezeLanguage(args: {
  Backend: BackendConstructor;
  appDataDir: string;
  resources: string;
  workspace: string;
  definitions: QueryDefinition[];
  outputPath: string;
}): Promise<Record<string, unknown>> {
  const backend = new args.Backend(args.appDataDir, args.resources);
  await backend.openWorkspace(args.workspace);
  const projectRows = JSON.parse(
    await backend.dbExecute(
      "SELECT id, language FROM projects ORDER BY created_at LIMIT 1",
      [],
      "all",
    ),
  ).rows as { id: string; language: string }[];
  if (projectRows.length !== 1) {
    throw new Error(`expected one sample project in ${args.workspace}`);
  }
  const project = projectRows[0];
  const language = args.definitions[0]?.language;
  if (!language || !project.language.startsWith(language)) {
    throw new Error(
      `workspace language ${project.language} does not match ${language}`,
    );
  }

  await backend.semanticReindexAll(project.id, `phase0b-gate2-${language}`);
  const indexStatus = JSON.parse(await backend.semanticIndexStatus(project.id));
  const lines: string[] = [];
  for (const definition of args.definitions) {
    const [densePayload, sparsePayload] = await Promise.all([
      backend.semanticSearch(project.id, definition.query, 30),
      backend.ftsSearch(project.id, definition.query, "scenes", 10),
    ]);
    const denseHits = JSON.parse(densePayload) as DenseHit[];
    const sparseHits = (JSON.parse(sparsePayload) as SparseHit[]).filter(
      (item) => item.sourceType === "scene",
    );
    if (denseHits.length !== 30) {
      throw new Error(
        `${definition.queryId} returned ${denseHits.length} dense candidates, expected 30`,
      );
    }
    const sparseIds = sparseHits.map((item) => item.id);
    const sparseRank = new Map<string, number>();
    for (const sceneId of sparseIds) {
      if (!sparseRank.has(sceneId)) sparseRank.set(sceneId, sparseRank.size + 1);
    }
    const rrfRanks = currentRrfRanks(denseHits, sparseIds);
    const expected = new Set(definition.expectedSceneTitles);
    const thresholds =
      language === "ja"
        ? { minScore: 0.8, gateScore: 0.85, rescueMargin: 0.05 }
        : { minScore: 0.51, gateScore: 0.51, rescueMargin: 0.05 };
    const record = {
      schemaVersion: 1,
      queryId: definition.queryId,
      language,
      query: definition.query,
      slice: definition.slice,
      expectedSceneTitles: definition.expectedSceneTitles,
      ...thresholds,
      candidates: denseHits.map((hit, index) => ({
        candidateId: stableCandidateId(language, hit),
        sceneId: stableSceneId(language, hit.sceneTitle),
        sceneTitle: hit.sceneTitle,
        chunkText: hit.chunkText,
        charStart: hit.charStart,
        charEnd: hit.charEnd,
        denseScore: hit.score,
        denseRank: index + 1,
        sparseRank: sparseRank.get(hit.sceneId) ?? null,
        rrfRank: rrfRanks.get(index),
        relevant: expected.has(hit.sceneTitle),
      })),
    };
    lines.push(JSON.stringify(record));
  }
  await atomicWrite(args.outputPath, `${lines.join("\n")}\n`);
  return {
    language,
    workspaceFixture:
      language === "ja"
        ? "python3 scripts/seed-sample-ja.py <tmp> --scale medium"
        : "python3 scripts/seed-sample-en.py <tmp> --scale medium",
    queryCount: args.definitions.length,
    indexStatus,
    candidateFile: path.relative(EXPERIMENT_ROOT, args.outputPath),
    candidateSha256: await sha256File(args.outputPath),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const require = createRequire(import.meta.url);
  const native = require(args.nativeModule) as { Backend?: BackendConstructor };
  if (!native.Backend) throw new Error("native module does not export Backend");
  await mkdir(args.outputDir, { recursive: true });
  const appDataRoot = await mkdtemp(path.join(tmpdir(), "grimodex-gate2-"));
  try {
    const jaOutput = path.join(args.outputDir, "candidates-ja.jsonl");
    const enOutput = path.join(args.outputDir, "candidates-en.jsonl");
    const [ja, en] = await Promise.all([
      freezeLanguage({
        Backend: native.Backend,
        appDataDir: path.join(appDataRoot, "ja"),
        resources: args.resources,
        workspace: args.jaWorkspace,
        definitions: definitions(JA_EVAL_SET, "ja"),
        outputPath: jaOutput,
      }),
      freezeLanguage({
        Backend: native.Backend,
        appDataDir: path.join(appDataRoot, "en"),
        resources: args.resources,
        workspace: args.enWorkspace,
        definitions: definitions(EN_EVAL_SET, "en"),
        outputPath: enOutput,
      }),
    ]);
    const sourceFiles = [
      "src/features/semantic-search/searchEvalSets.ts",
      "src/features/chat/semanticRecall.ts",
      "src-tauri/crates/grimodex-semantic/src/chunker.rs",
      "src-tauri/crates/grimodex-semantic/src/chunker_en.rs",
      "src-tauri/crates/grimodex-semantic/src/search.rs",
      "src-tauri/crates/grimodex-semantic/src/spec.rs",
      "scripts/seed-sample-ja.py",
      "scripts/seed-sample-en.py",
      "experiments/lfm25-encoder-phase0/tools/freeze_gate2_candidates.ts",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (relativePath) => [
          relativePath,
          await sha256File(path.join(REPO_ROOT, relativePath)),
        ]),
      ),
    );
    const provenance = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generator: path.relative(
        REPO_ROOT,
        path.join(SCRIPT_DIR, "freeze_gate2_candidates.ts"),
      ),
      contract:
        "one production dense top-30 + FTS5 top-10 pool per query; retrieval is never rerun per reranker",
      sources: { ja, en },
      sourceHashes,
    };
    await atomicWrite(
      path.join(args.outputDir, "provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
  } finally {
    await rm(appDataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
