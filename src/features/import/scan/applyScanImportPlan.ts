import type { ImportedNode } from "../importTypes";
import type {
  ScanCodexImportPlan,
  ScanEventImportPlan,
  ScanFindingImportPlan,
  ScanImportPlan,
  ScanPhaseImportPlan,
  ScanRelationImportPlan,
} from "./scanImportPlan";

export type ScanImportStage =
  | "create"
  | "tree"
  | "codex"
  | "relations"
  | "phases"
  | "events"
  | "findings"
  | "metadata"
  | "publish";

export interface ScanImportStageResult {
  imported: number;
  errors: string[];
}

export interface ScanImportApplyOperations {
  createStagingProject(input: {
    title: string;
    language: "ja" | "en";
    sourceFingerprint: string;
  }): Promise<{ projectId: string }>;
  importTree(
    projectId: string,
    nodes: readonly ImportedNode[],
  ): Promise<ScanImportStageResult>;
  importCodexEntries(
    projectId: string,
    entries: readonly ScanCodexImportPlan[],
  ): Promise<ScanImportStageResult>;
  importRelations(
    projectId: string,
    relations: readonly ScanRelationImportPlan[],
  ): Promise<ScanImportStageResult>;
  importPhases(
    projectId: string,
    phases: readonly ScanPhaseImportPlan[],
  ): Promise<ScanImportStageResult>;
  importEvents(
    projectId: string,
    events: readonly ScanEventImportPlan[],
  ): Promise<ScanImportStageResult>;
  importFindings(
    projectId: string,
    findings: readonly ScanFindingImportPlan[],
  ): Promise<ScanImportStageResult>;
  updateProjectMetadata(
    projectId: string,
    metadata: { title: string; sourceFingerprint: string },
  ): Promise<void>;
  publishStagingProject(projectId: string): Promise<void>;
  discardStagingProject(projectId: string): Promise<void>;
}

export interface ScanImportApplyResult {
  projectId: string;
  imported: {
    tree: number;
    codexEntries: number;
    relations: number;
    phases: number;
    events: number;
    findings: number;
  };
  warnings: string[];
}

export class ScanImportApplyError extends Error {
  readonly name = "ScanImportApplyError";

  constructor(
    readonly stage: ScanImportStage,
    readonly projectId: string | undefined,
    cause: unknown,
    readonly cleanupError?: unknown,
  ) {
    super(
      `Scan import failed during ${stage}${
        projectId ? ` for ${projectId}` : ""
      }`,
      { cause },
    );
  }
}

function assertPlanShape(plan: ScanImportPlan): void {
  if (plan.schemaVersion !== "grimodex-scan/import-plan/1") {
    throw new ScanImportApplyError(
      "create",
      undefined,
      new Error("Unsupported Scan import plan schema"),
    );
  }
  if (!plan.projectTitle.trim()) {
    throw new ScanImportApplyError(
      "create",
      undefined,
      new Error("Scan import project title is empty"),
    );
  }
  if (!plan.importInstanceId.trim()) {
    throw new ScanImportApplyError(
      "create",
      undefined,
      new Error("Scan import instance ID is empty"),
    );
  }
  if (
    !/^sha256:[a-f0-9]{64}$/.test(plan.sourceFingerprint) &&
    !/^[a-f0-9]{64}$/.test(plan.sourceFingerprint)
  ) {
    throw new ScanImportApplyError(
      "create",
      undefined,
      new Error("Scan import source fingerprint is invalid"),
    );
  }
}

function assertStageResult(
  stage: ScanImportStage,
  result: ScanImportStageResult,
): number {
  if (result.errors.length > 0) {
    throw new Error(
      `${stage} reported partial failures: ${result.errors.join("; ")}`,
    );
  }
  return result.imported;
}

export async function applyScanImportPlan(
  plan: ScanImportPlan,
  operations: ScanImportApplyOperations,
): Promise<ScanImportApplyResult> {
  assertPlanShape(plan);

  let projectId: string | undefined;
  let stage: ScanImportStage = "create";
  try {
    const created = await operations.createStagingProject({
      title: plan.projectTitle,
      language: plan.language,
      sourceFingerprint: plan.sourceFingerprint,
    });
    projectId = created.projectId;
    if (!projectId) throw new Error("Staging project did not return an id");

    stage = "tree";
    const tree = assertStageResult(
      stage,
      await operations.importTree(projectId, plan.nodes),
    );
    stage = "codex";
    const codexEntries = assertStageResult(
      stage,
      await operations.importCodexEntries(projectId, plan.codexEntries),
    );
    stage = "relations";
    const relations = assertStageResult(
      stage,
      await operations.importRelations(projectId, plan.relations),
    );
    stage = "phases";
    const phases = assertStageResult(
      stage,
      await operations.importPhases(projectId, plan.phases),
    );
    stage = "events";
    const events = assertStageResult(
      stage,
      await operations.importEvents(projectId, plan.events),
    );
    stage = "findings";
    const findings = assertStageResult(
      stage,
      await operations.importFindings(projectId, plan.findings),
    );
    stage = "metadata";
    await operations.updateProjectMetadata(projectId, {
      title: plan.projectTitle,
      sourceFingerprint: plan.sourceFingerprint,
    });
    stage = "publish";
    await operations.publishStagingProject(projectId);

    return {
      projectId,
      imported: { tree, codexEntries, relations, phases, events, findings },
      warnings: [...plan.warnings],
    };
  } catch (cause) {
    if (!projectId) {
      if (cause instanceof ScanImportApplyError) throw cause;
      throw new ScanImportApplyError(stage, undefined, cause);
    }
    try {
      await operations.discardStagingProject(projectId);
    } catch (cleanupError) {
      throw new ScanImportApplyError(stage, projectId, cause, cleanupError);
    }
    throw new ScanImportApplyError(stage, projectId, cause);
  }
}
