import type { QuiescenceLease } from "@/application/lifecycle/quiescenceLease";
import { acquireQuiescenceLeaseAfterTimelapseGenesis } from "@/features/timelapse/genesisQuiescence";
import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import { getLoadedProjectId } from "@/application/project/currentProjectAuthority";
import {
  getCurrentWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { awaitPendingIpcActualTasksForAuditExport } from "@/lib/ipcQueue";
import { awaitPendingAiAuditExecutions } from "./executionRegistry";

export interface AiAuditExportIdentity {
  readonly projectId: string;
  readonly workspace: WorkspaceIdentity;
}

const frozenReadProofBrand: unique symbol = Symbol("ai-audit-frozen-read");

/** Opaque proof issued only while the audit-export lease owns its read phase. */
export interface AiAuditFrozenReadProof {
  readonly [frozenReadProofBrand]: true;
}

const activeFrozenReadProofs = new WeakMap<
  AiAuditFrozenReadProof,
  AiAuditExportIdentity
>();

function issueFrozenReadProof(
  identity: AiAuditExportIdentity,
): AiAuditFrozenReadProof {
  const proof: AiAuditFrozenReadProof = Object.freeze({
    [frozenReadProofBrand]: true as const,
  });
  activeFrozenReadProofs.set(proof, identity);
  return proof;
}

function revokeFrozenReadProof(proof: AiAuditFrozenReadProof): void {
  activeFrozenReadProofs.delete(proof);
}

export function isAiAuditFrozenReadProof(
  value: unknown,
): value is AiAuditFrozenReadProof {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<AiAuditFrozenReadProof>)[frozenReadProofBrand] === true &&
    activeFrozenReadProofs.has(value as AiAuditFrozenReadProof)
  );
}

export function assertAiAuditFrozenReadProofActive(
  value: unknown,
  projectId: string,
): asserts value is AiAuditFrozenReadProof {
  if (!isAiAuditFrozenReadProof(value)) {
    throw new Error(
      "AI_AUDIT_FROZEN_READ_PROOF_INACTIVE: export boundary is no longer active",
    );
  }
  if (activeFrozenReadProofs.get(value)?.projectId !== projectId) {
    throw new Error(
      "AI_AUDIT_FROZEN_READ_PROOF_SCOPE_MISMATCH: proof belongs to another Project",
    );
  }
}

type AiAuditExportLease = Pick<
  QuiescenceLease,
  | "openControlledReadPhase"
  | "sealMutationAdmissionForControlledRead"
  | "release"
>;

interface AiAuditExportBoundaryDependencies {
  readonly acquireLease: (
    reason: "audit-export",
  ) => AiAuditExportLease | Promise<AiAuditExportLease>;
  readonly awaitPendingAiAuditExecutions: () => Promise<void>;
  readonly awaitPendingIpcActualTasks: () => Promise<void>;
  readonly flushStrictQuiescence: () => Promise<void>;
  readonly getLoadedProjectId: () => string | null;
  readonly getCurrentWorkspaceIdentity: () => WorkspaceIdentity | null;
}

export type AiAuditExportBoundaryOverrides =
  Partial<AiAuditExportBoundaryDependencies>;

const DEFAULT_DEPENDENCIES: AiAuditExportBoundaryDependencies = {
  acquireLease: acquireQuiescenceLeaseAfterTimelapseGenesis,
  awaitPendingAiAuditExecutions,
  awaitPendingIpcActualTasks: awaitPendingIpcActualTasksForAuditExport,
  flushStrictQuiescence,
  getLoadedProjectId,
  getCurrentWorkspaceIdentity,
};

function dependencies(
  overrides: AiAuditExportBoundaryOverrides = {},
): AiAuditExportBoundaryDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function assertExpectedIdentity(identity: AiAuditExportIdentity): void {
  if (
    identity.projectId.trim() === "" ||
    identity.workspace.path.trim() === "" ||
    !Number.isSafeInteger(identity.workspace.openRevision) ||
    identity.workspace.openRevision < 0
  ) {
    throw new Error("AI audit export requires a stable Project and Workspace");
  }
}

