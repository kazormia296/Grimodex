import { describe, expect, it, vi } from "vitest";
import type { ScanImportPlan } from "./scanImportPlan";
import {
  applyScanImportPlan,
  type ScanImportApplyOperations,
} from "./applyScanImportPlan";

function makePlan(): ScanImportPlan {
  return {
    schemaVersion: "grimodex-scan/import-plan/1",
    importInstanceId: "import-test",
    projectTitle: "Scan import",
    language: "ja",
    sourceFingerprint: "a".repeat(64),
    nodes: [
      {
        kind: "folder",
        id: "folder-1",
        title: "Chapter 1",
        children: [
          { kind: "scene", id: "scene-1", title: "Scene 1", body: "本文" },
        ],
      },
    ],
    codexEntries: [],
    relations: [],
    phases: [],
    events: [],
    findings: [],
    idMap: {
      sections: { "section-1": "folder-1" },
      paragraphs: { "paragraph-1": "scene-1" },
      entities: {},
      relations: {},
      phases: {},
      events: {},
      findings: {},
    },
    warnings: [],
  };
}

function makeOperations(
  calls: string[],
  overrides: Partial<ScanImportApplyOperations> = {},
): ScanImportApplyOperations {
  return {
    createStagingProject: vi.fn(async () => {
      calls.push("create");
      return { projectId: "staging-project" };
    }),
    importTree: vi.fn(async () => {
      calls.push("tree");
      return { imported: 2, errors: [] };
    }),
    importCodexEntries: vi.fn(async () => {
      calls.push("codex");
      return { imported: 0, errors: [] };
    }),
    importRelations: vi.fn(async () => {
      calls.push("relations");
      return { imported: 0, errors: [] };
    }),
    importPhases: vi.fn(async () => {
      calls.push("phases");
      return { imported: 0, errors: [] };
    }),
    importEvents: vi.fn(async () => {
      calls.push("events");
      return { imported: 0, errors: [] };
    }),
    importFindings: vi.fn(async () => {
      calls.push("findings");
      return { imported: 0, errors: [] };
    }),
    updateProjectMetadata: vi.fn(async () => {
      calls.push("metadata");
    }),
    publishStagingProject: vi.fn(async () => {
      calls.push("publish");
    }),
    discardStagingProject: vi.fn(async () => {
      calls.push("discard");
    }),
    ...overrides,
  };
}

describe("applyScanImportPlan", () => {
  it("applies every stage before publishing the staging project", async () => {
    const calls: string[] = [];
    const operations = makeOperations(calls);

    const result = await applyScanImportPlan(makePlan(), operations);

    expect(calls).toEqual([
      "create",
      "tree",
      "codex",
      "relations",
      "phases",
      "events",
      "findings",
      "metadata",
      "publish",
    ]);
    expect(result).toEqual({
      projectId: "staging-project",
      imported: {
        tree: 2,
        codexEntries: 0,
        relations: 0,
        phases: 0,
        events: 0,
        findings: 0,
      },
      warnings: [],
    });
  });

  it("discards the staging project and never publishes after a stage error", async () => {
    const calls: string[] = [];
    const operations = makeOperations(calls, {
      importEvents: vi.fn(async () => {
        calls.push("events");
        throw new Error("event insert failed");
      }),
    });

    await expect(
      applyScanImportPlan(makePlan(), operations),
    ).rejects.toMatchObject({
      name: "ScanImportApplyError",
      stage: "events",
      projectId: "staging-project",
      cause: expect.any(Error),
    });
    expect(calls).toEqual([
      "create",
      "tree",
      "codex",
      "relations",
      "phases",
      "events",
      "discard",
    ]);
    expect(operations.publishStagingProject).not.toHaveBeenCalled();
  });

  it("treats reported partial-import errors as fatal and preserves the errors", async () => {
    const calls: string[] = [];
    const operations = makeOperations(calls, {
      importCodexEntries: vi.fn(async () => {
        calls.push("codex");
        return { imported: 1, errors: ["Alice: invalid content"] };
      }),
    });

    await expect(
      applyScanImportPlan(makePlan(), operations),
    ).rejects.toMatchObject({
      name: "ScanImportApplyError",
      stage: "codex",
      cause: expect.objectContaining({
        message: expect.stringContaining("Alice: invalid content"),
      }),
    });
    expect(calls).toEqual(["create", "tree", "codex", "discard"]);
  });
});
