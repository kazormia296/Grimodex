import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  createCodexRelation: vi.fn(),
  createPhase: vi.fn(),
  createCodexType: vi.fn(),
  ensureBuiltinTypes: vi.fn(),
  listCodexTypes: vi.fn(),
  createEvent: vi.fn(),
  linkScenesToEvent: vi.fn(),
  setEventParticipants: vi.fn(),
  createNode: vi.fn(),
  listNodes: vi.fn(),
  saveSceneContent: vi.fn(),
  getProject: vi.fn(),
  createScanStagingProject: vi.fn(),
  publishScanStagingProject: vi.fn(),
  deleteProjectSetting: vi.fn(),
}));

vi.mock("@/features/codex/api", () => ({
  createCodexEntry: mocks.createCodexEntry,
  updateCodexEntry: mocks.updateCodexEntry,
}));
vi.mock("@/features/codex/codexRelationApi", () => ({
  createCodexRelation: mocks.createCodexRelation,
}));
vi.mock("@/features/codex/phaseApi", () => ({
  createPhase: mocks.createPhase,
}));
vi.mock("@/features/codex/typeApi", () => ({
  createCodexType: mocks.createCodexType,
  ensureBuiltinTypes: mocks.ensureBuiltinTypes,
  listCodexTypes: mocks.listCodexTypes,
}));
vi.mock("@/features/chronicle/api", () => ({
  createEvent: mocks.createEvent,
  linkScenesToEvent: mocks.linkScenesToEvent,
  setEventParticipants: mocks.setEventParticipants,
}));
vi.mock("@/features/tree/api", () => ({
  createNode: mocks.createNode,
  listNodes: mocks.listNodes,
  saveSceneContent: mocks.saveSceneContent,
}));
vi.mock("@/features/tree/fractionalIndex", () => ({
  generateNKeysBetween: (
    _left: string | null,
    _right: string | null,
    count: number,
  ) => Array.from({ length: count }, (_unused, index) => `a${index}`),
}));
vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: vi.fn(),
}));
vi.mock("@/features/project/api", () => ({
  deleteProject: vi.fn(),
  getProject: mocks.getProject,
  updateProject: vi.fn(),
}));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      refreshProjects: vi.fn(),
      loadProject: vi.fn(),
    }),
  },
}));
vi.mock("@/features/settings/api", () => ({
  deleteProjectSetting: mocks.deleteProjectSetting,
  setProjectSetting: vi.fn(),
}));
vi.mock("@/features/settings/migration", () => ({
  seedProjectSettingsFromDefaults: vi.fn(),
}));
vi.mock("../importApi", () => ({
  fieldValueToProseMirror: (value: string) =>
    JSON.stringify({ type: "doc", content: [{ type: "text", text: value }] }),
}));
vi.mock("./scanStagingProject", () => ({
  createScanStagingProject: mocks.createScanStagingProject,
  publishScanStagingProject: mocks.publishScanStagingProject,
}));

import {
  createScanImportOperations,
  createScanImportOperationsForPlan,
} from "./scanImportOperations";
import type { ScanImportPlan } from "./scanImportPlan";

const projectId = "scan-project";

function plan(): ScanImportPlan {
  return {
    schemaVersion: "grimodex-scan/import-plan/1",
    importInstanceId: "scan-instance",
    projectTitle: "Imported novel",
    language: "ja",
    sourceFingerprint: "a".repeat(64),
    nodes: [
      {
        kind: "folder",
        id: "folder-1",
        title: "Chapter",
        children: [
          { kind: "scene", id: "scene-1", title: "Scene", body: "本文" },
        ],
      },
    ],
    codexEntries: [
      {
        id: "entry-1",
        sourceEntityId: "source-entry-1",
        type: "organization",
        name: "組織",
        aliases: [],
        summary: "概要",
        confidence: 1,
        evidence: [
          {
            sectionId: "section-1",
            paragraphId: "paragraph-1",
            excerpt: "根拠",
          },
        ],
      },
    ],
    relations: [
      {
        id: "relation-1",
        sourceRelationId: "source-relation-1",
        fromCodexId: "entry-1",
        toCodexId: "entry-2",
        type: "ally",
        confidence: 1,
        evidence: [],
      },
    ],
    phases: [
      {
        id: "phase-1",
        sourcePhaseId: "source-phase-1",
        title: "Phase",
        entityIds: ["entry-1"],
        anchors: [],
        confidence: 1,
      },
    ],
    events: [
      {
        id: "event-1",
        sourceEventId: "source-event-1",
        sectionId: "folder-1",
        sourceSectionId: "source-section-1",
        sceneId: "scene-1",
        paragraphIds: [],
        entityIds: ["entry-1", "entry-2"],
        title: "Event",
        order: 0,
        evidence: [],
      },
    ],
    findings: [
      {
        id: "finding-1",
        sourceFindingId: "source-finding-1",
        kind: "other",
        status: "candidate",
        title: "Finding",
        summary: "Summary",
        evidence: [],
      },
    ],
    idMap: {
      sections: {},
      paragraphs: {},
      entities: {},
      relations: {},
      phases: {},
      events: {},
      findings: {},
    },
    warnings: [],
  };
}

