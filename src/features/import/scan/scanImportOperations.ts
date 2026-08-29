import { createCodexEntry, updateCodexEntry } from "@/features/codex/api";
import { createCodexRelation } from "@/features/codex/codexRelationApi";
import { createPhase } from "@/features/codex/phaseApi";
import {
  createCodexType,
  ensureBuiltinTypes,
  listCodexTypes,
} from "@/features/codex/typeApi";
import {
  createEvent,
  linkScenesToEvent,
  setEventParticipants,
} from "@/features/chronicle/api";
import { createNode, listNodes, saveSceneContent } from "@/features/tree/api";
import {
  createCanonicalWriteContext,
  type CanonicalWriteContext,
} from "@/features/native-writes/writeContext";
import { generateNKeysBetween } from "@/features/tree/fractionalIndex";
import { scheduleImeExportRefresh } from "@/features/ime/scheduler";
import {
  deleteProject,
  getProject,
  updateProject,
} from "@/features/project/api";
import { useProjectStore } from "@/features/project/projectStore";
import { setProjectSetting } from "@/features/settings/api";
import { seedProjectSettingsFromDefaults } from "@/features/settings/migration";
import { fieldValueToProseMirror } from "../importApi";
import type { ImportedNode } from "../importTypes";
import type {
  ScanCodexImportPlan,
  ScanEventImportPlan,
  ScanFindingImportPlan,
  ScanImportPlan,
  ScanPhaseImportPlan,
  ScanRelationImportPlan,
} from "./scanImportPlan";
import { deriveScanImportId } from "./scanImportPlan";
import {
  createScanStagingProject,
  publishScanStagingProject,
} from "./scanStagingProject";
import type {
  ScanImportApplyOperations,
  ScanImportPublishReceipt,
  ScanImportStageResult,
} from "./applyScanImportPlan";

export const SCAN_IMPORT_FINGERPRINT_KEY = "scan.import.sourceFingerprint";

function result(imported: number): ScanImportStageResult {
  return { imported, errors: [] };
}

function sceneContent(node: Extract<ImportedNode, { kind: "scene" }>): string {
  if (node.bodyProseMirror) return node.bodyProseMirror;
  if (node.body) return fieldValueToProseMirror(node.body);
  // Scan import currently stores normalized plain text. Markdown is kept as a
  // warning-level fallback so an unsupported rich body cannot become raw HTML.
  if (node.bodyMarkdown) return fieldValueToProseMirror(node.bodyMarkdown);
  return "{}";
}

function sceneCharCount(content: string): number {
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<{ text?: string; content?: unknown[] }>;
    };
    const walk = (
      nodes: Array<{ text?: string; content?: unknown[] }>,
    ): number =>
      nodes.reduce(
        (total, node) =>
          total +
          (node.text?.length ?? 0) +
          (Array.isArray(node.content)
            ? walk(
                node.content as Array<{ text?: string; content?: unknown[] }>,
              )
            : 0),
        0,
      );
    return walk(parsed.content ?? []);
  } catch {
    return 0;
  }
}

async function importNodes(
  projectId: string,
  roots: readonly ImportedNode[],
): Promise<ScanImportStageResult> {
  if (roots.length === 0) return result(0);
  const existingRoots = await listNodes(projectId, null);
  const lastRoot =
    [...existingRoots]
      .sort((left, right) => left.sortOrder.localeCompare(right.sortOrder))
      .at(-1)?.sortOrder ?? null;
  let imported = 0;

  async function insertNodes(
    nodes: readonly ImportedNode[],
    parentId: string | null,
  ): Promise<void> {
    const siblingKeys =
      parentId === null
        ? generateNKeysBetween(lastRoot, null, nodes.length)
        : generateNKeysBetween(null, null, nodes.length);
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const sortOrder = siblingKeys[index]!;
      if (node.kind === "folder") {
        await createNode(
          {
            id: node.id,
            projectId,
            parentId: parentId ?? undefined,
            nodeType: "folder",
            title: node.title || "Untitled",
            sortOrder,
          },
          { writeContext: createCanonicalWriteContext("import") },
        );
        imported++;
        await insertNodes(node.children, node.id);
        continue;
      }

      const content = sceneContent(node);
      await createNode(
        {
          id: node.id,
          projectId,
          parentId: parentId ?? undefined,
          nodeType: "scene",
          title: node.title || "Untitled",
          sortOrder,
        },
        { writeContext: createCanonicalWriteContext("import") },
      );
      if (content !== "{}") {
        await saveSceneContent(node.id, {
          content,
          charCount: sceneCharCount(content),
          writeContext: createCanonicalWriteContext("import"),
        });
      }
      imported++;
    }
  }

  await insertNodes(roots, null);
  return result(imported);
}

