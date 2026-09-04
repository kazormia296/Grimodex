import { db } from "@/db/client";
import { projectSettings, projects } from "@/db/schema";
import { and, eq, lte } from "drizzle-orm";
import { isUnknownIpcOutcomeError } from "@/lib/ipcOutcome";
import { invoke } from "@/lib/tauri";
import {
  createCanonicalWriteContext,
  type CanonicalWriteContext,
} from "@/features/native-writes/writeContext";
import { deleteProject } from "@/features/project/api";
import { SCAN_IMPORT_STATE_KEY, SCAN_IMPORT_STAGING } from "./scanImportState";
import type { ScanImportPublishReceipt } from "./applyScanImportPlan";

const STALE_SCAN_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_SCAN_IMPORT_BATCH_SIZE = 20;

/**
 * Create the project and its hidden staging marker in one native transaction.
 * A renderer crash must never expose a half-created Scan import as a normal
 * project in the switcher.
 */
export async function createScanStagingProject(input: {
  id: string;
  title: string;
  language: "ja" | "en";
}): Promise<void> {
  const now = new Date().toISOString();
  await invoke("scan_staging_project_create", {
    payload: {
      id: input.id,
      title: input.title,
      language: input.language,
      createdAt: now,
    },
  });
}

/**
 * Publish a completed Scan import through the typed import-authority writer.
 * Native Rust removes the staging marker only after the canonical event,
 * Change Feed, and any C2-ZC birth Epoch have committed.
 */
export async function publishScanStagingProject(
  projectId: string,
  writeContext: CanonicalWriteContext = createCanonicalWriteContext("import"),
): Promise<ScanImportPublishReceipt> {
  // Keep one object for the entire attempt. If the caller timed out after
  // native commit, replaying this exact payload lets native idempotency return
  // the original durable receipt instead of creating a second write identity.
  const request = {
    payload: {
      projectId,
      ...writeContext,
    },
  };

  try {
    return await invokePublishRequest(
      projectId,
      writeContext.eventUid,
      request,
    );
  } catch (cause) {
    if (!isUnknownIpcOutcomeError(cause)) throw cause;
    try {
      return await invokePublishRequest(
        projectId,
        writeContext.eventUid,
        request,
      );
    } catch (retryCause) {
      // The first attempt may have committed even when the replay also fails
      // (for example, a response path remains unavailable). Keep this
      // explicitly ambiguous so apply-level cleanup cannot delete the Project.
      throw new ScanImportPublishUnknownOutcomeError(cause, retryCause);
    }
  }
}

async function invokePublishRequest(
  projectId: string,
  eventUid: string,
  request: Record<string, unknown>,
): Promise<ScanImportPublishReceipt> {
  const response = await invoke<unknown>(
    "scan_staging_project_publish",
    request,
  );
  try {
    return parseScanImportPublishReceipt(projectId, eventUid, response);
  } catch (cause) {
    // A successful transport with an unusable receipt still leaves commit
    // state uncertain; route it through the same exact-request replay path.
    throw new ScanImportPublishUnknownOutcomeError(cause);
  }
}

export class ScanImportPublishUnknownOutcomeError extends Error {
  readonly outcome = "unknown" as const;
  readonly name = "ScanImportPublishUnknownOutcomeError";

  constructor(
    readonly firstError: unknown,
    readonly retryError?: unknown,
  ) {
    super("Scan staging publication outcome is ambiguous", {
      cause: retryError ?? firstError,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScanImportPublishReceipt(
  projectId: string,
  eventUid: string,
  response: unknown,
): ScanImportPublishReceipt {
  let value: unknown = response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch (cause) {
      throw new Error("Scan staging publish returned invalid JSON", { cause });
    }
  }
  if (!isRecord(value) || value.projectId !== projectId) {
    throw new Error("Scan staging publish receipt has an unexpected project");
  }
  if (
    value.semanticEpochId !== null &&
    typeof value.semanticEpochId !== "string"
  ) {
    throw new Error("Scan staging publish receipt has an invalid epoch");
  }
  if (!isRecord(value.__writeReceipt)) {
    throw new Error("Scan staging publish receipt is missing write metadata");
  }
  const receipt = value.__writeReceipt;
  if (
    receipt.changeEventUid !== eventUid ||
    typeof receipt.changeEventUid !== "string" ||
    receipt.changeEventUid.length === 0 ||
    typeof receipt.maintenanceTransactionId !== "string" ||
    receipt.maintenanceTransactionId.length === 0 ||
    (receipt.undoJournalId !== null &&
      receipt.undoJournalId !== undefined &&
      typeof receipt.undoJournalId !== "string")
  ) {
    throw new Error("Scan staging publish receipt is incomplete");
  }
  return value as unknown as ScanImportPublishReceipt;
}

/**
 * Remove hidden imports left behind by a renderer/process crash. A generous
 * grace period ensures a live import is never reclaimed during normal work,
 * while the bounded batch keeps workspace startup predictable.
 */
export async function cleanupStaleScanStagingProjects(
  now = new Date(),
): Promise<number> {
  const staleBefore = new Date(
    now.getTime() - STALE_SCAN_IMPORT_TTL_MS,
  ).toISOString();
  const staleRows = await db
    .select({ projectId: projectSettings.projectId })
    .from(projectSettings)
    .innerJoin(projects, eq(projects.id, projectSettings.projectId))
    .where(
      and(
        eq(projectSettings.key, SCAN_IMPORT_STATE_KEY),
        eq(projectSettings.value, SCAN_IMPORT_STAGING),
        lte(projects.createdAt, staleBefore),
      ),
    )
    .limit(STALE_SCAN_IMPORT_BATCH_SIZE);
  const projectIds = staleRows.map((row) => row.projectId);
  if (projectIds.length === 0) return 0;
  for (const projectId of projectIds) await deleteProject(projectId);
  return projectIds.length;
}
