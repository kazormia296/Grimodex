#!/usr/bin/env node
/**
 * Freeze Gate 3.1's production-shaped, full-scene Impact workload.
 *
 * The exporter runs the product semantic index and FTS backend, reuses the
 * product's pure scene-level RRF fusion, then reads complete ProseMirror scene
 * documents and converts them through the product plain-text extractor.
 */

import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  denseSceneRanking,
  fuseSceneCandidates,
} from "../../../src/features/impact-review/narrowingCore";
import { prosemirrorToText } from "../../../src/lib/prosemirror";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(EXPERIMENT_ROOT, "../..");

const QUERY_TEXT = "記憶。失われた。取り戻した";
const MENTION_TERMS = ["記憶"];
const DENSE_FETCH = 60;
const INFERRED_LIMIT = 30;

interface Arguments {
  nativeModule: string;
  resources: string;
  workspace: string;
  output: string;
}

interface DenseHit {
  sceneId: string;
  score: number;
}

interface SparseHit {
  sourceType: string;
  id: string;
}

interface SceneRow {
  id: string;
  title: string;
  content: string;
}

interface NativeBackend {
  openWorkspace(workspace: string): Promise<string>;
  dbExecute(sql: string, params: unknown[], method: "all"): Promise<string>;
  semanticReindexAll(projectId: string, runId?: string): Promise<string>;
  semanticIndexStatus(projectId: string): Promise<string>;
  semanticSearch(
    projectId: string,
    query: string,
    limit: number,
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
  for (const key of ["native-module", "resources", "workspace", "output"]) {
    if (!values.get(key)?.trim()) throw new Error(`--${key} is required`);
  }
  return {
    nativeModule: path.resolve(values.get("native-module")!),
    resources: path.resolve(values.get("resources")!),
    workspace: path.resolve(values.get("workspace")!),
    output: path.resolve(values.get("output")!),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

function stableSceneId(title: string): string {
  return `ja-scene-${sha256(`ja\0${title}`).slice(0, 16)}`;
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const staging = `${filePath}.tmp-${process.pid}`;
  await writeFile(staging, contents, "utf8");
  await rename(staging, filePath);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const require = createRequire(import.meta.url);
  const native = require(args.nativeModule) as { Backend?: BackendConstructor };
  if (!native.Backend) throw new Error("native module does not export Backend");

  const appDataRoot = await mkdtemp(path.join(tmpdir(), "grimodex-gate31-"));
  try {
    const backend = new native.Backend(appDataRoot, args.resources);
    await backend.openWorkspace(args.workspace);
    const projectRows = JSON.parse(
      await backend.dbExecute(
        "SELECT id, title, language FROM projects ORDER BY created_at LIMIT 1",
        [],
        "all",
      ),
    ).rows as Array<{ id: string; title: string; language: string }>;
    const project = projectRows[0];
    if (!project || !project.language.startsWith("ja")) {
      throw new Error("Gate 3.1 requires one Japanese sample project");
    }

    await backend.semanticReindexAll(project.id, "phase0b-impact-gate31");
    const [densePayload, sparsePayload, scenePayload, indexPayload] =
      await Promise.all([
        backend.semanticSearch(project.id, QUERY_TEXT, DENSE_FETCH),
        backend.ftsSearch(
          project.id,
          MENTION_TERMS.join(" "),
          "scenes",
          DENSE_FETCH,
        ),
        backend.dbExecute(
          "SELECT id, title, content FROM tree_nodes WHERE project_id = ? AND node_type = 'scene' ORDER BY sort_order, id",
          [project.id],
          "all",
        ),
        backend.semanticIndexStatus(project.id),
      ]);
    const denseHits = JSON.parse(densePayload) as DenseHit[];
    const sparseIds = (JSON.parse(sparsePayload) as SparseHit[])
      .filter((hit) => hit.sourceType === "scene")
      .map((hit) => hit.id);
    const sceneRows = (JSON.parse(scenePayload).rows as SceneRow[]).filter(
      (scene) => typeof scene.content === "string",
    );
    const denseRanked = denseSceneRanking(denseHits);
    const denseScoreById = new Map(
      denseRanked.map((scene) => [scene.sceneId, scene.bestScore]),
    );
    const selected = fuseSceneCandidates(
      denseRanked.map((scene) => scene.sceneId),
      sparseIds,
      {
        limit: INFERRED_LIMIT,
        denseScoreById,
        semanticSceneIds: [],
      },
    );
    if (selected.length !== INFERRED_LIMIT) {
      throw new Error(
        `product fusion returned ${selected.length} inferred scenes, expected 30`,
      );
    }

    const rowsById = new Map(sceneRows.map((scene) => [scene.id, scene]));
    const denseRankById = new Map(
      denseRanked.map((scene, index) => [scene.sceneId, index + 1]),
    );
    const sparseRankById = new Map<string, number>();
    for (const sceneId of sparseIds) {
      if (!sparseRankById.has(sceneId)) {
        sparseRankById.set(sceneId, sparseRankById.size + 1);
      }
    }
    const scenes = selected.map((candidate, index) => {
      const row = rowsById.get(candidate.sceneId);
      if (!row)
        throw new Error(`selected scene is missing: ${candidate.sceneId}`);
      const plainText = prosemirrorToText(row.content);
      if (!plainText.trim()) {
        throw new Error(`selected scene has empty plain text: ${row.title}`);
      }
      return {
        sceneId: stableSceneId(row.title),
        sceneTitle: row.title,
        inferredRank: index + 1,
        denseRank: denseRankById.get(candidate.sceneId) ?? null,
        sparseRank: sparseRankById.get(candidate.sceneId) ?? null,
        rrfScore: Number(candidate.score.toFixed(12)),
        matchedBy: candidate.matchedBy,
        sourceContentSha256: sha256(row.content),
        plainTextSha256: sha256(plainText),
        plainText,
      };
    });
    if (new Set(scenes.map((scene) => scene.sceneId)).size !== 30) {
      throw new Error("Gate 3.1 selected scene IDs must be distinct");
    }

    const sourceFiles = [
      "scripts/seed-sample-ja.py",
      "src/features/impact-review/narrowingCore.ts",
      "src/lib/prosemirror.ts",
      "experiments/lfm25-encoder-phase0/tools/freeze_impact_gate31_scenes.ts",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (relativePath) => [
          relativePath,
          await sha256File(path.join(REPO_ROOT, relativePath)),
        ]),
      ),
    );
    const record = {
      schemaVersion: 1,
      language: "ja",
      projectTitle: project.title,
      diffPayload: {
        change_id: "gate31-impact-full-scenes-ja-001",
        entry_id: "gate31-memory-state",
        entry_name: "記憶",
        entry_type: "lore",
        change_summary: "記憶の状態を失われたから取り戻したへ変更",
        changes: [
          {
            field: "detail",
            name: "状態",
            old: "失われた",
            new: "取り戻した",
          },
        ],
      },
      selection: {
        queryText: QUERY_TEXT,
        mentionTerms: MENTION_TERMS,
        denseFetch: DENSE_FETCH,
        inferredLimit: INFERRED_LIMIT,
        explicitLinkPolicy: "retain-and-bypass-classifier",
        explicitSceneCount: 0,
        denseChunkCount: denseHits.length,
        denseSceneCount: denseRanked.length,
        sparseSceneCount: new Set(sparseIds).size,
        unionSceneCount: new Set([
          ...denseRanked.map((scene) => scene.sceneId),
          ...sparseIds,
        ]).size,
        selectedInferredSceneCount: selected.length,
      },
      provenance: {
        workspaceFixture:
          "python3 scripts/seed-sample-ja.py <workspace> --scale medium",
        candidateFusion:
          "src/features/impact-review/narrowingCore.ts#fuseSceneCandidates",
        plainTextExtractor: "src/lib/prosemirror.ts#prosemirrorToText",
        nativeIndexStatus: JSON.parse(indexPayload),
        sourceWorkspaceSceneCount: sceneRows.length,
        sourceHashes,
      },
      scenes,
    };
    await atomicWrite(args.output, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          output: path.relative(EXPERIMENT_ROOT, args.output),
          sha256: await sha256File(args.output),
          selection: record.selection,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(appDataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