async function ensureScanCodexTypes(
  projectId: string,
  entries: readonly ScanCodexImportPlan[],
): Promise<void> {
  const existing = await listCodexTypes(projectId);
  const existingSlugs = new Set(existing.map((type) => type.slug));
  const labels: Record<string, string> = {
    organization: "Organization",
  };
  for (const type of new Set(entries.map((entry) => entry.type))) {
    if (existingSlugs.has(type)) continue;
    await createCodexType(
      {
        projectId,
        slug: type,
        label: labels[type] ?? type,
      },
      { writeContext: createCanonicalWriteContext("import") },
    );
    existingSlugs.add(type);
  }
}

function provenanceNote(entry: ScanCodexImportPlan): string | null {
  if (entry.evidence.length === 0) return null;
  const lines = [
    "Imported from Grimodex Scan.",
    `Confidence: ${entry.confidence.toFixed(3)}`,
    "Evidence:",
    ...entry.evidence.map(
      (evidence) =>
        `- ${evidence.sectionId}/${evidence.paragraphId}${
          evidence.excerpt ? `: ${evidence.excerpt}` : ""
        }`,
    ),
  ];
  return fieldValueToProseMirror(lines.join("\n"));
}

async function importCodex(
  projectId: string,
  entries: readonly ScanCodexImportPlan[],
): Promise<ScanImportStageResult> {
  if (entries.length === 0) return result(0);
  const project = await getProject(projectId);
  await ensureBuiltinTypes(projectId, project?.language ?? "ja", {
    origin: "import",
  });
  await ensureScanCodexTypes(projectId, entries);

  // Create all rows first, then attach parents. This makes parent order in an
  // AI-produced bundle irrelevant and keeps the whole stage rollbackable.
  for (const entry of entries) {
    await createCodexEntry(
      {
        id: entry.id,
        projectId,
        type: entry.type,
        name: entry.name,
        aliases: JSON.stringify(entry.aliases),
        summary: entry.summary,
      },
      {
        suppressImeExport: true,
        writeContext: createCanonicalWriteContext("import"),
      },
    );
  }
  for (const entry of entries) {
    await updateCodexEntry(
      projectId,
      entry.id,
      {
        ...(entry.parentId ? { parentId: entry.parentId } : {}),
        content: fieldValueToProseMirror(entry.summary ?? ""),
        notes: provenanceNote(entry),
      },
      {
        suppressImeExport: true,
        writeContext: createCanonicalWriteContext("import"),
      },
    );
  }
  return result(entries.length);
}

async function importRelations(
  projectId: string,
  relations: readonly ScanRelationImportPlan[],
): Promise<ScanImportStageResult> {
  for (const relation of relations) {
    await createCodexRelation(
      {
        id: relation.id,
        projectId,
        fromCodexId: relation.fromCodexId,
        toCodexId: relation.toCodexId,
        relationType: relation.type || "custom",
        label: relation.label,
      },
      { writeContext: createCanonicalWriteContext("import") },
    );
  }
  return result(relations.length);
}

async function importPhases(
  _projectId: string,
  phases: readonly ScanPhaseImportPlan[],
): Promise<ScanImportStageResult> {
  let imported = 0;
  for (const phase of phases) {
    const anchors = phase.anchors.length > 0 ? phase.anchors : [undefined];
    for (let index = 0; index < phase.entityIds.length; index += 1) {
      const entryId = phase.entityIds[index];
      if (!entryId) continue;
      for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
        await createPhase(
          {
            id:
              index === 0 && anchorIndex === 0
                ? phase.id
                : `${phase.id}:${index}:${anchorIndex}`,
            entryId,
            anchorNodeId:
              phase.anchorNodeIds?.[anchorIndex] ?? phase.anchorNodeId ?? null,
            label:
              anchorIndex === 0 && index === 0
                ? phase.title
                : `${phase.title} · 根拠 ${anchorIndex + 1}`,
            summaryOverride: phase.summary ?? null,
          },
          { writeContext: createCanonicalWriteContext("import") },
        );
        imported += 1;
      }
    }
  }
  return result(imported);
}

function eventOrdinal(index: number): string {
  return `a${String(index).padStart(12, "0")}`;
}

