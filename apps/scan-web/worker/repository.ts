import type { D1DatabaseLike } from "./env";
import { assertTransition, type ScanStatus } from "./stateMachine";

export type ScanMode = "quick" | "full";
export type ScanJobStage =
  | "load-job"
  | "validate-source"
  | "normalize-document"
  | "build-chunks"
  | "extract-chunks"
  | "merge-extractions"
  | "adjudicate"
  | "build-bundle"
  | "build-report"
  | "finalize";
export type ScanArtifactKind =
  | "bundle"
  | "private-report"
  | "public-report"
  | "source"
  | "chunk-input"
  | "chunk-extraction";

export interface UploadIntentRecord {
  id: string;
  tokenHash: string;
  filename: string;
  contentType: string;
  expectedSize: number;
  sourceKey: string;
  status: "issued" | "uploaded" | "consumed" | "expired";
  expiresAt: string;
  actualSize: number | null;
  sourceHash: string | null;
}

export interface ScanSessionRecord {
  id: string;
  uploadId: string;
  mode: ScanMode;
  status: ScanStatus;
  sourceHash: string | null;
  privateBundleKey: string | null;
  privateReportKey: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  accessTokenHash: string;
}

export interface EditorTokenRecord {
  scanId: string;
  artifactKey: string;
  expiresAt: string;
}

export interface PublicReportRecord {
  id: string;
  scanId: string;
  artifactKey: string;
  status: "draft" | "published" | "unpublished";
  authorConfirmedAt: string | null;
}

export interface ScanArtifactRecord {
  objectKey: string;
  kind: ScanArtifactKind;
}

export interface ScanChunkRecord {
  scanId: string;
  chunkHash: string;
  pipelineVersion: string;
  inputKey: string;
  extractionKey: string | null;
  extractionJson: string | null;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  updatedAt: string;
}

export interface PublicAbuseReportRecord {
  id: string;
  publicReportId: string;
  reason: string;
  createdAt: string;
}

interface UploadIntentRow {
  id: string;
  token_hash: string;
  filename: string;
  content_type: string;
  expected_size: number;
  source_key: string;
  status: UploadIntentRecord["status"];
  expires_at: string;
  actual_size: number | null;
  source_hash: string | null;
}

interface ScanSessionRow {
  id: string;
  upload_id: string;
  access_token_hash: string;
  mode: ScanMode;
  status: ScanStatus;
  source_hash: string | null;
  private_bundle_key: string | null;
  private_report_key: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EditorTokenRow {
  scan_id: string;
  artifact_key: string;
  expires_at: string;
}

interface PublicReportRow {
  id: string;
  scan_id: string;
  artifact_key: string;
  status: PublicReportRecord["status"];
  author_confirmed_at: string | null;
}

export class ScanRepository {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createUploadIntent(record: UploadIntentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO upload_intents
          (id, token_hash, filename, content_type, expected_size, source_key, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.tokenHash,
        record.filename,
        record.contentType,
        record.expectedSize,
        record.sourceKey,
        record.status,
        record.expiresAt,
        this.now(),
      )
      .run();
  }

