import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NARRATIVE_EVAL_SUITE_ID,
  loadNarrativeEvalSuite,
  narrativeEvalSuiteIdFromEnv,
} from "./narrativeEvalSuite";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

async function writeFixtureRepo({
  manifest,
  corpus,
  escaped,
}: {
  readonly manifest: string;
  readonly corpus?: string;
  readonly escaped?: string;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrative-eval-suite-"));
  await mkdir(path.join(root, "evals/narrative/cases"), { recursive: true });
  await mkdir(path.join(root, "evals/narrative/schemas"), { recursive: true });
  await writeFile(path.join(root, "evals/narrative/manifest.yaml"), manifest);
  if (corpus !== undefined) {
    await writeFile(
      path.join(root, "evals/narrative/cases/suite.yaml"),
      corpus,
    );
  }
  if (escaped !== undefined) {
    await writeFile(path.join(root, "evals/narrative/escaped.yaml"), escaped);
  }
  return root;
}

function manifestFor({
  id = "chronicle-micro-v1",
  caseFile = "cases/suite.yaml",
  caseCount = 0,
}: {
  readonly id?: string;
  readonly caseFile?: string;
  readonly caseCount?: number;
} = {}) {
  return [
    "schemaVersion: 1",
    "id: narrative-extraction-eval",
    "gold:",
    "  authority: human",
    "suites:",
    `  - id: ${id}`,
    "    version: 1",
    "    slice: chronicle",
    "    tier: micro",
    "    caseSchema: schemas/case-v1.schema.json",
    `    caseFile: ${caseFile}`,
    `    caseCount: ${caseCount}`,
    "    requirementIds: []",
    "    certification:",
    "      diagnosticOnly: false",
    "",
  ].join("\n");
}

describe("narrative evaluation suite loader", () => {
  it("resolves the manifest suite, validates its corpus, and exposes digests", async () => {
    const loaded = await loadNarrativeEvalSuite({
      repoRoot,
      suiteId: DEFAULT_NARRATIVE_EVAL_SUITE_ID,
    });

    expect(loaded.suiteId).toBe("chronicle-micro-v1");
    expect(loaded.caseFile).toBe("cases/chronicle-micro-v1.yaml");
    expect(loaded.caseCount).toBe(14);
    expect(loaded.diagnosticOnly).toBe(false);
    expect(loaded.cases).toHaveLength(14);
    expect(loaded.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded.caseFileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("loads the motif boundary suite as diagnostic-only without using the qualification suite id", async () => {
    const loaded = await loadNarrativeEvalSuite({
      repoRoot,
      suiteId: "chronicle-motif-boundary-v1",
    });

    expect(loaded.suiteId).toBe("chronicle-motif-boundary-v1");
    expect(loaded.caseCount).toBe(5);
    expect(loaded.cases).toHaveLength(5);
    expect(loaded.diagnosticOnly).toBe(true);
    expect(
      narrativeEvalSuiteIdFromEnv({
        NARRATIVE_EVAL_SUITE_ID: "chronicle-motif-boundary-v1",
        QUALITY_EVALUATION_SUITE_ID: "heavy-narrative-chronicle-production",
      }),
    ).toBe("chronicle-motif-boundary-v1");
  });

  it("keeps the existing certification suite as the default", () => {
    expect(narrativeEvalSuiteIdFromEnv({})).toBe(
      DEFAULT_NARRATIVE_EVAL_SUITE_ID,
    );
    expect(
      narrativeEvalSuiteIdFromEnv({
        QUALITY_EVALUATION_SUITE_ID: "heavy-narrative-chronicle-production",
      }),
    ).toBe(DEFAULT_NARRATIVE_EVAL_SUITE_ID);
  });

  it("fails closed for unknown suites", async () => {
    await expect(
      loadNarrativeEvalSuite({
        repoRoot,
        suiteId: "chronicle-does-not-exist",
      }),
    ).rejects.toThrow(/Unknown narrative evaluation suite/);
  });

  it("fails closed when the corpus suite id does not match the manifest", async () => {
    const root = await writeFixtureRepo({
      manifest: manifestFor({ caseCount: 0 }),
      corpus: "schemaVersion: 1\nsuiteId: another-suite\ncases: []\n",
    });
    try {
      await expect(loadNarrativeEvalSuite({ repoRoot: root })).rejects.toThrow(
        /suiteId mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the corpus case count differs from the manifest", async () => {
    const root = await writeFixtureRepo({
      manifest: manifestFor({ caseCount: 2 }),
      corpus: "schemaVersion: 1\nsuiteId: chronicle-micro-v1\ncases: []\n",
    });
    try {
      await expect(loadNarrativeEvalSuite({ repoRoot: root })).rejects.toThrow(
        /caseCount mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a case file outside the manifest cases directory before reading it", async () => {
    const root = await writeFixtureRepo({
      manifest: manifestFor({ caseFile: "../escaped.yaml", caseCount: 0 }),
      escaped: "schemaVersion: 1\nsuiteId: chronicle-micro-v1\ncases: []\n",
    });
    try {
      await expect(loadNarrativeEvalSuite({ repoRoot: root })).rejects.toThrow(
        /case file must stay inside/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
