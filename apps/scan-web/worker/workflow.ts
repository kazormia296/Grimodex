import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  buildScanArtifacts,
  adjudicateScan,
  buildScanChunks,
  extractScanChunks,
  mergeScanExtractions,
  normalizeScanSource,
  ScanDeletedError,
} from "./pipeline";
import type { ScanEnv } from "./env";
import { ScanRepository } from "./repository";
import { purgeDeletedScan } from "./retention";
import {
  canTransition,
  isTerminalStatus,
  type ScanStatus,
} from "./stateMachine";
import { isCancellationRequestedOrTerminal } from "./workflowState";

export interface ScanWorkflowEvent {
  payload: { scanId: string };
}

export interface ScanWorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface ScanWorkflowParams {
  scanId: string;
}

class ScanCancelledError extends Error {
  constructor() {
    super("scan was cancelled");
    this.name = "ScanCancelledError";
  }
}

function progressStatus(status: ScanStatus): number {
  return [
    "created",
    "uploading",
    "queued",
    "validating",
    "chunking",
    "extracting",
    "merging",
    "adjudicating",
    "reporting",
    "completed",
  ].indexOf(status);
}

function settlementUnits(status: ScanStatus): number {
  if (status !== "completed") return 0;
  // A completed scan consumes its size-based reservation. Failed, cancelled,
  // and deleted scans settle at zero and return the reservation.
  return -1;
}

async function advanceTo(
  repository: ScanRepository,
  scanId: string,
  nextStatus: ScanStatus,
): Promise<void> {
  const current = await repository.getScan(scanId);
  if (
    !current ||
    current.status === nextStatus ||
    isTerminalStatus(current.status)
  )
    return;
  if (progressStatus(current.status) > progressStatus(nextStatus)) return;
  if (canTransition(current.status, nextStatus)) {
    const transitioned = await repository.transitionScan(scanId, nextStatus);
    if (!transitioned || transitioned.status !== nextStatus) {
      // Another worker or the cancel endpoint won the CAS race. Re-read the
      // state before entering an expensive step; in particular, do not keep
      // calling an AI provider after cancellation has been requested.
      await ensureActive(repository, scanId);
      if ((await repository.getScan(scanId))?.status === nextStatus) return;
      throw new Error(
        `scan transition was superseded before ${nextStatus} could start`,
      );
    }
    return;
  }
  throw new Error(
    `scan cannot progress from ${current.status} to ${nextStatus}`,
  );
}

async function ensureActive(
  repository: ScanRepository,
  scanId: string,
): Promise<void> {
  const scan = await repository.getScan(scanId);
  if (!scan) throw new Error("scan session was not found");
  if (scan.status === "cancel_requested") {
    await repository.transitionScan(scanId, "cancelled");
    throw new ScanCancelledError();
  }
  if (scan.status === "cancelled" || scan.status === "deleted")
    throw new ScanCancelledError();
  if (
    scan.status === "completed" ||
    scan.status === "failed" ||
    scan.status === "expired"
  ) {
    throw new Error(`scan is already terminal: ${scan.status}`);
  }
}

export async function markTerminal(
  repository: ScanRepository,
  scanId: string,
  status: "failed" | "cancelled",
): Promise<void> {
  const scan = await repository.getScan(scanId);
  if (!scan) return;
  if (isTerminalStatus(scan.status)) {
    await repository.settleUsage(scanId, settlementUnits(scan.status));
    return;
  }

  // One SQL statement chooses cancelled when a cancel request has already won
  // the row race; a stale read can therefore never overwrite it with failed.
  const latest = await repository.markWorkflowTerminal(scanId, status);
  await repository.settleUsage(
    scanId,
    latest ? settlementUnits(latest.status) : 0,
  );
}

/** Durable Cloudflare Workflow for Quick and Full Scan processing. */
export class ScanWorkflow extends WorkflowEntrypoint<
  ScanEnv,
  ScanWorkflowParams