  async reserveUsage(
    bucketKey: string,
    limitUnits: number,
    reservedUnits: number,
  ): Promise<boolean> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_buckets
          (bucket_key, reserved_units, actual_units, limit_units, updated_at)
         VALUES (?, 0, 0, ?, ?)`,
      )
      .bind(bucketKey, limitUnits, this.now())
      .run();
    const row = await this.db
      .prepare(
        `UPDATE usage_buckets
         SET reserved_units = reserved_units + ?, updated_at = ?
         WHERE bucket_key = ?
           AND reserved_units + actual_units + ? <= limit_units
         RETURNING bucket_key`,
      )
      .bind(reservedUnits, this.now(), bucketKey, reservedUnits)
      .first<{ bucket_key: string }>();
    return Boolean(row);
  }

  async releaseReservedUsage(
    bucketKey: string,
    reservedUnits: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE usage_buckets
         SET reserved_units = MAX(0, reserved_units - ?), updated_at = ?
         WHERE bucket_key = ?`,
      )
      .bind(reservedUnits, this.now(), bucketKey)
      .run();
  }

  async releaseReservedUsageBuckets(
    bucketKeys: readonly string[],
    reservedUnits: number,
  ): Promise<void> {
    if (bucketKeys.length === 0) return;
    await this.db.batch(
      bucketKeys.map((bucketKey) =>
        this.db
          .prepare(
            `UPDATE usage_buckets
             SET reserved_units = MAX(0, reserved_units - ?), updated_at = ?
             WHERE bucket_key = ?`,
          )
          .bind(reservedUnits, this.now(), bucketKey),
      ),
    );
  }

  async settleReservedUsage(bucketKey: string, units: number): Promise<void> {
    const boundedUnits = Math.max(0, Math.trunc(units));
    await this.db
      .prepare(
        `UPDATE usage_buckets
         SET reserved_units = MAX(0, reserved_units - ?), actual_units = actual_units + ?, updated_at = ?
         WHERE bucket_key = ?`,
      )
      .bind(boundedUnits, boundedUnits, this.now(), bucketKey)
      .run();
  }

  async settleReservedUsageBuckets(
    bucketKeys: readonly string[],
    units: number,
  ): Promise<void> {
    if (bucketKeys.length === 0) return;
    const boundedUnits = Math.max(0, Math.trunc(units));
    await this.db.batch(
      bucketKeys.map((bucketKey) =>
        this.db
          .prepare(
            `UPDATE usage_buckets
             SET reserved_units = MAX(0, reserved_units - ?), actual_units = actual_units + ?, updated_at = ?
             WHERE bucket_key = ?`,
          )
          .bind(boundedUnits, boundedUnits, this.now(), bucketKey),
      ),
    );
  }

  async consumeAbuseRateLimit(
    bucketKey: string,
    limit: number,
  ): Promise<boolean> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO abuse_rate_limits (bucket_key, attempts, updated_at)
         VALUES (?, 0, ?)`,
      )
      .bind(bucketKey, this.now())
      .run();
    const row = await this.db
      .prepare(
        `UPDATE abuse_rate_limits
         SET attempts = attempts + 1, updated_at = ?
         WHERE bucket_key = ? AND attempts < ?
         RETURNING bucket_key`,
      )
      .bind(this.now(), bucketKey, limit)
      .first<{ bucket_key: string }>();
    return Boolean(row);
  }

  async countActiveScans(): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM scan_sessions
         WHERE status IN ('created', 'uploading', 'queued', 'validating', 'chunking', 'extracting', 'merging', 'adjudicating', 'reporting', 'cancel_requested')`,
      )
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async updateJobStage(
    scanId: string,
    stage: ScanJobStage,
    errorCode: string | null = null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scan_jobs
         SET stage = ?,
             attempt = CASE WHEN stage = ? THEN attempt + 1 ELSE 1 END,
             last_error_code = ?,
             updated_at = ?
         WHERE scan_id = ?`,
      )
      .bind(stage, stage, errorCode, this.now(), scanId)
      .run();
  }

  async ensureScanChunks(
    scanId: string,
    chunks: readonly {
      chunkHash: string;
      pipelineVersion: string;
      inputKey: string;
    }[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    await this.db.batch(
      chunks.map((chunk) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO scan_chunks
              (scan_id, chunk_hash, pipeline_version, input_key, extraction_key, status, attempt, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, 'queued', 0, ?, ?)`,
          )
          .bind(
            scanId,
            chunk.chunkHash,
            chunk.pipelineVersion,
            chunk.inputKey,
            this.now(),
            this.now(),
          ),
      ),
    );
  }

  async getScanChunk(
    scanId: string,
    chunkHash: string,
    pipelineVersion: string,
  ): Promise<ScanChunkRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT scan_id, chunk_hash, pipeline_version, input_key, extraction_key,
                extraction_json, status, attempt, updated_at
         FROM scan_chunks
         WHERE scan_id = ? AND chunk_hash = ? AND pipeline_version = ?`,
      )
      .bind(scanId, chunkHash, pipelineVersion)
      .first<{
        scan_id: string;
        chunk_hash: string;
        pipeline_version: string;
        input_key: string;
        extraction_key: string | null;
        extraction_json: string | null;
        status: ScanChunkRecord["status"];
        attempt: number;
        updated_at: string;
      }>();
    return row
      ? {
          scanId: row.scan_id,
          chunkHash: row.chunk_hash,
          pipelineVersion: row.pipeline_version,
          inputKey: row.input_key,
          extractionKey: row.extraction_key,
          extractionJson: row.extraction_json,
          status: row.status,
          attempt: row.attempt,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async claimScanChunk(
    scanId: string,
    chunkHash: string,
    pipelineVersion: string,
    staleBefore: string,
  ): Promise<ScanChunkRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE scan_chunks
         SET status = 'running', attempt = attempt + 1, updated_at = ?
         WHERE scan_id = ? AND chunk_hash = ? AND pipeline_version = ?
           AND (status IN ('queued', 'failed') OR (status = 'running' AND updated_at <= ?)
                OR extraction_json IS NOT NULL)
             RETURNING scan_id, chunk_hash, pipeline_version, input_key, extraction_key,
                   extraction_json, status, attempt, updated_at`,
      )
      .bind(this.now(), scanId, chunkHash, pipelineVersion, staleBefore)
      .first<{
        scan_id: string;
        chunk_hash: string;
        pipeline_version: string;
        input_key: string;
        extraction_key: string | null;
        extraction_json: string | null;
        status: ScanChunkRecord["status"];
        attempt: number;
        updated_at: string;
      }>();
    return row
      ? {
          scanId: row.scan_id,
          chunkHash: row.chunk_hash,
          pipelineVersion: row.pipeline_version,
          inputKey: row.input_key,
          extractionKey: row.extraction_key,
          extractionJson: row.extraction_json,
          status: row.status,
          attempt: row.attempt,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async saveScanChunkResult(
    scanId: string,
    chunkHash: string,
    pipelineVersion: string,
    extractionJson: string,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE scan_chunks
         SET extraction_json = ?, updated_at = ?
         WHERE scan_id = ? AND chunk_hash = ? AND pipeline_version = ?
           AND status = 'running'`,
      )
      .bind(extractionJson, this.now(), scanId, chunkHash, pipelineVersion)
      .run();
    const changes = result.meta?.changes;
    if (
      result.success === false ||
      (changes !== undefined && Number(changes) !== 1)
    ) {
      throw new Error("scan chunk result was superseded");
    }
  }

  async completeScanChunk(
    scanId: string,
    chunkHash: string,
    pipelineVersion: string,
    extractionKey: string,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE scan_chunks
         SET status = 'completed', extraction_key = ?, updated_at = ?
         WHERE scan_id = ? AND chunk_hash = ? AND pipeline_version = ?
           AND status = 'running'`,
      )
      .bind(extractionKey, this.now(), scanId, chunkHash, pipelineVersion)
      .run();
    const changes = result.meta?.changes;
    if (
      result.success === false ||
      (changes !== undefined && Number(changes) !== 1)
    ) {
      throw new Error("scan chunk completion was superseded");
    }
  }

  async failScanChunk(
    scanId: string,
    chunkHash: string,
    pipelineVersion: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scan_chunks SET status = 'failed', updated_at = ?
         WHERE scan_id = ? AND chunk_hash = ? AND pipeline_version = ?
           AND status = 'running'`,
      )
      .bind(this.now(), scanId, chunkHash, pipelineVersion)
      .run();
  }

  async saveArtifact(input: {
    scanId: string;
    kind: ScanArtifactKind;
    objectKey: string;
    schemaVersion: string;
    sha256: string;
    contentType: string;
    expiresAt?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO scan_artifacts
          (scan_id, artifact_kind, object_key, schema_version, sha256, content_type, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scan_id, artifact_kind) DO UPDATE SET
           object_key = excluded.object_key,
           schema_version = excluded.schema_version,
           sha256 = excluded.sha256,
           content_type = excluded.content_type,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at`,
      )
      .bind(
        input.scanId,
        input.kind,
        input.objectKey,
        input.schemaVersion,
        input.sha256,
        input.contentType,
        input.expiresAt ?? null,
        this.now(),
      )
      .run();
  }

  async setPrivateArtifacts(
    scanId: string,
    input: { bundleKey?: string; reportKey?: string },
  ): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (input.bundleKey !== undefined) {
      fields.push("private_bundle_key = ?");
      values.push(input.bundleKey);
    }
    if (input.reportKey !== undefined) {
      fields.push("private_report_key = ?");
      values.push(input.reportKey);
    }
    if (fields.length === 0) return;
    values.push(this.now(), scanId);
    await this.db
      .prepare(
        `UPDATE scan_sessions SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
      )
      .bind(...values)
      .run();
  }

  async recordAiUsage(input: {
    operationId: string;
    scanId: string;
    provider: string;
    model: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimatedCostUsd?: number | null;
    status: "reserved" | "completed" | "failed" | "refunded";
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ai_usage_ledger
          (operation_id, scan_id, provider, model, input_tokens, output_tokens, estimated_cost_usd, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (operation_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           estimated_cost_usd = excluded.estimated_cost_usd,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.operationId,
        input.scanId,
        input.provider,
        input.model,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.estimatedCostUsd ?? null,
        input.status,
        this.now(),
        this.now(),
      )
      .run();
  }

  /** Settle the one-time reservation exactly once when a workflow reaches a terminal state. */
  async settleUsage(scanId: string, actualUnits: number): Promise<void> {
    const scan = await this.getScan(scanId);
    if (!scan) return;
    const job = await this.db
      .prepare(
        "SELECT reserved_units, actual_units FROM scan_jobs WHERE scan_id = ?",
      )
      .bind(scanId)
      .first<{ reserved_units: number; actual_units: number | null }>();
    if (!job || job.actual_units !== null) return;
    const requestedUnits = actualUnits < 0 ? job.reserved_units : actualUnits;
    const units = Math.min(
      job.reserved_units,
      Math.max(0, Math.trunc(requestedUnits)),
    );
    const bucketKeys = [
      `daily:${scan.createdAt.slice(0, 10)}`,
      `monthly:${scan.createdAt.slice(0, 7)}`,
    ];
    const now = this.now();
    const settlementId = crypto.randomUUID();
    // Both statements execute in one D1 transaction. The unique settlement
    // marker makes the second invocation a no-op even when two workflow
    // finalizers race after reading the same unsettled job.
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE scan_jobs
           SET actual_units = ?, settlement_id = ?, updated_at = ?
           WHERE scan_id = ? AND actual_units IS NULL`,
        )
        .bind(units, settlementId, now, scanId),
      ...bucketKeys.map((bucketKey) =>
        this.db
          .prepare(
            `UPDATE usage_buckets
             SET reserved_units = MAX(0, reserved_units - ?), actual_units = actual_units + ?, updated_at = ?
             WHERE bucket_key = ?
               AND EXISTS (
                 SELECT 1 FROM scan_jobs
                 WHERE scan_id = ? AND settlement_id = ?
               )`,
          )
          .bind(
            job.reserved_units,
            units,
            now,
            bucketKey,
            scanId,
            settlementId,
          ),
      ),
    ]);
  }

  async getUploadIntent(id: string): Promise<UploadIntentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, token_hash, filename, content_type, expected_size, source_key, status, expires_at,
                actual_size, source_hash
         FROM upload_intents WHERE id = ?`,
      )
      .bind(id)
      .first<UploadIntentRow>();
    return row ? this.uploadFromRow(row) : null;
  }

  async authorizeUpload(
    id: string,
    tokenHash: string,
  ): Promise<UploadIntentRecord | null> {
    const claimed = await this.db
      .prepare(
        `UPDATE upload_intents
         SET status = 'uploaded', updated_at = ?
         WHERE id = ? AND token_hash = ? AND status = 'issued' AND expires_at > ?
         RETURNING id`,
      )
      .bind(this.now(), id, tokenHash, this.now())
      .first<{ id: string }>();
    return claimed ? this.getUploadIntent(claimed.id) : null;
  }

  async markUploadComplete(
    id: string,
    size: number,
    sourceHash: string,
  ): Promise<void> {
    const row = await this.db
      .prepare(
        `UPDATE upload_intents
         SET status = 'uploaded', actual_size = ?, source_hash = ?, updated_at = ?
         WHERE id = ? AND status = 'uploaded' AND actual_size IS NULL AND expected_size = ?
         RETURNING id`,
      )
      .bind(size, sourceHash, this.now(), id, size)
      .first<{ id: string }>();
    if (!row) throw new Error("upload intent is no longer writable");
  }

  async releaseUploadClaim(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE upload_intents
         SET status = 'issued', updated_at = ?
         WHERE id = ? AND status = 'uploaded' AND actual_size IS NULL`,
      )
      .bind(this.now(), id)
      .run();
  }

  async createScan(input: {
    id: string;
    uploadId: string;
    mode: ScanMode;
    reservedUnits: number;
    accessTokenHash: string;
    maxActiveJobs?: number | null;
  }): Promise<boolean> {
    const now = this.now();
    const consumed = await this.db
      .prepare(
        `UPDATE upload_intents
         SET status = 'consumed', updated_at = ?
         WHERE id = ? AND status = 'uploaded' AND actual_size IS NOT NULL
           AND source_hash IS NOT NULL AND expires_at > ?
         RETURNING source_hash`,
      )
      .bind(now, input.uploadId, now)
      .first<{ source_hash: string | null }>();
    if (!consumed) throw new Error("upload is not ready for scan creation");
    try {
      const sessionInsert =
        input.maxActiveJobs === null || input.maxActiveJobs === undefined
          ? this.db
              .prepare(
                `INSERT INTO scan_sessions
                (id, upload_id, access_token_hash, mode, status, source_hash, private_bundle_key, private_report_key,
                 cancel_requested_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, ?, ?)`,
              )
              .bind(
                input.id,
                input.uploadId,
                input.accessTokenHash,
                input.mode,
                consumed.source_hash,
                now,
                now,
              )
          : this.db
              .prepare(
                `INSERT INTO scan_sessions
                (id, upload_id, access_token_hash, mode, status, source_hash, private_bundle_key, private_report_key,
                 cancel_requested_at, created_at, updated_at)
               SELECT ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, ?, ?
               WHERE (
                 SELECT COUNT(*) FROM scan_sessions
                 WHERE status IN ('created', 'uploading', 'queued', 'validating', 'chunking',
                   'extracting', 'merging', 'adjudicating', 'reporting', 'cancel_requested')
               ) < ?`,
              )
              .bind(
                input.id,
                input.uploadId,
                input.accessTokenHash,
                input.mode,
                consumed.source_hash,
                now,
                now,
                input.maxActiveJobs,
              );
      const jobInsert = this.db
        .prepare(
          `INSERT INTO scan_jobs (scan_id, stage, attempt, reserved_units, created_at, updated_at)
           SELECT ?, 'load-job', 0, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM scan_sessions WHERE id = ?)`,
        )
        .bind(input.id, input.reservedUnits, now, now, input.id);
      await this.db.batch([sessionInsert, jobInsert]);
      if (!(await this.getScan(input.id))) {
        await this.db
          .prepare(
            "UPDATE upload_intents SET status = 'uploaded', updated_at = ? WHERE id = ? AND status = 'consumed'",
          )
          .bind(this.now(), input.uploadId)
          .run();
        return false;
      }
      return true;
    } catch (error) {
      // If session/job insertion failed before a scan became visible, return the
      // upload to uploaded so the client can retry without minting a new token.
      await this.db
        .prepare(
          "UPDATE upload_intents SET status = 'uploaded', updated_at = ? WHERE id = ? AND status = 'consumed'",
        )
        .bind(this.now(), input.uploadId)
        .run();
      throw error;
    }
  }

  async getScan(id: string): Promise<ScanSessionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, upload_id, access_token_hash, mode, status, source_hash, private_bundle_key, private_report_key,
                cancel_requested_at, created_at, updated_at
         FROM scan_sessions WHERE id = ?`,
      )
      .bind(id)
      .first<ScanSessionRow>();
    return row ? this.scanFromRow(row) : null;
  }

  async listScanArtifacts(scanId: string): Promise<ScanArtifactRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT object_key, artifact_kind FROM scan_artifacts WHERE scan_id = ?",
      )
      .bind(scanId)
      .all<{ object_key: string; artifact_kind: ScanArtifactKind }>();
    return rows.results.map((row) => ({
      objectKey: row.object_key,
      kind: row.artifact_kind,
    }));
  }

  async scrubDeletedScan(
    scanId: string,
    deletedKeys: readonly string[],
    allPrivateKeysDeleted: boolean,
  ): Promise<void> {
    const statements = [
      this.db.prepare("DELETE FROM scan_chunks WHERE scan_id = ?").bind(scanId),
      this.db
        .prepare("DELETE FROM editor_tokens WHERE scan_id = ?")
        .bind(scanId),
      this.db
        .prepare(
          "UPDATE public_reports SET status = 'unpublished', updated_at = ? WHERE scan_id = ?",
        )
        .bind(this.now(), scanId),
    ];
    if (deletedKeys.length > 0) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM scan_artifacts WHERE scan_id = ? AND object_key IN (${deletedKeys
              .map(() => "?")
              .join(", ")})`,
          )
          .bind(scanId, ...deletedKeys),
      );
    }
    if (allPrivateKeysDeleted) {
      statements.push(
        this.db
          .prepare(
            "UPDATE scan_sessions SET private_bundle_key = NULL, private_report_key = NULL, updated_at = ? WHERE id = ?",
          )
          .bind(this.now(), scanId),
      );
    }
    await this.db.batch(statements);
  }

  async authorizeScan(
    id: string,
    accessTokenHash: string,
  ): Promise<ScanSessionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, upload_id, access_token_hash, mode, status, source_hash, private_bundle_key, private_report_key,
                cancel_requested_at, created_at, updated_at
         FROM scan_sessions WHERE id = ? AND access_token_hash = ?`,
      )
      .bind(id, accessTokenHash)
      .first<ScanSessionRow>();
    return row ? this.scanFromRow(row) : null;
  }

  async transitionScan(
    id: string,
    nextStatus: ScanStatus,
  ): Promise<ScanSessionRecord | null> {
    const current = await this.getScan(id);
    if (!current) return null;
    assertTransition(current.status, nextStatus);
    const updatedAt = this.now();
    const result = await this.db
      .prepare(
        `UPDATE scan_sessions SET status = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(nextStatus, updatedAt, id, current.status)
      .run();
    const changes = result.meta?.changes;
    if (
      result.success === false ||
      (changes !== undefined && Number(changes) !== 1)
    ) {
      return this.getScan(id);
    }
    return { ...current, status: nextStatus, updatedAt };
  }

  async requestCancel(id: string): Promise<ScanSessionRecord | null> {
    const current = await this.getScan(id);
    if (!current) return null;
    if (
      current.status === "completed" ||
      current.status === "cancelled" ||
      current.status === "deleted"
    ) {
      return current;
    }
    assertTransition(current.status, "cancel_requested");
    const updatedAt = this.now();
    const result = await this.db
      .prepare(
        `UPDATE scan_sessions SET status = 'cancel_requested', cancel_requested_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(updatedAt, updatedAt, id, current.status)
      .run();
    const changes = result.meta?.changes;
    if (
      result.success === false ||
      (changes !== undefined && Number(changes) !== 1)
    ) {
      return this.getScan(id);
    }
    return {
      ...current,
      status: "cancel_requested",
      cancelRequestedAt: updatedAt,
      updatedAt,
    };
  }

  async deleteScan(id: string): Promise<ScanSessionRecord | null> {
    const current = await this.getScan(id);
    if (!current || current.status === "deleted") return current;
    assertTransition(current.status, "deleted");
    const updatedAt = this.now();
    const result = await this.db
      .prepare(
        "UPDATE scan_sessions SET status = 'deleted', updated_at = ? WHERE id = ? AND status = ?",
      )
      .bind(updatedAt, id, current.status)
      .run();
    const changes = result.meta?.changes;
    if (
      result.success === false ||
      (changes !== undefined && Number(changes) !== 1)
    ) {
      return this.getScan(id);
    }
    return { ...current, status: "deleted", updatedAt };
  }

  async createEditorToken(record: {
    tokenHash: string;
    scanId: string;
    artifactKey: string;
    expiresAt: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO editor_tokens (token_hash, scan_id, artifact_key, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        record.tokenHash,
        record.scanId,
        record.artifactKey,
        record.expiresAt,
        this.now(),
      )
      .run();
  }

  async consumeEditorToken(
    tokenHash: string,
  ): Promise<EditorTokenRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE editor_tokens SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM scan_sessions
             WHERE scan_sessions.id = editor_tokens.scan_id
               AND scan_sessions.status NOT IN ('expired', 'deleted')
           )
         RETURNING scan_id, artifact_key, expires_at`,
      )
      .bind(this.now(), tokenHash, this.now())
      .first<EditorTokenRow>();
    return row
      ? {
          scanId: row.scan_id,
          artifactKey: row.artifact_key,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async getEditorToken(tokenHash: string): Promise<EditorTokenRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT scan_id, artifact_key, expires_at
         FROM editor_tokens
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM scan_sessions
             WHERE scan_sessions.id = editor_tokens.scan_id
               AND scan_sessions.status NOT IN ('expired', 'deleted')
           )`,
      )
      .bind(tokenHash, this.now())
      .first<EditorTokenRow>();
    return row
      ? {
          scanId: row.scan_id,
          artifactKey: row.artifact_key,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async saveFindingFeedback(input: {
    scanId: string;
    findingId: string;
    status: "intentional" | "rejected";
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO finding_feedback (id, scan_id, finding_id, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scan_id, finding_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`,
      )
      .bind(
        crypto.randomUUID(),
        input.scanId,
        input.findingId,
        input.status,
        this.now(),
      )
      .run();
  }

  async getFindingFeedback(
    scanId: string,
  ): Promise<Map<string, "intentional" | "rejected">> {
    const rows = await this.db
      .prepare(
        "SELECT finding_id, status FROM finding_feedback WHERE scan_id = ?",
      )
      .bind(scanId)
      .all<{
        finding_id: string;
        status: "intentional" | "rejected";
      }>();
    return new Map(rows.results.map((row) => [row.finding_id, row.status]));
  }

  async getPublicReportById(id: string): Promise<PublicReportRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, scan_id, artifact_key, status, author_confirmed_at FROM public_reports WHERE id = ?",
      )
      .bind(id)
      .first<PublicReportRow>();
    return row ? this.publicReportFromRow(row) : null;
  }

  async getPublicReportByScanId(
    scanId: string,
  ): Promise<PublicReportRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, scan_id, artifact_key, status, author_confirmed_at FROM public_reports WHERE scan_id = ?",
      )
      .bind(scanId)
      .first<PublicReportRow>();
    return row ? this.publicReportFromRow(row) : null;
  }

  async publishPublicReport(input: {
    id: string;
    scanId: string;
    artifactKey: string;
    authorConfirmedAt: string;
  }): Promise<PublicReportRecord | null> {
    const existing = await this.db
      .prepare(
        "SELECT id, scan_id, artifact_key, status, author_confirmed_at FROM public_reports WHERE scan_id = ?",
      )
      .bind(input.scanId)
      .first<PublicReportRow>();
    const updatedAt = this.now();
    if (existing) {
      const result = await this.db
        .prepare(
          `UPDATE public_reports
           SET artifact_key = ?, status = 'published', author_confirmed_at = ?, updated_at = ?
           WHERE scan_id = ?
             AND EXISTS (
               SELECT 1 FROM scan_sessions
               WHERE scan_sessions.id = public_reports.scan_id
                 AND scan_sessions.status = 'completed'
             )`,
        )
        .bind(
          input.artifactKey,
          input.authorConfirmedAt,
          updatedAt,
          input.scanId,
        )
        .run();
      const changes = result.meta?.changes;
      if (
        result.success === false ||
        (changes !== undefined && Number(changes) !== 1)
      ) {
        return null;
      }
      return this.getPublicReportByScanId(input.scanId);
    }
    const result = await this.db
      .prepare(
        `INSERT INTO public_reports (id, scan_id, artifact_key, status, author_confirmed_at, created_at, updated_at)
         SELECT ?, ?, ?, 'published', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM scan_sessions
           WHERE scan_sessions.id = ?
             AND scan_sessions.status = 'completed'
         )`,
      )
      .bind(
        input.id,
        input.scanId,
        input.artifactKey,
        input.authorConfirmedAt,
        updatedAt,
        updatedAt,
        input.scanId,
      )
      .run();
    const changes = result.meta?.changes;
    if (
      result.success === false ||
      (changes !== undefined && Number(changes) !== 1)
    ) {
      return null;
    }
    return this.getPublicReportByScanId(input.scanId);
  }

  async unpublishPublicReport(scanId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE public_reports SET status = 'unpublished', updated_at = ? WHERE scan_id = ?",
      )
      .bind(this.now(), scanId)
      .run();
  }

  async unpublishPublicReportById(
    id: string,
  ): Promise<PublicReportRecord | null> {
    const existing = await this.getPublicReportById(id);
    if (!existing) return null;
    await this.db
      .prepare(
        "UPDATE public_reports SET status = 'unpublished', updated_at = ? WHERE id = ?",
      )
      .bind(this.now(), id)
      .run();
    return { ...existing, status: "unpublished" };
  }

  async createPublicAbuseReport(input: {
    id: string;
    publicReportId: string;
    reason: string;
  }): Promise<PublicAbuseReportRecord> {
    const createdAt = this.now();
    await this.db
      .prepare(
        `INSERT INTO public_report_abuse_reports (id, public_report_id, reason, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.id, input.publicReportId, input.reason, createdAt)
      .run();
    return {
      id: input.id,
      publicReportId: input.publicReportId,
      reason: input.reason,
      createdAt,
    };
  }

  private uploadFromRow(row: UploadIntentRow): UploadIntentRecord {
    return {
      id: row.id,
      tokenHash: row.token_hash,
      filename: row.filename,
      contentType: row.content_type,
      expectedSize: row.expected_size,
      sourceKey: row.source_key,
      status: row.status,
      expiresAt: row.expires_at,
      actualSize: row.actual_size,
      sourceHash: row.source_hash,
    };
  }

  private scanFromRow(row: ScanSessionRow): ScanSessionRecord {
    return {
      id: row.id,
      uploadId: row.upload_id,
      accessTokenHash: row.access_token_hash,
      mode: row.mode,
      status: row.status,
      sourceHash: row.source_hash,
      privateBundleKey: row.private_bundle_key,
      privateReportKey: row.private_report_key,
      cancelRequestedAt: row.cancel_requested_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private publicReportFromRow(row: PublicReportRow): PublicReportRecord {
    return {
      id: row.id,
      scanId: row.scan_id,
      artifactKey: row.artifact_key,
      status: row.status,
      authorConfirmedAt: row.author_confirmed_at,
    };
  }
}
