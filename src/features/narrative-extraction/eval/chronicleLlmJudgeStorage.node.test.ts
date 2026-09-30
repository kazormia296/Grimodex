import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import calibrationFixtureJson from "../../../../evals/narrative/calibration/chronicle-llm-judge-v1.json";
import { loadNarrativeEvalSuite } from "./narrativeEvalSuite";
import {
  buildChronicleLlmJudgeResponse,
  prepareChronicleLlmJudgeOfflineRun,
  type ChronicleLlmJudgeOfflineResult,
  type ChronicleLlmJudgePreparedRun,
  type ChronicleLlmJudgeInput,
} from "./chronicleLlmJudgeOffline";
import {
  saveChronicleLlmJudgeOfflineDiagnostic,
  type SavedChronicleLlmJudgeOfflineDiagnostic,
} from "./chronicleLlmJudgeStorage.node";
import { prepareProductionChronicleEvalCase } from "./productionChronicleAdapter";
import { sha256Digest } from "../source/digest";
import type { NarrativeEvalCaseV1 } from "./types";

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: "chronicle-llm-judge-storage-fixture-model",
    provider: "chronicle-llm-judge-storage-fixture",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "chronicle-llm-judge-storage-test" }),
  },
}));

const CASE_ID = "chronicle.micro.actual-gate-collapse-001";
const ROOT = path.resolve(import.meta.dirname, "../../../..");

interface FixtureEvidence {
  readonly quote: string;
}

interface FixtureObservation {
  readonly localId: string;
  readonly evidence: readonly FixtureEvidence[];
  readonly assertion: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

interface CalibrationFixture {
  readonly baseResponse: {
    readonly observations: readonly FixtureObservation[];
  };
}

const CALIBRATION_FIXTURE =
  calibrationFixtureJson as unknown as CalibrationFixture;

async function preparedFixture() {
  const suite = await loadNarrativeEvalSuite({
    repoRoot: ROOT,
    suiteId: "chronicle-micro-v1",
  });
  const evalCase = suite.cases.find((candidate) => candidate.id === CASE_ID);
  if (!evalCase) throw new Error("Missing evaluation case " + CASE_ID);

  const contractModule = await import("./chronicleV2Contract");
  const contractSource =
    await import("../../../../evals/narrative/contracts/chronicle-v2/actual-gate-collapse.json");
  const loaded = contractModule.loadChronicleV2Contract(contractSource.default);
  if (!loaded.ok) throw new Error("Chronicle v2 contract failed to load");
  const runtimeDocuments = loaded.value.sourceDocuments.map((document) => ({
    ...document,
    id: "prepared-" + document.id,
  }));
  const sourceCase: NarrativeEvalCaseV1 = {
    ...evalCase,
    coverage: {
      ...evalCase.coverage,
      includedDocumentIds: runtimeDocuments.map((document) => document.id),
      omittedDocumentIds: [],
    },
    documents: runtimeDocuments,
    expected: { observations: { required: [], forbidden: [] } },
    criticalViolationClasses: [],
  };
  const prepared = await prepareProductionChronicleEvalCase(sourceCase, {
    evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  });
  return { prepared, contract: loaded.value };
}

function aliasForQuote(
  prepared: Awaited<ReturnType<typeof preparedFixture>>["prepared"],
  quote: string,
): string {
  const entry = prepared.evidenceSpanCatalog?.entries.find(
    (candidate) => candidate.quote === quote,
  );
  if (!entry) throw new Error("Missing evidence catalog quote: " + quote);
  const window = prepared.windows[0];
  if (!window?.windowId) throw new Error("Missing prepared observation window");
  const binding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
    window.windowId,
  );
  const alias = binding?.aliases.find(
    (candidate) =>
      candidate.canonicalSourceRef === entry.sourceRef &&
      candidate.windowIds.includes(window.windowId as string),
  );
  if (!alias) throw new Error("Missing evidence alias for quote: " + quote);
  return alias.alias;
}

function observationResponse(
  prepared: Awaited<ReturnType<typeof preparedFixture>>["prepared"],
): string {
  return JSON.stringify({
    observations: CALIBRATION_FIXTURE.baseResponse.observations.map(
      (observation) => ({
        localId: observation.localId,
        evidenceRefs: observation.evidence.map((evidence) =>
          aliasForQuote(prepared, evidence.quote),
        ),
        assertion: observation.assertion,
        payload: observation.payload,
      }),
    ),
  });
}

