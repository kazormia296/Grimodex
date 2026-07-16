import type {
  D1PreparedStatementLike,
  R2BucketLike,
  ScanEnv,
  WorkerExecutionContextLike,
} from "./env";
import { ScanRepository } from "./repository";
import { emitContentFreeObservation } from "./observability";
import { chunkD1Bindings } from "./d1Limits";
import {
  editorAiArtifactKey,
  InvalidEditorAiArtifactError,
  readEditorAiArtifact,
} from "./editorAiArtifact";

const EDITOR_AI_RESERVATION_TTL_MS = 30 * 60 * 1000;
const SCAN_WORKFLOW_START_TTL_MS = 15 * 60 * 1000;
const PUBLIC_REPORT_ARTIFACT_TTL_MS = 15 * 60 * 1000;
const CLEANUP_ROW_LIMIT = 20;
const R2_LIST_SUBREQUEST_LIMIT = 32;
const R2_DELETE_SUBREQUEST_LIMIT = 64;
const R2_CONCURRENCY = 4;
const D1_PROGRESS_BATCH_SIZE = 8;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

interface ArtifactCleanupRow {
  scan_id: string;
  object_key: string;
  artifact_kind: string;
}

export interface ScanPurgeResult {
  deletedObjects: number;
  cleanupPending: boolean;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        if (value !== undefined) await visit(value);
      }
    }),
  );
}

class R2CleanupLimiter {
  private remainingListSubrequests = R2_LIST_SUBREQUEST_LIMIT;
  private remainingDeleteSubrequests = R2_DELETE_SUBREQUEST_LIMIT;
  private readonly deleteResults = new Map<string, Promise<boolean>>();
  private readonly successfulDeletes = new Set<string>();

  constructor(private readonly bucket: R2BucketLike) {}

  async list(options: { prefix?: string; cursor?: string }): Promise<
    | {
        objects: Array<{ key: string }>;
        truncated?: boolean;
        cursor?: string;
      }
    | undefined
  > {
    if (!this.bucket.list || this.remainingListSubrequests <= 0) {
      return undefined;
    }
    this.remainingListSubrequests -= 1;
    return this.bucket.list(options);
  }

  delete(key: string): Promise<boolean> {
    const existing = this.deleteResults.get(key);
    if (existing) return existing;
    if (this.remainingDeleteSubrequests <= 0) return Promise.resolve(false);
    this.remainingDeleteSubrequests -= 1;
    const result = this.bucket
      .delete(key)
      .then(() => {
        this.successfulDeletes.add(key);
        return true;
      })
      .catch(() => false);
    this.deleteResults.set(key, result);
    return result;
  }

  wasDeleted(key: string): boolean {
    return this.successfulDeletes.has(key);
  }

  get deletedKeys(): ReadonlySet<string> {
    return this.successfulDeletes;
  }
}

async function deleteKeys(
  limiter: R2CleanupLimiter,
  keys: readonly string[],
): Promise<void> {
  await mapWithConcurrency(keys, R2_CONCURRENCY, async (key) => {
    await limiter.delete(key);
  });
}

async function runD1ProgressBatches(
  env: ScanEnv,
  statements: readonly D1PreparedStatementLike[],
): Promise<void> {
  for (
    let index = 0;
    index < statements.length;
    index += D1_PROGRESS_BATCH_SIZE
  ) {
    await env.DB.batch(statements.slice(index, index + D1_PROGRESS_BATCH_SIZE));
  }
}

