import type { ScanEnv, WorkerExecutionContextLike } from "./env";
import type { ScanRepository } from "./repository";
import { emitContentFreeObservation } from "./observability";

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

/** Immediately revokes access and removes all known objects for a deleted scan. */
export async function purgeDeletedScan(
  env: ScanEnv,
  repository: ScanRepository,
  scanId: string,
): Promise<ScanPurgeResult> {
  const scan = await repository.getScan(scanId);
  if (!scan) return { deletedObjects: 0, cleanupPending: false };
  const upload = await repository.getUploadIntent(scan.uploadId);
  const publicReport = await repository.getPublicReportByScanId(scanId);
  const artifactRows = await repository.listScanArtifacts(scanId);
  const keys = new Set<string>([
    ...(upload?.sourceKey ? [upload.sourceKey] : []),
    ...(scan.privateBundleKey ? [scan.privateBundleKey] : []),
    ...(scan.privateReportKey ? [scan.privateReportKey] : []),
    ...(publicReport ? [publicReport.artifactKey] : []),
    ...artifactRows.map((row) => row.objectKey),
  ]);
  let listComplete = true;
  const listObjects = env.SCAN_BUCKET.list;
  if (listObjects) {
    let cursor: string | undefined;
    try {
      do {
        const page = await listObjects({
          prefix: `artifacts/${scanId}/`,
          ...(cursor ? { cursor } : {}),
        });
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
  } else {
    listComplete = false;
  }

  const deletedKeys = new Set<string>();
  await Promise.all(
    [...keys].map(async (key) => {
      try {
        await env.SCAN_BUCKET.delete(key);
        deletedKeys.add(key);
      } catch {
        // The scheduled retention pass retries keys that could not be removed.
      }
    }),
  );
  await repository.scrubDeletedScan(
    scanId,
    [...deletedKeys],
    listComplete &&
      [upload?.sourceKey, scan.privateBundleKey, scan.privateReportKey]
        .filter((key): key is string => Boolean(key))
        .every((key) => deletedKeys.has(key)),
  );
  return {
    deletedObjects: deletedKeys.size,
    cleanupPending: [...keys].some((key) => !deletedKeys.has(key)),
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

  const expiredArtifacts = await env.DB.prepare(
    "SELECT scan_id, object_key, artifact_kind FROM scan_artifacts WHERE expires_at IS NOT NULL AND expires_at <= ? AND artifact_kind != 'public-report'",
  )
    .bind(nowIso)
    .all<ArtifactCleanupRow>();
  const oldArtifacts = await env.DB.prepare(
    `SELECT a.scan_id, a.object_key, a.artifact_kind
       FROM scan_artifacts a
       JOIN scan_sessions s ON s.id = a.scan_id
       WHERE s.updated_at <= ?
         AND s.status IN ('completed', 'cancelled', 'failed', 'expired', 'deleted')
         AND a.artifact_kind != 'public-report'`,
  )
    .bind(retentionCutoff)
    .all<ArtifactCleanupRow>();
  const expiredUploads = await env.DB.prepare(
    `SELECT id AS upload_id, source_key FROM upload_intents
       WHERE expires_at <= ? AND status IN ('issued', 'uploaded', 'expired')`,
  )
    .bind(uploadCutoff)
    .all<{ upload_id: string; source_key: string }>();
  const oldScans = await env.DB.prepare(
    `SELECT s.id, s.upload_id, s.private_bundle_key, s.private_report_key
            , p.id AS public_report_id, p.artifact_key AS public_artifact_key
       FROM scan_sessions s
       JOIN upload_intents u ON u.id = s.upload_id
       LEFT JOIN public_reports p ON p.scan_id = s.id
       WHERE s.updated_at <= ?
         AND s.status IN ('completed', 'cancelled', 'failed', 'expired', 'deleted')`,
  )
    .bind(retentionCutoff)
    .all<{
      id: string;
      upload_id: string;
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
         AND s.status IN ('completed', 'cancelled', 'failed', 'expired', 'deleted')`,
  )
    .bind(sourceCutoff)
    .all<{ upload_id: string; source_key: string }>();

  const artifactRows = [...expiredArtifacts.results, ...oldArtifacts.results];
  const artifactKeysByScan = new Map<string, string[]>();
  const listedOldScans = new Set<string>();
  const listObjects = env.SCAN_BUCKET.list;
  if (listObjects) {
    await Promise.all(
      oldScans.results.map(async (scan) => {
        const keys: string[] = [];
        let cursor: string | undefined;
        let complete = true;
        try {
          do {
            const page = await listObjects({
              prefix: `artifacts/${scan.id}/`,
              ...(cursor ? { cursor } : {}),
            });
            keys.push(...page.objects.map((object) => object.key));
            if (page.truncated && !page.cursor) {
              complete = false;
              break;
            }
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
          if (complete) {
            artifactKeysByScan.set(scan.id, keys);
            listedOldScans.add(scan.id);
          }
        } catch {
          // Do not scrub D1 pointers when R2 listing is unavailable.
        }
      }),
    );
  }
  const keys = new Set<string>([
    ...artifactRows.map((row) => row.object_key),
    ...expiredUploads.results.map((row) => row.source_key),
    ...sourceExpiredScans.results.map((row) => row.source_key),
    ...[...artifactKeysByScan.values()].flat(),
    ...oldScans.results.flatMap((row) =>
      [
        row.private_bundle_key,
        row.private_report_key,
        row.public_artifact_key,
      ].filter((key): key is string => Boolean(key)),
    ),
  ]);
  const deletedKeys = new Set<string>();
  await Promise.all(
    [...keys].map(async (key) => {
      try {
        await env.SCAN_BUCKET.delete(key);
        deletedKeys.add(key);
      } catch {
        // Keep the D1 pointer so the next scheduled run can retry the object.
      }
    }),
  );

  const statements = [];
  if (deletedKeys.size > 0) {
    const deletedKeyList = [...deletedKeys];
    statements.push(
      env.DB.prepare(
        `DELETE FROM scan_artifacts WHERE object_key IN (${placeholders(deletedKeyList.length)})`,
      ).bind(...deletedKeyList),
    );
  }
  const successfulScanIds = oldScans.results
    .map((row) => row.id)
    .filter((scanId) => {
      const rows = artifactRows.filter(
        (artifact) => artifact.scan_id === scanId,
      );
      const scan = oldScans.results.find((row) => row.id === scanId);
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
    statements.push(
      env.DB.prepare(
        `UPDATE scan_sessions SET private_bundle_key = NULL, private_report_key = NULL, updated_at = ?
           WHERE id IN (${placeholders(successfulScanIds.length)})`,
      ).bind(nowIso, ...successfulScanIds),
      env.DB.prepare(
        `DELETE FROM scan_chunks
           WHERE scan_id IN (${placeholders(successfulScanIds.length)})`,
      ).bind(...successfulScanIds),
      env.DB.prepare(
        `UPDATE public_reports SET status = 'unpublished', updated_at = ?
           WHERE scan_id IN (${placeholders(successfulScanIds.length)})`,
      ).bind(nowIso, ...successfulScanIds),
      env.DB.prepare(
        `DELETE FROM public_report_abuse_reports
           WHERE public_report_id IN (
             SELECT id FROM public_reports
             WHERE scan_id IN (${placeholders(successfulScanIds.length)})
           )`,
      ).bind(...successfulScanIds),
      env.DB.prepare(
        `DELETE FROM editor_tokens WHERE scan_id IN (${placeholders(successfulScanIds.length)})`,
      ).bind(...successfulScanIds),
    );
  }
  const successfulUploadIds = expiredUploads.results
    .filter((row) => deletedKeys.has(row.source_key))
    .map((row) => row.upload_id);
  const sourceExpiredUploadIds = sourceExpiredScans.results
    .filter((row) => deletedKeys.has(row.source_key))
    .map((row) => row.upload_id);
  const uploadIdsToExpire = [
    ...new Set([...successfulUploadIds, ...sourceExpiredUploadIds]),
  ];
  if (uploadIdsToExpire.length > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE upload_intents SET status = 'expired', updated_at = ?
           WHERE id IN (${placeholders(uploadIdsToExpire.length)})`,
      ).bind(nowIso, ...uploadIdsToExpire),
    );
  }
  statements.push(
    env.DB.prepare(
      "DELETE FROM editor_tokens WHERE expires_at <= ? OR consumed_at <= ?",
    ).bind(nowIso, retentionCutoff),
    env.DB.prepare("DELETE FROM abuse_rate_limits WHERE updated_at <= ?").bind(
      uploadCutoff,
    ),
  );
  if (statements.length > 0) await env.DB.batch(statements);

  emitContentFreeObservation(context, {
    event: "retention_completed",
    durationMs: 0,
    code: `objects:${deletedKeys.size}`,
  });
  return {
    deletedObjects: deletedKeys.size,
    scrubbedScans: successfulScanIds.length,
  };
}
