import { describe, expect, it, vi } from "vitest";
import { IpcInvokeError } from "@/lib/tauri";
import type { ScanImportPlan } from "./scanImportPlan";
import {
  applyScanImportPlan,
  type ScanImportApplyOperations,
} from "./applyScanImportPlan";

const publishReceipt = {
  projectId: "staging-project",
  semanticEpochId: "epoch-1",
  __writeReceipt: {
    changeEventUid: "event-1",
    maintenanceTransactionId: "tx-1",
    undoJournalId: null,
  },
};

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
      return publishReceipt;
    }),
    refreshPublishedProject: vi.fn(async () => {
      calls.push("refresh");
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
      "refresh",
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

  it("keeps a committed publish when the post-commit UI refresh fails", async () => {
    const calls: string[] = [];
    const operations = makeOperations(calls);
    const refreshPublishedProject = vi.fn(async () => {
      calls.push("refresh");
      throw new Error("refresh failed");
    });
    Object.assign(operations, { refreshPublishedProject });

    const result = await applyScanImportPlan(makePlan(), operations);

    expect(result.projectId).toBe("staging-project");
    expect(refreshPublishedProject).toHaveBeenCalledOnce();
    expect(operations.discardStagingProject).not.toHaveBeenCalled();
  });

  it("does not discard after an ambiguous native publish outcome", async () => {
    const calls: string[] = [];
    const operations = makeOperations(calls, {
      publishStagingProject: vi.fn(async () => {
        calls.push("publish");
        throw new IpcInvokeError("scan_staging_project_publish", {
          code: "IPC_TIMEOUT",
          message: "publish outcome is ambiguous",
          retryable: true,
          outcome: "unknown",
        });
      }),
    });

    await expect(
      applyScanImportPlan(makePlan(), operations),
    ).rejects.toMatchObject({
      name: "ScanImportApplyError",
      stage: "publish",
      projectId: "staging-project",
    });
    expect(operations.discardStagingProject).not.toHaveBeenCalled();
  });

  it("discards only when native publish is known not to be committed", async () => {
    const calls: string[] = [];
    const operations = makeOperations(calls, {
      publishStagingProject: vi.fn(async () => {
        calls.push("publish");
        throw new IpcInvokeError("scan_staging_project_publish", {
          code: "UNKNOWN",
          message: "native publish rolled back",
          retryable: false,
          outcome: "failed",
        });
      }),
    });

    await expect(
      applyScanImportPlan(makePlan(), operations),
    ).rejects.toMatchObject({
      name: "ScanImportApplyError",
      stage: "publish",
      projectId: "staging-project",
    });
    expect(operations.discardStagingProject).toHaveBeenCalledWith(
      "staging-project",
    );
  });
});