const MATCH_AXES = {
  predicate: "match",
  participants: "match",
  roles: "match",
  actuality: "match",
  attribution: "match",
  narrativeFrame: "match",
  sourceSupport: "match",
} as const;

function genuineJudgeResponse(input: ChronicleLlmJudgeInput) {
  return buildChronicleLlmJudgeResponse(input, {
    primaryAssignments: input.actualClaims.map((actual, index) => ({
      actualRef: actual.ref,
      goldRef: input.goldClaims[index]!.ref,
      axes: MATCH_AXES,
    })),
    unmatchedActuals: [],
    unmatchedGolds: [],
    temporalRelations: input.temporalRelations.map((relation) => {
      const targetIndex = input.goldClaims.findIndex(
        (gold) => gold.ref === relation.targetGoldRef,
      );
      const actual = input.actualClaims[targetIndex];
      if (!actual) throw new Error("Missing temporal target actual");
      return {
        relationRef: relation.ref,
        actualRef: actual.ref,
        status: "match" as const,
      };
    }),
  });
}

async function genuineRun(): Promise<{
  readonly run: ChronicleLlmJudgePreparedRun;
  readonly result: ChronicleLlmJudgeOfflineResult;
}> {
  const { prepared, contract } = await preparedFixture();
  const windowId = prepared.windows[0]?.windowId;
  if (!windowId) throw new Error("Missing prepared observation window");
  const run = await prepareChronicleLlmJudgeOfflineRun({
    prepared,
    contract,
    observationResponsesByWindowId: new Map([
      [windowId, observationResponse(prepared)],
    ]),
  });
  const result = await run.validate(
    JSON.stringify(genuineJudgeResponse(run.input)),
  );
  return { run, result };
}