function expectImportWriteContext(value: unknown): void {
  expect(value).toEqual(
    expect.objectContaining({
      writeContext: expect.objectContaining({
        origin: "import",
        originalTransactionId: null,
        undoJournalId: null,
      }),
    }),
  );
}

describe("Scan canonical writer origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listNodes.mockResolvedValue([]);
    mocks.listCodexTypes.mockResolvedValue([]);
    mocks.getProject.mockResolvedValue({ language: "ja" });
    mocks.createEvent.mockResolvedValue({ id: "event-1" });
  });

  it("marks every canonical Scan apply mutation as import", async () => {
    const importPlan = plan();
    const operations = createScanImportOperationsForPlan(importPlan);

    await operations.importTree(projectId, importPlan.nodes);
    await operations.importCodexEntries(projectId, importPlan.codexEntries);
    await operations.importRelations(projectId, importPlan.relations);
    await operations.importPhases(projectId, importPlan.phases);
    await operations.importEvents(projectId, importPlan.events);
    await operations.importFindings(projectId, importPlan.findings);

    expect(mocks.createNode).toHaveBeenCalledTimes(3);
    for (const call of mocks.createNode.mock.calls) {
      expectImportWriteContext(call[1]);
    }
    const sceneCreate = mocks.createNode.mock.calls.find(
      ([input]) => input.id === "scene-1",
    );
    expect(sceneCreate?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('"type":"doc"'),
      }),
    );
    expect(mocks.saveSceneContent).not.toHaveBeenCalled();
    expect(mocks.ensureBuiltinTypes).toHaveBeenCalledWith(projectId, "ja", {
      origin: "import",
    });
    expectImportWriteContext(mocks.createCodexType.mock.calls[0]?.[1]);
    expectImportWriteContext(mocks.createCodexEntry.mock.calls[0]?.[1]);
    expect(mocks.createCodexEntry.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('"type":"doc"'),
      }),
    );
    expectImportWriteContext(mocks.updateCodexEntry.mock.calls[0]?.[3]);
    expect(mocks.updateCodexEntry.mock.calls[0]?.[2]).not.toHaveProperty(
      "content",
    );
    expectImportWriteContext(mocks.createCodexRelation.mock.calls[0]?.[1]);
    expectImportWriteContext(mocks.createPhase.mock.calls[0]?.[1]);
    expect(mocks.createEvent.mock.calls[0]?.[1]).toEqual({ origin: "import" });
    expect(mocks.linkScenesToEvent.mock.calls[0]?.[3]).toEqual({
      origin: "import",
    });
    expect(mocks.setEventParticipants.mock.calls[0]?.[3]).toEqual({
      origin: "import",
    });
  });

  it("uses import origin while seeding a Scan staging project", async () => {
    const operations = createScanImportOperations();
    await operations.createStagingProject({
      title: "Imported novel",
      language: "ja",
      sourceFingerprint: "a".repeat(64),
    });

    expect(mocks.ensureBuiltinTypes).toHaveBeenCalledWith(
      expect.any(String),
      "ja",
      { origin: "import" },
    );
  });

  it("publishes a Scan staging project through the typed import writer", async () => {
    const operations = createScanImportOperations();

    await operations.publishStagingProject(projectId);

    expect(mocks.publishScanStagingProject).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        origin: "import",
        authorityRoute: "import-apply",
        requestId: expect.any(String),
        eventUid: expect.any(String),
      }),
    );
    expect(mocks.deleteProjectSetting).not.toHaveBeenCalled();
  });

  it("creates a fresh canonical context for each independent publish invocation", async () => {
    const operations = createScanImportOperations();

    await operations.publishStagingProject(projectId);
    await operations.publishStagingProject(projectId);

    const firstContext = mocks.publishScanStagingProject.mock.calls[0]?.[1];
    const secondContext = mocks.publishScanStagingProject.mock.calls[1]?.[1];
    expect(firstContext).toBeDefined();
    expect(secondContext).toBeDefined();
    expect(secondContext).not.toBe(firstContext);
    expect(secondContext).toEqual(
      expect.objectContaining({
        origin: "import",
        authorityRoute: "import-apply",
        requestId: expect.any(String),
        eventUid: expect.any(String),
      }),
    );
    expect(secondContext.requestId).not.toBe(firstContext.requestId);
  });
});