function assertCurrentIdentity(
  identity: AiAuditExportIdentity,
  deps: AiAuditExportBoundaryDependencies,
): void {
  const workspace = deps.getCurrentWorkspaceIdentity();
  if (
    deps.getLoadedProjectId() !== identity.projectId ||
    workspace?.path !== identity.workspace.path ||
    workspace.openRevision !== identity.workspace.openRevision
  ) {
    throw new Error(
      "AI_AUDIT_EXPORT_IDENTITY_CHANGED: Project or Workspace changed during export",
    );
  }
}

/**
 * Captures the exact renderer authority selected by the export click before
 * the heavyweight bundle module is loaded.
 */
export function captureAiAuditExportIdentity(
  projectId: string,
  overrides: AiAuditExportBoundaryOverrides = {},
): AiAuditExportIdentity {
  const deps = dependencies(overrides);
  const workspace = deps.getCurrentWorkspaceIdentity();
  const identity = workspace ? { projectId, workspace } : null;
  if (!identity) {
    throw new Error("AI audit export requires an active Workspace");
  }
  assertExpectedIdentity(identity);
  assertCurrentIdentity(identity, deps);
  return identity;
}

/**
 * Runs all report and ledger reads under one renderer-local frozen boundary.
 *
 * The lease closes application mutation/AI admission synchronously. Strict
 * quiescence then waits active renderer audits through their durable terminal,
 * retains and drains pre-existing native read/derived tasks that can append
 * Rust-side audit events, and drains resulting Browser/editor persistence.
 * After strict quiescence reaches registry zero, low-level mutation IPC closes
 * synchronously and every actual task is drained once more. The global
 * read/derived barriers remain closed; only deterministic audit-export
 * database queries are admitted for the supplied callback. Project/Workspace
 * replacement remains exclusive until every callback read settles.
 *
 * This is deliberately not described as a native multi-table snapshot:
 * external processes such as standalone MCP clients are outside this
 * renderer-local admission barrier and remain an explicit export limitation.
 */
export async function runAiAuditExportBoundary<T>(
  identity: AiAuditExportIdentity,
  readFrozenState: (proof: AiAuditFrozenReadProof) => Promise<T>,
  overrides: AiAuditExportBoundaryOverrides = {},
): Promise<T> {
  assertExpectedIdentity(identity);
  const deps = dependencies(overrides);
  const lease = await deps.acquireLease("audit-export");
  try {
    assertCurrentIdentity(identity, deps);
    await deps.awaitPendingAiAuditExecutions();
    await deps.awaitPendingIpcActualTasks();
    // A pre-existing IPC caller can settle a renderer continuation that owns
    // an already-reserved audit execution. Close that final handoff before the
    // general persistence flush begins.
    await deps.awaitPendingAiAuditExecutions();
    await deps.flushStrictQuiescence();
    // Strict flush can wait other producers after its own AI stage. Reassert
    // registry zero before closing the low-level mutation lane; a valid retry
    // child can only reserve while its pending parent is still visible here.
    await deps.awaitPendingAiAuditExecutions();
    lease.sealMutationAdmissionForControlledRead();
    // Close over a direct IPC scheduled by the final strict-flush continuation
    // before allowing even safe export reads.
    await deps.awaitPendingIpcActualTasks();
    await deps.awaitPendingAiAuditExecutions();
    assertCurrentIdentity(identity, deps);
    lease.openControlledReadPhase();
    const proof = issueFrozenReadProof(identity);
    try {
      const result = await readFrozenState(proof);
      assertAiAuditFrozenReadProofActive(proof, identity.projectId);
      assertCurrentIdentity(identity, deps);
      return result;
    } finally {
      revokeFrozenReadProof(proof);
    }
  } finally {
    lease.release();
  }
}