/** Immediately revokes access and removes all known objects for a deleted scan. */
export async function purgeDeletedScan(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
  limiter = new R2CleanupLimiter(env.SCAN_BUCKET),
): Promise<ScanPurgeResult> {
  const scan = await repository.getScan(scanId);
  if (!scan) return { deletedObjects: 0, cleanupPending: false };
  const upload = await repository.getUploadIntent(scan.uploadId);
  const publicReport = await repository.getPublicReportByScanId(scanId);
  const listedArtifactRows = await repository.listScanArtifacts(
    scanId,
    CLEANUP_ROW_LIMIT + 1,
  );
  const artifactRows = listedArtifactRows.slice(0, CLEANUP_ROW_LIMIT);
  const keys = new Set<string>([
    ...(upload?.sourceKey ? [upload.sourceKey] : []),
    ...(scan.privateBundleKey ? [scan.privateBundleKey] : []),
    ...(scan.privateReportKey ? [scan.privateReportKey] : []),
    ...(publicReport ? [publicReport.artifactKey] : []),
    ...artifactRows.map((row) => row.objectKey),
  ]);
  let listComplete = listedArtifactRows.length <= CLEANUP_ROW_LIMIT;
  if (env.SCAN_BUCKET.list) {
    for (const prefix of [`artifacts/${scanId}/`, `public/${scanId}/`]) {
      let cursor: string | undefined;
      try {
        do {
          const page = await limiter.list({
            prefix,
            ...(cursor ? { cursor } : {}),
          });
          if (!page) {
            listComplete = false;
            break;
          }
          for (const object of page.objects) keys.add(object.key);
          if (page.truncated && !page.cursor) {
            listComplete = false;
            break;
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      } catch {
        listComplete = false;
      }
    }
  } else {
    listComplete = false;
  }

  const deletedCountBefore = limiter.deletedKeys.size;
  await deleteKeys(limiter, [...keys]);
  const deletedKeys = [...keys].filter((key) => limiter.wasDeleted(key));
  await repository.scrubDeletedScan(
    scanId,
    deletedKeys,
    listComplete && [...keys].every((key) => limiter.wasDeleted(key)),
  );
  return {
    deletedObjects: limiter.deletedKeys.size - deletedCountBefore,
    cleanupPending:
      !listComplete || [...keys].some((key) => !limiter.wasDeleted(key)),
  };
}

/** Removes expired blobs and scrubs private artifact pointers after retention. */
export async function runRetentionCleanup(
  env: ScanEnv,
  context?: WorkerExecutionContextLike,
  now = new Date(),
): Promise<{ deletedObjects: number; scrubbedScans: number }> {
  const nowIso = now.toISOString();
  const retentionCutoff = new Date(
    now.getTime() -
      positiveInt(env.SCAN_RETENTION_DAYS, 30) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const uploadCutoff = new Date(
    now.getTime() -
      positiveInt(env.SCAN_UPLOAD_RETENTION_MINUTES, 60) * 60 * 1000,
  ).toISOString();
  const sourceCutoff = new Date(
    now.getTime() -
      positiveInt(env.SCAN_SOURCE_RETENTION_DAYS, 1) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const staleEditorAiCutoff = new Date(
    now.getTime() - EDITOR_AI_RESERVATION_TTL_MS,
  ).toISOString();
  const staleQueuedScanCutoff = new Date(
    now.getTime() - SCAN_WORKFLOW_START_TTL_MS,
  ).toISOString();
  const stalePublicReportArtifactCutoff = new Date(
    now.getTime() - PUBLIC_REPORT_ARTIFACT_TTL_MS,
  ).toISOString();

  const repository = new ScanRepository(env.DB, () => nowIso);
  const r2Limiter = new R2CleanupLimiter(env.SCAN_BUCKET);
  const pendingDeletedScans = await env.DB.prepare(
    `SELECT id FROM scan_sessions
     WHERE status = 'deleted' AND cleanup_completed_at IS NULL
     ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(CLEANUP_ROW_LIMIT)
    .all<{ id: string }>();
  const completedDeletedScanIds = new Set<string>();
  for (const row of pendingDeletedScans.results.slice(0, CLEANUP_ROW_LIMIT)) {
    const purge = await purgeDeletedScan(env, repository, row.id, r2Limiter);
    if (!purge.cleanupPending) completedDeletedScanIds.add(row.id);
  }
  const staleQueuedScans = await env.DB.prepare(
    `SELECT id FROM scan_sessions
     WHERE status = 'queued' AND created_at <= ?
     ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(staleQueuedScanCutoff, CLEANUP_ROW_LIMIT)
    .all<{ id: string }>();
  for (const row of staleQueuedScans.results.slice(0, CLEANUP_ROW_LIMIT)) {
    if (await repository.claimStaleQueuedScan(row.id, staleQueuedScanCutoff)) {
      await repository.settleUsage(row.id, 0);
    }
  }
  const staleEditorAiOperations = await repository.listStaleReservedAiUsage(
    staleEditorAiCutoff,
    CLEANUP_ROW_LIMIT,
  );
  for (const operation of staleEditorAiOperations) {
    let status: "completed" | "failed" = "failed";
    let provider = operation.provider;
    let model = operation.model;
    try {
      const artifact = await readEditorAiArtifact(
        env.SCAN_BUCKET,
        editorAiArtifactKey(operation.scanId, operation.operationId),
      );
      if (
        artifact &&
        artifact.operationId === operation.operationId &&
        artifact.requestHash === operation.requestHash &&
        artifact.costWeight === operation.units
      ) {
        status = artifact.status;
        provider = artifact.provider;
        model = artifact.model;
      }
    } catch (cause) {
      if (!(cause instanceof InvalidEditorAiArtifactError)) {
        // A transient R2 read failure must not refund a completed operation.
        continue;
      }
    }
    await repository.finalizeAiUsageOperation({
      operationId: operation.operationId,
      provider,
      model,
      status,
      staleBefore: staleEditorAiCutoff,
    });
  }
  const pendingPublicReportArtifacts =
    await repository.listPendingPublicReportArtifacts(
      stalePublicReportArtifactCutoff,
      CLEANUP_ROW_LIMIT,
    );
  await mapWithConcurrency(
    pendingPublicReportArtifacts,
    R2_CONCURRENCY,
    async (artifact) => {
      if (
        !(await repository.claimPendingPublicReportArtifact(
          artifact.scanId,
          artifact.objectKey,
          stalePublicReportArtifactCutoff,
        ))
      ) {
        return;
      }
      if (!(await r2Limiter.delete(artifact.objectKey))) return;
      await repository.forgetPublicReportArtifact(
        artifact.scanId,
        artifact.objectKey,
      );
    },
  );

  const expiredArtifacts = await env.DB.prepare(
    `SELECT scan_id, object_key, artifact_kind FROM scan_artifacts
     WHERE expires_at IS NOT NULL AND expires_at <= ?
       AND artifact_kind != 'public-report'
     ORDER BY expires_at ASC, scan_id ASC, object_key ASC LIMIT ?`,
  )
    .bind(nowIso, CLEANUP_ROW_LIMIT)
    .all<ArtifactCleanupRow>();
  const oldArtifacts = await env.DB.prepare(
    `SELECT a.scan_id, a.object_key, a.artifact_kind
       FROM scan_artifacts a
       JOIN scan_sessions s ON s.id = a.scan_id
       WHERE s.updated_at <= ?
         AND s.status IN ('completed', 'cancelled', 'failed', 'expired', 'deleted')
         AND a.artifact_kind != 'public-report'
       ORDER BY s.updated_at ASC, a.scan_id ASC, a.object_key ASC LIMIT ?`,
  )
    .bind(retentionCutoff, CLEANUP_ROW_LIMIT)
    .all<ArtifactCleanupRow>();
  const expiredUploads = await env.DB.prepare(
    `SELECT id AS upload_id, source_key FROM upload_intents
       WHERE expires_at <= ? AND status IN ('issued', 'uploaded')
       ORDER BY expires_at ASC, id ASC LIMIT ?`,
  )
    .bind(uploadCutoff, CLEANUP_ROW_LIMIT)
    .all<{ upload_id: string; source_key: string }>();
  const oldScans = await env.DB.prepare(
    `SELECT s.id, s.upload_id, s.status, s.updated_at,
            s.private_bundle_key, s.private_report_key
            , p.id AS public_report_id, p.artifact_key AS public_artifact_key
       FROM scan_sessions s
       JOIN upload_intents u ON u.id = s.upload_id
       LEFT JOIN public_reports p ON p.scan_id = s.id
       WHERE s.updated_at <= ?
         AND s.status IN ('completed', 'cancelled', 'failed', 'expired')
       ORDER BY s.updated_at ASC, s.id ASC LIMIT ?`,
  )
    .bind(retentionCutoff, CLEANUP_ROW_LIMIT)
    .all<{
      id: string;
      upload_id: string;
      status: "completed" | "cancelled" | "failed" | "expired";
      updated_at: string;
      private_bundle_key: string | null;
      private_report_key: string | null;
      public_report_id: string | null;
      public_artifact_key: string | null;
    }>();
  const sourceExpiredScans = await env.DB.prepare(
    `SELECT s.upload_id, u.source_key
       FROM scan_sessions s
       JOIN upload_intents u ON u.id = s.upload_id
       WHERE u.created_at <= ?
         AND u.status != 'expired'
         AND s.status IN ('completed', 'cancelled', 'failed', 'expired', 'deleted')
       ORDER BY u.created_at ASC, s.id ASC LIMIT ?`,
  )
    .bind(sourceCutoff, CLEANUP_ROW_LIMIT)
    .all<{ upload_id: string; source_key: string }>();

  const expiredArtifactRows = expiredArtifacts.results.slice(
    0,
    CLEANUP_ROW_LIMIT,
  );
  const oldArtifactRows = oldArtifacts.results.slice(0, CLEANUP_ROW_LIMIT);
  const expiredUploadRows = expiredUploads.results.slice(0, CLEANUP_ROW_LIMIT);
  const selectedOldScanRows = oldScans.results.slice(0, CLEANUP_ROW_LIMIT);
  const oldScanRows: typeof selectedOldScanRows = [];
  for (const scan of selectedOldScanRows) {
    if (
      await repository.claimScanForRetention({
        scanId: scan.id,
        status: scan.status,
        updatedAt: scan.updated_at,
      })
    ) {
      oldScanRows.push(scan);
    }
  }
  const sourceExpiredScanRows = sourceExpiredScans.results.slice(
    0,
    CLEANUP_ROW_LIMIT,
  );
  const artifactRows = [...expiredArtifactRows, ...oldArtifactRows];
  const artifactKeysByScan = new Map<string, string[]>();
  const listedOldScans = new Set<string>();
  if (env.SCAN_BUCKET.list) {
    await mapWithConcurrency(oldScanRows, R2_CONCURRENCY, async (scan) => {
      const operationIds = await repository.listEditorAiOperationIds(
        scan.id,
        CLEANUP_ROW_LIMIT,
      );
      const keys = operationIds.map((operationId) =>
        editorAiArtifactKey(scan.id, operationId),
      );
      let complete = true;
      for (const prefix of [`artifacts/${scan.id}/`, `public/${scan.id}/`]) {
        let cursor: string | undefined;
        try {
          do {
            const page = await r2Limiter.list({
              prefix,
              ...(cursor ? { cursor } : {}),
            });
            if (!page) {
              complete = false;
              break;
            }
            keys.push(...page.objects.map((object) => object.key));
            if (page.truncated && !page.cursor) {
              complete = false;
              break;
            }
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
        } catch {
          complete = false;
        }
      }
      artifactKeysByScan.set(scan.id, keys);
      if (complete) listedOldScans.add(scan.id);
    });
  }
  const keys = new Set<string>([
    ...artifactRows.map((row) => row.object_key),
    ...expiredUploadRows.map((row) => row.source_key),
    ...sourceExpiredScanRows.map((row) => row.source_key),
    ...[...artifactKeysByScan.values()].flat(),
    ...oldScanRows.flatMap((row) =>
      [
        row.private_bundle_key,
        row.private_report_key,
        row.public_artifact_key,
      ].filter((key): key is string => Boolean(key)),
    ),
  ]);
  await deleteKeys(r2Limiter, [...keys]);
  const deletedKeys = r2Limiter.deletedKeys;

  const statements: D1PreparedStatementLike[] = [];
  if (deletedKeys.size > 0) {
    const deletedKeyList = [...deletedKeys];
    for (const keyChunk of chunkD1Bindings(deletedKeyList)) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM scan_artifacts WHERE object_key IN (${placeholders(keyChunk.length)})`,
        ).bind(...keyChunk),
      );
    }
  }
  const successfulScanIds = oldScanRows
    .map((row) => row.id)
    .filter((scanId) => {
      const rows = artifactRows.filter(
        (artifact) => artifact.scan_id === scanId,
      );
      const scan = oldScanRows.find((row) => row.id === scanId);
      const listedKeys = artifactKeysByScan.get(scanId) ?? [];
      const privateKeys = scan
        ? [
            scan.private_bundle_key,
            scan.private_report_key,
            scan.public_artifact_key,
          ].filter((key): key is string => Boolean(key))
        : [];
      return (
        listedOldScans.has(scanId) &&
        [
          ...rows.map((artifact) => artifact.object_key),
          ...listedKeys,
          ...privateKeys,
        ].every((key) => deletedKeys.has(key))
      );
    });
  if (successfulScanIds.length > 0) {
    for (const scanIdChunk of chunkD1Bindings(successfulScanIds, 2)) {
      statements.push(
        env.DB.prepare(
          `UPDATE scan_sessions
             SET private_bundle_key = NULL,
                 private_report_key = NULL,
                 status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'expired' END,
                 cleanup_completed_at = CASE WHEN status = 'deleted' THEN ? ELSE cleanup_completed_at END,
                 updated_at = ?
             WHERE id IN (${placeholders(scanIdChunk.length)})`,
        ).bind(nowIso, nowIso, ...scanIdChunk),
        env.DB.prepare(
          `DELETE FROM scan_chunks
             WHERE scan_id IN (${placeholders(scanIdChunk.length)})`,
        ).bind(...scanIdChunk),
        env.DB.prepare(
          `DELETE FROM scan_adjudication_results
             WHERE scan_id IN (${placeholders(scanIdChunk.length)})`,
        ).bind(...scanIdChunk),
        env.DB.prepare(
          `UPDATE public_reports SET status = 'unpublished', updated_at = ?
             WHERE scan_id IN (${placeholders(scanIdChunk.length)})`,
        ).bind(nowIso, ...scanIdChunk),
        env.DB.prepare(
          `DELETE FROM public_report_abuse_reports
             WHERE public_report_id IN (
               SELECT id FROM public_reports
               WHERE scan_id IN (${placeholders(scanIdChunk.length)})
             )`,
        ).bind(...scanIdChunk),
        env.DB.prepare(
          `DELETE FROM editor_tokens WHERE scan_id IN (${placeholders(scanIdChunk.length)})`,
        ).bind(...scanIdChunk),
        env.DB.prepare(
          `DELETE FROM public_report_artifacts WHERE scan_id IN (${placeholders(scanIdChunk.length)})`,
        ).bind(...scanIdChunk),
      );
    }
  }
  const successfulUploadIds = expiredUploadRows
    .filter((row) => deletedKeys.has(row.source_key))
    .map((row) => row.upload_id);
  const sourceExpiredUploadIds = sourceExpiredScanRows
    .filter((row) => deletedKeys.has(row.source_key))
    .map((row) => row.upload_id);
  const uploadIdsToExpire = [
    ...new Set([...successfulUploadIds, ...sourceExpiredUploadIds]),
  ];
  if (uploadIdsToExpire.length > 0) {
    for (const uploadIdChunk of chunkD1Bindings(uploadIdsToExpire, 1)) {
      statements.push(
        env.DB.prepare(
          `UPDATE upload_intents SET status = 'expired', updated_at = ?
             WHERE id IN (${placeholders(uploadIdChunk.length)})`,
        ).bind(nowIso, ...uploadIdChunk),
      );
    }
  }
  statements.push(
    env.DB.prepare(
      `DELETE FROM editor_tokens
       WHERE rowid IN (
         SELECT rowid FROM editor_tokens
         WHERE expires_at <= ? OR consumed_at <= ?
         ORDER BY expires_at ASC LIMIT ?
       )`,
    ).bind(nowIso, retentionCutoff, CLEANUP_ROW_LIMIT),
    env.DB.prepare(
      `DELETE FROM abuse_rate_limits
         WHERE rowid IN (
           SELECT rowid FROM abuse_rate_limits
           WHERE updated_at <= ?
           ORDER BY updated_at ASC LIMIT ?
         )`,
    ).bind(uploadCutoff, CLEANUP_ROW_LIMIT),
  );
  await runD1ProgressBatches(env, statements);

  const scrubbedScanIds = new Set([
    ...successfulScanIds,
    ...completedDeletedScanIds,
  ]);

  emitContentFreeObservation(context, {
    event: "retention_completed",
    durationMs: 0,
    code: `objects:${deletedKeys.size}`,
  });
  return {
    deletedObjects: deletedKeys.size,
    scrubbedScans: scrubbedScanIds.size,
  };
}