async function importEvents(
  projectId: string,
  events: readonly ScanEventImportPlan[],
): Promise<ScanImportStageResult> {
  const ordered = [...events].sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
  for (let index = 0; index < ordered.length; index++) {
    const event = ordered[index]!;
    const eventRow = await createEvent(
      {
        id: event.id,
        projectId,
        title: event.title,
        note: event.summary ?? null,
        ordinal: eventOrdinal(index),
        primaryCodexId: event.entityIds[0] ?? null,
      },
      { origin: "import" },
    );
    await linkScenesToEvent(projectId, [event.sceneId], eventRow.id, {
      origin: "import",
    });
    await setEventParticipants(
      eventRow.id,
      projectId,
      event.entityIds.slice(1),
      { origin: "import" },
    );
  }
  return result(events.length);
}

async function importFindings(
  projectId: string,
  plan: ScanImportPlan,
  findings: readonly ScanFindingImportPlan[],
): Promise<ScanImportStageResult> {
  if (findings.length === 0) return result(0);
  const rootRows = await listNodes(projectId, null);
  const lastRoot =
    [...rootRows]
      .sort((left, right) => left.sortOrder.localeCompare(right.sortOrder))
      .at(-1)?.sortOrder ?? null;
  const noteId = deriveScanImportId(
    plan.sourceFingerprint,
    "findings-note",
    "report",
    plan.importInstanceId,
  );
  const body = findings
    .map((finding) => {
      const evidence = finding.evidence
        .map(
          (item) =>
            `${item.sectionId}/${item.paragraphId}${item.excerpt ? `: ${item.excerpt}` : ""}`,
        )
        .join("; ");
      return `[${finding.status}] ${finding.title}\n${finding.summary}${
        evidence ? `\nEvidence: ${evidence}` : ""
      }`;
    })
    .join("\n\n");
  await createNode(
    {
      id: noteId,
      projectId,
      nodeType: "note",
      title: "Scan findings",
      sortOrder: generateNKeysBetween(lastRoot, null, 1)[0]!,
      content: fieldValueToProseMirror(body),
    },
    { writeContext: createCanonicalWriteContext("import") },
  );
  return result(findings.length);
}

export function createScanImportOperations(): ScanImportApplyOperations {
  return {
    async createStagingProject({ title, language, sourceFingerprint }) {
      const projectId = crypto.randomUUID();
      try {
        await createScanStagingProject({ id: projectId, title, language });
        await ensureBuiltinTypes(projectId, language, { origin: "import" });
        await seedProjectSettingsFromDefaults(projectId);
        await setProjectSetting(
          projectId,
          SCAN_IMPORT_FINGERPRINT_KEY,
          sourceFingerprint,
        );
        return { projectId };
      } catch (error) {
        await deleteProject(projectId).catch(() => {});
        throw error;
      }
    },

    importTree: (projectId, nodes) => importNodes(projectId, nodes),
    importCodexEntries: (projectId, entries) => importCodex(projectId, entries),
    importRelations,
    importPhases: (projectId, phases) => importPhases(projectId, phases),
    importEvents,
    importFindings: (projectId, findings) =>
      // The operation receives only its stage payload. The closure is filled
      // by createScanImportOperationsForPlan below when used by the UI.
      Promise.reject(
        new Error(
          `findings require a plan-bound adapter for ${projectId}: ${findings.length}`,
        ),
      ),
    async updateProjectMetadata(projectId, metadata) {
      await updateProject(
        projectId,
        { title: metadata.title },
        { suppressImeExport: true },
      );
      await setProjectSetting(
        projectId,
        SCAN_IMPORT_FINGERPRINT_KEY,
        metadata.sourceFingerprint,
      );
    },
    async publishStagingProject(projectId): Promise<ScanImportPublishReceipt> {
      // One apply operation owns one canonical publish identity. The publish
      // adapter retains this context while replaying an ambiguous transport
      // outcome; each separately invoked operation gets a fresh identity.
      const publishContext: CanonicalWriteContext =
        createCanonicalWriteContext("import");
      return publishScanStagingProject(projectId, publishContext);
    },
    async refreshPublishedProject(projectId, _receipt) {
      await useProjectStore.getState().refreshProjects();
      await useProjectStore.getState().loadProject(projectId);
      scheduleImeExportRefresh(projectId);
    },
    async discardStagingProject(projectId) {
      await deleteProject(projectId);
      await useProjectStore.getState().refreshProjects();
    },
  };
}

/** Bind the findings stage to the complete plan while keeping operations injectable in tests. */
export function createScanImportOperationsForPlan(
  plan: ScanImportPlan,
): ScanImportApplyOperations {
  const operations = createScanImportOperations();
  return {
    ...operations,
    importFindings: (projectId, findings) =>
      importFindings(projectId, plan, findings),
  };
}