> {
  async run(
    event: WorkflowEvent<ScanWorkflowParams>,
    step: WorkflowStep,
  ): Promise<{ scanId: string; status: string }> {
    const scanId = event.payload?.scanId;
    if (typeof scanId !== "string" || !scanId)
      throw new Error("scanId is required");
    const repository = new ScanRepository(this.env.DB);
    try {
      const scan = await repository.getScan(scanId);
      if (!scan) throw new Error("scan session was not found");
      if (isTerminalStatus(scan.status)) {
        // A previous attempt may have transitioned the session to a terminal
        // state and then failed during settlement. Keep retrying settlement
        // instead of returning early and leaking the reservation.
        await step.do("settle-terminal", async () => {
          await repository.settleUsage(scanId, settlementUnits(scan.status));
          return { scanId, status: scan.status };
        });
        if (scan.status === "deleted") {
          await step.do("purge-deleted-terminal", async () => {
            const purge = await purgeDeletedScan(this.env, repository, scanId);
            return {
              scanId,
              deletedObjects: String(purge.deletedObjects),
              cleanupPending: String(purge.cleanupPending),
            };
          });
        }
        return { scanId, status: scan.status };
      }

      await step.do("load-job", async () => {
        await ensureActive(repository, scanId);
        await advanceTo(repository, scanId, "validating");
        await repository.updateJobStage(scanId, "load-job");
        return { scanId, status: "validating" };
      });

      await step.do("validate-source", async () => {
        await ensureActive(repository, scanId);
        const current = await repository.getScan(scanId);
        const upload = current
          ? await repository.getUploadIntent(current.uploadId)
          : null;
        if (!upload || upload.status !== "consumed")
          throw new Error("source upload is not ready");
        const source = await this.env.SCAN_BUCKET.head(upload.sourceKey);
        if (
          !source ||
          source.size !== upload.actualSize ||
          source.customMetadata?.sha256 !== upload.sourceHash
        ) {
          throw new Error("source artifact verification failed");
        }
        await repository.updateJobStage(scanId, "validate-source");
        return { scanId, sourceHash: upload.sourceHash ?? "" };
      });

      await step.do("normalize-document", async () => {
        await ensureActive(repository, scanId);
        const normalized = await normalizeScanSource(
          this.env,
          repository,
          scanId,
        );
        await repository.updateJobStage(scanId, "normalize-document");
        return { scanId, fingerprint: normalized.fingerprint };
      });

      await step.do("build-chunks", async () => {
        await ensureActive(repository, scanId);
        await advanceTo(repository, scanId, "chunking");
        const current = await repository.getScan(scanId);
        if (!current) throw new Error("scan session was not found");
        const chunks = await buildScanChunks(
          this.env,
          repository,
          scanId,
          current.mode,
        );
        await repository.updateJobStage(scanId, "build-chunks");
        return { scanId, count: String(chunks.count) };
      });

      await step.do("extract-chunks", async () => {
        await ensureActive(repository, scanId);
        await advanceTo(repository, scanId, "extracting");
        const extraction = await extractScanChunks(
          this.env,
          repository,
          scanId,
        );
        await repository.updateJobStage(scanId, "extract-chunks");
        return {
          scanId,
          count: String(extraction.count),
          fallbackCount: String(extraction.fallbackCount),
        };
      });

      await step.do("merge-extractions", async () => {
        await ensureActive(repository, scanId);
        await advanceTo(repository, scanId, "merging");
        const merged = await mergeScanExtractions(this.env, repository, scanId);
        await repository.updateJobStage(scanId, "merge-extractions");
        return {
          scanId,
          entityCount: String(merged.entityCount),
          eventCount: String(merged.eventCount),
        };
      });

      const current = await repository.getScan(scanId);
      if (!current) throw new Error("scan session was not found");
      if (current.mode === "full") {
        await step.do("adjudicate", async () => {
          await ensureActive(repository, scanId);
          await advanceTo(repository, scanId, "adjudicating");
          const adjudication = await adjudicateScan(
            this.env,
            repository,
            scanId,
          );
          await repository.updateJobStage(scanId, "adjudicate");
          return {
            scanId,
            uncertainCount: String(adjudication.uncertainCount),
          };
        });
      }

      await step.do("build-bundle", async () => {
        await ensureActive(repository, scanId);
        await advanceTo(repository, scanId, "reporting");
        const artifacts = await buildScanArtifacts(
          this.env,
          repository,
          scanId,
          current.mode,
        );
        await repository.updateJobStage(scanId, "build-bundle");
        return {
          scanId,
          bundleKey: artifacts.bundleKey,
          reportKey: artifacts.reportKey,
        };
      });

      await step.do("build-report", async () => {
        await ensureActive(repository, scanId);
        await repository.updateJobStage(scanId, "build-report");
        return { scanId, status: "reporting" };
      });

      await step.do("finalize", async () => {
        await ensureActive(repository, scanId);
        await repository.updateJobStage(scanId, "finalize");
        const latest = await repository.getScan(scanId);
        if (!latest) throw new Error("scan session was not found");
        if (canTransition(latest.status, "completed")) {
          const transitioned = await repository.transitionScan(
            scanId,
            "completed",
          );
          if (!transitioned || transitioned.status !== "completed") {
            await ensureActive(repository, scanId);
            throw new Error("scan finalization was superseded");
          }
        }
        const finalized = await repository.getScan(scanId);
        if (!finalized) throw new Error("scan session was not found");
        if (finalized.status !== "completed") {
          await ensureActive(repository, scanId);
          throw new Error("scan finalization did not reach completed");
        }
        await repository.settleUsage(scanId, settlementUnits(finalized.status));
        return { scanId, status: "completed" };
      });
      return { scanId, status: "completed" };
    } catch (cause) {
      const failedScan = await repository.getScan(scanId);
      const cancelled =
        cause instanceof ScanCancelledError ||
        cause instanceof ScanDeletedError ||
        isCancellationRequestedOrTerminal(failedScan?.status ?? null);
      await step.do(cancelled ? "mark-cancelled" : "mark-failed", async () => {
        await markTerminal(
          repository,
          scanId,
          cancelled ? "cancelled" : "failed",
        );
        return { scanId, status: cancelled ? "cancelled" : "failed" };
      });
      if ((await repository.getScan(scanId))?.status === "deleted") {
        await step.do("purge-deleted", async () => {
          const purge = await purgeDeletedScan(this.env, repository, scanId);
          return {
            scanId,
            deletedObjects: String(purge.deletedObjects),
            cleanupPending: String(purge.cleanupPending),
          };
        });
      }
      if (cancelled) return { scanId, status: "cancelled" };
      throw cause;
    }
  }
}