async function removeTemp(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

async function readSavedProjection(
  saved: SavedChronicleLlmJudgeOfflineDiagnostic,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(saved.diagnosticPath, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Chronicle LLM judge diagnostic storage", () => {
  it("serializes one genuine result as a strict projection with safe modes", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-llm-judge-storage-success-"),
    );
    try {
      const { run, result } = await genuineRun();
      const saved = await saveChronicleLlmJudgeOfflineDiagnostic({
        run,
        result,
        outputRoot,
      });
      const projection = await readSavedProjection(saved);
      const runStat = await stat(saved.runDir);
      const fileStat = await stat(saved.diagnosticPath);
      const content = await readFile(saved.diagnosticPath, "utf8");

      expect(saved.runId).toBe(path.basename(saved.runDir));
      expect(saved.diagnosticPath).toBe(
        path.join(saved.runDir, "diagnostic.json"),
      );
      expect(runStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(saved.byteLength).toBe(Buffer.byteLength(content, "utf8"));
      await expect(sha256Digest(content)).resolves.toBe(saved.diagnosticDigest);
      expect(projection).toEqual(result.projection);
      expect(projection).not.toHaveProperty("input");
      expect(projection).not.toHaveProperty("raw");
      expect(projection).not.toHaveProperty("originalIdMap");
      expect(projection.decision).toEqual({
        primaryAssignments: expect.any(Array),
        unmatchedActuals: [],
        unmatchedGolds: [],
        temporalRelations: expect.any(Array),
      });
      expect(await readdir(outputRoot)).toEqual([saved.runId]);
    } finally {
      await removeTemp(outputRoot);
    }
  });

  it("allocates independent run directories without overwriting the first result", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-llm-judge-storage-rerun-"),
    );
    try {
      const first = await genuineRun();
      const firstSaved = await saveChronicleLlmJudgeOfflineDiagnostic({
        ...first,
        outputRoot,
      });
      const firstContent = await readFile(firstSaved.diagnosticPath, "utf8");

      const second = await genuineRun();
      const secondSaved = await saveChronicleLlmJudgeOfflineDiagnostic({
        ...second,
        outputRoot,
      });
      expect(secondSaved.runId).not.toBe(firstSaved.runId);
      expect(await readdir(outputRoot)).toEqual(
        expect.arrayContaining([firstSaved.runId, secondSaved.runId]),
      );
      expect(await readFile(firstSaved.diagnosticPath, "utf8")).toBe(
        firstContent,
      );
    } finally {
      await removeTemp(outputRoot);
    }
  });

  it("rejects a pre-existing destination without changing it", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-llm-judge-storage-collision-"),
    );
    const existingRunId = "fixed-run";
    try {
      const existingRunDir = path.join(outputRoot, existingRunId);
      await mkdir(existingRunDir, { mode: 0o700 });
      const sentinelPath = path.join(existingRunDir, "sentinel.txt");
      await writeFile(sentinelPath, "keep me\n", { mode: 0o600 });
      const before = await readFile(sentinelPath, "utf8");
      const genuine = await genuineRun();

      await expect(
        saveChronicleLlmJudgeOfflineDiagnostic({
          ...genuine,
          outputRoot,
          createRunId: () => existingRunId,
        }),
      ).rejects.toMatchObject({
        code: "JUDGE_DIAGNOSTIC_DESTINATION_EXISTS",
      });
      expect(await readFile(sentinelPath, "utf8")).toBe(before);
      expect(await readdir(outputRoot)).toEqual([existingRunId]);
    } finally {
      await removeTemp(outputRoot);
    }
  });

  it("rejects forged and cross-context results before creating any run directory", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-llm-judge-storage-forged-"),
    );
    try {
      const left = await genuineRun();
      const right = await genuineRun();
      await expect(
        saveChronicleLlmJudgeOfflineDiagnostic({
          run: left.run,
          result: right.result,
          outputRoot,
        }),
      ).rejects.toMatchObject({
        code: "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED",
      });
      expect(await readdir(outputRoot)).toEqual([]);

      const forgedResult = structuredClone(left.result);
      await expect(
        saveChronicleLlmJudgeOfflineDiagnostic({
          run: left.run,
          result: forgedResult,
          outputRoot,
        }),
      ).rejects.toMatchObject({
        code: "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED",
      });
      expect(await readdir(outputRoot)).toEqual([]);
    } finally {
      await removeTemp(outputRoot);
    }
  });

  it("rejects an untrusted duck-typed run before filesystem mutation", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-llm-judge-storage-duck-"),
    );
    try {
      const genuine = await genuineRun();
      const serialize = vi.fn(async () =>
        JSON.stringify({ ...genuine.result.projection, raw: "secret" }),
      );
      const fakeRun = { serialize } as unknown as ChronicleLlmJudgePreparedRun;

      await expect(
        saveChronicleLlmJudgeOfflineDiagnostic({
          run: fakeRun,
          result: genuine.result,
          outputRoot,
        }),
      ).rejects.toMatchObject({
        code: "JUDGE_DIAGNOSTIC_SERIALIZATION_FAILED",
      });
      expect(serialize).not.toHaveBeenCalled();
      expect(await readdir(outputRoot)).toEqual([]);
    } finally {
      await removeTemp(outputRoot);
    }
  });

  it("rejects symlink roots and unsafe injected run IDs without writing outside the root", async () => {
    const parentRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-llm-judge-storage-symlink-"),
    );
    const targetRoot = path.join(parentRoot, "target");
    const symlinkRoot = path.join(parentRoot, "link");
    await mkdir(targetRoot, { mode: 0o700 });
    await symlink(targetRoot, symlinkRoot, "dir");
    try {
      const genuine = await genuineRun();
      await expect(
        saveChronicleLlmJudgeOfflineDiagnostic({
          ...genuine,
          outputRoot: symlinkRoot,
        }),
      ).rejects.toMatchObject({ code: "JUDGE_DIAGNOSTIC_OUTPUT_ROOT_INVALID" });
      expect(await readdir(targetRoot)).toEqual([]);

      const second = await genuineRun();
      await expect(
        saveChronicleLlmJudgeOfflineDiagnostic({
          ...second,
          outputRoot: targetRoot,
          createRunId: () => "../outside",
        }),
      ).rejects.toMatchObject({ code: "JUDGE_DIAGNOSTIC_RUN_ID_INVALID" });
      expect(await readdir(targetRoot)).toEqual([]);
    } finally {
      await removeTemp(parentRoot);
    }
  });
});
