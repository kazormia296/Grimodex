import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./env";
import { ScanRepository } from "./repository";

const SCAN_AI_CONSENT = {
  consentId: `consent_${"a".repeat(64)}`,
  policyVersion: "2026-07-19.4",
  provider: "workers-ai",
  route: "scan" as const,
};

describe("scan repository", () => {
  it("returns existing only when every client-owned scan handle field matches", async () => {
    const db = {
      prepare: () => {
        throw new Error("an exact retry must not write to D1");
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);
    vi.spyOn(repository, "getScan").mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      uploadId: "upload-1",
      mode: "quick",
      status: "queued",
      sourceHash: "source-hash",
      privateBundleKey: null,
      privateReportKey: null,
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
      aiConsent: SCAN_AI_CONSENT,
    });
    const input = {
      id: "11111111-1111-4111-8111-111111111111",
      uploadId: "upload-1",
      mode: "quick" as const,
      reservedUnits: 1,
      accessTokenHash: "scan-token-hash",
      aiConsent: SCAN_AI_CONSENT,
      buckets: [],
    };

    await expect(repository.createScan(input)).resolves.toBe("existing");

    for (const mismatch of [
      { ...input, uploadId: "upload-2" },
      { ...input, mode: "full" as const },
      { ...input, accessTokenHash: "other-token-hash" },
    ]) {
      await expect(repository.createScan(mismatch)).resolves.toBe("conflict");
    }
  });

  it.each([
    ["existing", "scan-token-hash"],
    ["conflict", "another-token-hash"],
  ] as const)(
    "recovers an ambiguous create commit as %s after exact comparison",
    async (expected, persistedTokenHash) => {
      const db = {
        prepare() {
          let statement: D1PreparedStatementLike;
          statement = {
            bind: () => statement,
            first: async <T>() => null as T | null,
            all: async <T>() => ({ results: [] as T[] }),
            run: async () => ({ success: true }),
          };
          return statement;
        },
        batch: async () => {
          throw new Error("D1 committed but its response was lost");
        },
      } satisfies D1DatabaseLike;
      const repository = new ScanRepository(db);
      vi.spyOn(repository, "getScan")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "11111111-1111-4111-8111-111111111111",
          uploadId: "upload-1",
          mode: "quick",
          status: "queued",
          sourceHash: "source-hash",
          privateBundleKey: null,
          privateReportKey: null,
          cancelRequestedAt: null,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          accessTokenHash: persistedTokenHash,
          aiConsent: SCAN_AI_CONSENT,
        });

      await expect(
        repository.createScan({
          id: "11111111-1111-4111-8111-111111111111",
          uploadId: "upload-1",
          mode: "quick",
          reservedUnits: 1,
          accessTokenHash: "scan-token-hash",
          aiConsent: SCAN_AI_CONSENT,
          buckets: [],
        }),
      ).resolves.toBe(expected);
    },
  );

  it("persists the server-derived AI consent identity with an upload intent", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const recorded = { query, values: [] as unknown[] };
        prepared.push(recorded);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            recorded.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-19T00:00:00.000Z");

    await repository.createUploadIntent({
      id: "upload-consent",
      tokenHash: "token-hash",
      filename: "novel.txt",
      contentType: "text/plain",
      expectedSize: 12,
      sourceKey: "incoming/upload-consent/source.txt",
      status: "issued",
      expiresAt: "2026-07-19T00:15:00.000Z",
      actualSize: null,
      sourceHash: null,
      aiConsent: SCAN_AI_CONSENT,
    });

    expect(prepared[0]?.query).toContain("ai_consent_id");
    expect(prepared[0]?.query).toContain("ai_consent_policy_version");
    expect(prepared[0]?.query).toContain("ai_consent_provider");
    expect(prepared[0]?.query).toContain("ai_consent_route");
    expect(prepared[0]?.values).toEqual(
      expect.arrayContaining([
        SCAN_AI_CONSENT.consentId,
        SCAN_AI_CONSENT.policyVersion,
        SCAN_AI_CONSENT.provider,
        SCAN_AI_CONSENT.route,
      ]),
    );
  });

  it("copies the upload AI consent identity into the queued scan atomically", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const recorded = { query, values: [] as unknown[] };
        prepared.push(recorded);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            recorded.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);
    const persisted = {
      id: "11111111-1111-4111-8111-111111111111",
      uploadId: "upload-consent",
      mode: "quick" as const,
      status: "queued" as const,
      sourceHash: "source-hash",
      privateBundleKey: null,
      privateReportKey: null,
      cancelRequestedAt: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
      aiConsent: SCAN_AI_CONSENT,
    };
    vi.spyOn(repository, "getScan")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persisted);

    await expect(
      repository.createScan({
        id: persisted.id,
        uploadId: persisted.uploadId,
        mode: persisted.mode,
        reservedUnits: 1,
        accessTokenHash: persisted.accessTokenHash,
        buckets: [],
        aiConsent: SCAN_AI_CONSENT,
      }),
    ).resolves.toBe("created");

    const insert = prepared.find((statement) =>
      statement.query.includes("INSERT INTO scan_sessions"),
    );
    expect(insert?.query).toContain("ai_consent_id");
    expect(insert?.query).toContain("u.ai_consent_id");
    expect(insert?.query).toContain("u.ai_consent_policy_version");
    expect(insert?.query).toContain("u.ai_consent_provider");
    expect(insert?.query).toContain("u.ai_consent_route");
  });

  it("fences stale chunk owners from saving, completing, or failing a newer claim", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    const state = {
      status: "queued" as "queued" | "running" | "completed" | "failed",
      attempt: 0,
      extractionJson: null as string | null,
      extractionKey: null as string | null,
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const row = () => ({
      scan_id: "scan-1",
      chunk_hash: "chunk-1",
      pipeline_version: "pipeline-1",
      input_key: "artifacts/scan-1/chunks.json",
      extraction_key: state.extractionKey,
      extraction_json: state.extractionJson,
      status: state.status,
      attempt: state.attempt,
      updated_at: state.updatedAt,
    });
    const db = {
      prepare(query: string) {
        const statement: RecordedStatement = {
          query,
          values: [],
          bind: (...values: unknown[]) => {
            statement.values = values;
            return statement;
          },
          first: async <T>() => {
            if (!query.includes("SET status = 'running'")) return null;
            state.status = "running";
            state.attempt += 1;
            state.updatedAt = String(statement.values[0]);
            return row() as T;
          },
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => {
            if (!query.includes("UPDATE scan_chunks"))
              return { success: true, meta: { changes: 0 } };
            const expectedAttempt = Number(
              statement.values[query.includes("SET status = 'failed'") ? 4 : 5],
            );
            if (
              state.status !== "running" ||
              state.attempt !== expectedAttempt
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            if (query.includes("SET extraction_json")) {
              state.extractionJson = String(statement.values[0]);
            } else if (query.includes("SET status = 'completed'")) {
              state.status = "completed";
              state.extractionKey = String(statement.values[0]);
            } else if (query.includes("SET status = 'failed'")) {
              state.status = "failed";
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    let tick = 0;
    const repository = new ScanRepository(
      db,
      () => `2026-07-16T00:00:0${tick++}.000Z`,
    );

    const first = await repository.claimScanChunk(
      "scan-1",
      "chunk-1",
      "pipeline-1",
      "2026-07-15T23:55:00.000Z",
    );
    const second = await repository.claimScanChunk(
      "scan-1",
      "chunk-1",
      "pipeline-1",
      "2026-07-16T00:05:00.000Z",
    );
    expect(first?.attempt).toBe(1);
    expect(second?.attempt).toBe(2);

    await expect(
      repository.saveScanChunkResult(
        "scan-1",
        "chunk-1",
        "pipeline-1",
        first!.attempt,
        '{"owner":"stale"}',
      ),
    ).rejects.toThrow("superseded");
    await repository.saveScanChunkResult(
      "scan-1",
      "chunk-1",
      "pipeline-1",
      second!.attempt,
      '{"owner":"current"}',
    );
    await expect(
      repository.completeScanChunk(
        "scan-1",
        "chunk-1",
        "pipeline-1",
        first!.attempt,
        "artifacts/stale.json",
      ),
    ).rejects.toThrow("superseded");
    await expect(
      repository.failScanChunk(
        "scan-1",
        "chunk-1",
        "pipeline-1",
        first!.attempt,
      ),
    ).resolves.toBe(false);
    expect(state).toMatchObject({
      status: "running",
      attempt: 2,
      extractionJson: '{"owner":"current"}',
    });

    await repository.completeScanChunk(
      "scan-1",
      "chunk-1",
      "pipeline-1",
      second!.attempt,
      "artifacts/current.json",
    );
    expect(state).toMatchObject({
      status: "completed",
      extractionKey: "artifacts/current.json",
    });
  });

  it("keeps the first durable adjudication result as the retry authority", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    let stored:
      | {
          scan_id: string;
          ambiguity_id: string;
          result_json: string;
          updated_at: string;
        }
      | undefined;
    const prepared: RecordedStatement[] = [];
    const db = {
      prepare(query: string) {
        const statement: RecordedStatement = {
          query,
          values: [],
          bind: (...values: unknown[]) => {
            statement.values = values;
            return statement;
          },
          first: async <T>() =>
            query.includes("FROM scan_adjudication_results")
              ? ((stored as T | undefined) ?? null)
              : null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => {
            if (
              query.includes("INSERT INTO scan_adjudication_results") &&
              !stored
            ) {
              stored = {
                scan_id: String(statement.values[0]),
                ambiguity_id: String(statement.values[1]),
                result_json: String(statement.values[2]),
                updated_at: String(statement.values[4]),
              };
            }
            return { success: true };
          },
        };
        prepared.push(statement);
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-16T00:00:00.000Z");

    const first = await repository.saveAdjudicationResult(
      "scan-1",
      "ambiguity-1",
      '{"decision":"merge"}',
    );
    const retry = await repository.saveAdjudicationResult(
      "scan-1",
      "ambiguity-1",
      '{"decision":"keep-separate"}',
    );

    expect(first.resultJson).toBe('{"decision":"merge"}');
    expect(retry.resultJson).toBe(first.resultJson);
    const inserts = prepared.filter((statement) =>
      statement.query.includes("INSERT INTO scan_adjudication_results"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.query).toContain(
      "ON CONFLICT(scan_id, ambiguity_id) DO NOTHING",
    );
  });

  it("does not lose cancellation when the workflow advances a stage", async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: () => statement,
          first: async <T>() =>
            ({
              id: "scan-1",
              upload_id: "upload-1",
              access_token_hash: "access-token-hash",
              mode: "quick",
              status: query.includes("UPDATE scan_sessions")
                ? "cancel_requested"
                : "extracting",
              source_hash: "source-hash",
              private_bundle_key: null,
              private_report_key: null,
              cancel_requested_at: query.includes("UPDATE scan_sessions")
                ? "2026-07-16T00:00:01.000Z"
                : null,
              created_at: "2026-07-16T00:00:00.000Z",
              updated_at: "2026-07-16T00:00:01.000Z",
            }) as T,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await expect(repository.requestCancel("scan-1")).resolves.toMatchObject({
      status: "cancel_requested",
    });
    expect(queries[1]).toContain("status IN");
    expect(queries[1]).not.toContain("AND status = ?");
  });

  it("deletes with one stage-independent update before any purge can run", async () => {
    const queries: string[] = [];
    const batch = vi.fn(async (_statements: D1PreparedStatementLike[]) => []);
    const db = {
      prepare(query: string) {
        queries.push(query);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: () => statement,
          first: async <T>() =>
            ({
              id: "scan-1",
              upload_id: "upload-1",
              access_token_hash: "access-token-hash",
              mode: "quick",
              status: "deleted",
              source_hash: "source-hash",
              private_bundle_key: null,
              private_report_key: null,
              cancel_requested_at: null,
              created_at: "2026-07-16T00:00:00.000Z",
              updated_at: "2026-07-16T00:00:01.000Z",
            }) as T,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch,
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await expect(repository.deleteScan("scan-1")).resolves.toMatchObject({
      status: "deleted",
    });
    const updateQuery = queries.find((query) =>
      query.includes("UPDATE scan_sessions"),
    );
    expect(updateQuery).toContain("status != 'deleted'");
    expect(updateQuery).not.toContain("AND status = ?");
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(queries[1]).toContain(
      "UPDATE public_reports SET status = 'unpublished'",
    );
    expect(queries[2]).toContain("UPDATE editor_sessions");
    expect(queries[2]).toContain("SET revoked_at = COALESCE(revoked_at, ?)");
  });

  it("atomically preserves a cancel request that races with terminal failure", async () => {
    let status = "extracting";
    const db = {
      prepare(query: string) {
        let values: unknown[] = [];
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...nextValues: unknown[]) => {
            values = nextValues;
            return statement;
          },
          first: async <T>() => {
            if (!query.includes("UPDATE scan_sessions")) return null;
            expect(query).toContain("WHEN status = 'cancel_requested'");
            // The cancel endpoint wins after markTerminal's read but before
            // this single UPDATE evaluates the row.
            status = "cancel_requested";
            status =
              status === "cancel_requested" || values[0] === "cancelled"
                ? "cancelled"
                : "failed";
            return {
              id: "scan-1",
              upload_id: "upload-1",
              access_token_hash: "access-token-hash",
              mode: "quick",
              status,
              source_hash: "source-hash",
              private_bundle_key: null,
              private_report_key: null,
              cancel_requested_at: "2026-07-16T00:00:00.000Z",
              created_at: "2026-07-16T00:00:00.000Z",
              updated_at: "2026-07-16T00:00:01.000Z",
            } as T;
          },
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-16T00:00:01.000Z");

    await expect(
      repository.markWorkflowTerminal("scan-1", "failed"),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("settles an editor AI reservation exactly once when finalization is retried", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    const ledger = {
      status: "reserved",
      settlementId: null as string | null,
      reservationId: "reservation-1",
    };
    const bucket = { reservedUnits: 2, actualUnits: 0 };
    const db = {
      prepare(query: string) {
        const statement: RecordedStatement = {
          query,
          values: [],
          bind: (...values: unknown[]) => {
            statement.values = values;
            return statement;
          },
          first: async <T>() =>
            query.includes("FROM ai_usage_ledger")
              ? ({
                  operation_id: "editor-ai:scan-1:key-1",
                  status: ledger.status,
                  provider: "workers-ai",
                  model: "model-1",
                  request_hash: "request-hash",
                  reservation_id: ledger.reservationId,
                  reserved_units: 2,
                  bucket_keys_json: JSON.stringify(["daily:2026-07-16"]),
                  updated_at: "2026-07-16T00:00:00.000Z",
                } as T)
              : null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async (statements: D1PreparedStatementLike[]) => {
        for (const rawStatement of statements) {
          const statement = rawStatement as RecordedStatement;
          if (statement.query.includes("UPDATE ai_usage_ledger")) {
            const [, , status, settlementId] = statement.values;
            if (ledger.status === "reserved" && ledger.settlementId === null) {
              ledger.status = status as string;
              ledger.settlementId = settlementId as string;
            }
            continue;
          }
          if (statement.query.includes("UPDATE usage_buckets")) {
            const [reservedUnits, actualUnits, , , , settlementId] =
              statement.values;
            if (ledger.settlementId === settlementId) {
              bucket.reservedUnits = Math.max(
                0,
                bucket.reservedUnits - Number(reservedUnits),
              );
              bucket.actualUnits += Number(actualUnits);
            }
          }
        }
        return [];
      }),
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);
    const settlement = {
      operationId: "editor-ai:scan-1:key-1",
      provider: "workers-ai",
      model: "model-1",
      status: "completed" as const,
    };

    await repository.finalizeAiUsageOperation(settlement);
    await repository.finalizeAiUsageOperation(settlement);

    expect(ledger.status).toBe("completed");
    expect(bucket).toEqual({ reservedUnits: 0, actualUnits: 2 });
  });

  it("claims a registered public artifact in the same transaction as publication", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[] };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async () => []),
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-16T00:00:00.000Z");

    await repository.publishPublicReport({
      id: "publication-1",
      scanId: "scan-1",
      artifactKey: "public/scan-1/publication-1.json",
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });

    const publishInsert = prepared.find((record) =>
      record.query.includes("INSERT INTO public_reports"),
    );
    expect(publishInsert?.query).toContain("FROM public_report_artifacts");
    expect(publishInsert?.query).toContain("a.published_at = ?");
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it("never treats another in-flight publication as obsolete or unpublished", async () => {
    const prepared: string[] = [];
    const db = {
      prepare(query: string) {
        prepared.push(query);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: () => statement,
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await repository.listObsoletePublicReportArtifacts("scan-1");
    await repository.listUnpublishedPublicReportArtifacts("scan-1");

    const cleanupQueries = prepared.filter((query) =>
      query.includes("public_report_artifacts"),
    );
    expect(cleanupQueries).toHaveLength(2);
    expect(
      cleanupQueries.every((query) =>
        query.includes("a.published_at IS NOT NULL"),
      ),
    ).toBe(true);
  });

  it("chunks artifact cleanup below D1's 100-bound-parameter limit", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[] };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async () => []),
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);
    const deletedKeys = Array.from(
      { length: 250 },
      (_, index) => `artifacts/scan-1/chunk-results/${index}.json`,
    );

    await repository.scrubDeletedScan("scan-1", deletedKeys, false);

    const artifactDeletes = prepared.filter((record) =>
      record.query.includes("DELETE FROM scan_artifacts"),
    );
    expect(artifactDeletes).toHaveLength(3);
    expect(
      Math.max(...artifactDeletes.map((record) => record.values.length)),
    ).toBeLessThanOrEqual(100);
    expect(artifactDeletes.flatMap((record) => record.values.slice(1))).toEqual(
      deletedKeys,
    );
  });

  it("removes deleted-scan publication metadata only after R2 cleanup completes", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    const batches: RecordedStatement[][] = [];
    const db = {
      prepare(query: string) {
        const statement: RecordedStatement = {
          query,
          values: [],
          bind: (...values: unknown[]) => {
            statement.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async (statements: D1PreparedStatementLike[]) => {
        batches.push(statements as RecordedStatement[]);
        return [];
      }),
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await repository.scrubDeletedScan("scan-1", [], false);
    expect(
      batches[0]?.some((statement) =>
        statement.query.includes("DELETE FROM public_report_artifacts"),
      ),
    ).toBe(false);

    await repository.scrubDeletedScan("scan-1", [], true);
    const completedCleanup = batches[1] ?? [];
    const abuseIndex = completedCleanup.findIndex((statement) =>
      statement.query.includes("DELETE FROM public_report_abuse_reports"),
    );
    const artifactIndex = completedCleanup.findIndex((statement) =>
      statement.query.includes("DELETE FROM public_report_artifacts"),
    );
    const completionIndex = completedCleanup.findIndex((statement) =>
      statement.query.includes("cleanup_completed_at"),
    );
    expect(abuseIndex).toBeGreaterThanOrEqual(0);
    expect(artifactIndex).toBeGreaterThan(abuseIndex);
    expect(completionIndex).toBeGreaterThan(artifactIndex);
  });

  it("does not fail a stale queued scan after it advances", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[] };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-16T00:30:00.000Z");

    await expect(
      repository.claimStaleQueuedScan("scan-1", "2026-07-16T00:15:00.000Z"),
    ).resolves.toBe(false);

    expect(prepared[0]?.query).toContain("status = 'queued'");
    expect(prepared[0]?.query).toContain("created_at <= ?");
    expect(prepared[0]?.query).toContain("RETURNING id");
    expect(prepared[0]?.values).toEqual([
      "2026-07-16T00:30:00.000Z",
      "scan-1",
      "2026-07-16T00:15:00.000Z",
    ]);
  });

  it("claims an old scan with a status-and-version CAS before retention", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[] };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() => ({ id: "scan-1" }) as T,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await expect(
      repository.claimScanForRetention({
        scanId: "scan-1",
        status: "completed",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).resolves.toBe(true);

    expect(prepared[0]?.query).toContain("SET status = 'expired'");
    expect(prepared[0]?.query).toContain(
      "id = ? AND status = ? AND updated_at = ?",
    );
    expect(prepared[0]?.values).toEqual([
      "scan-1",
      "completed",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("allows an editor AI reservation only while its scan is completed", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    const prepared: RecordedStatement[] = [];
    const db = {
      prepare(query: string) {
        const statement: RecordedStatement = {
          query,
          values: [],
          bind: (...values: unknown[]) => {
            statement.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        prepared.push(statement);
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await repository.claimAndReserveAiUsage({
      operationId: `editor-ai:${"a".repeat(64)}`,
      scanId: "scan-1",
      provider: "workers-ai",
      model: "model-1",
      requestHash: "b".repeat(64),
      units: 1,
      buckets: [],
    });

    const ledgerInsert = prepared.find((statement) =>
      statement.query.includes("INSERT INTO ai_usage_ledger"),
    );
    expect(ledgerInsert?.query).toContain("status = 'completed'");
    expect(ledgerInsert?.query).toContain("private_report_key IS NOT NULL");
    expect(ledgerInsert?.values).toContain("scan-1");
  });

  it("makes publication and pending-artifact cleanup mutually exclusive", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    const prepared: RecordedStatement[] = [];
    const db = {
      prepare(query: string) {
        const statement: RecordedStatement = {
          query,
          values: [],
          bind: (...values: unknown[]) => {
            statement.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        prepared.push(statement);
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db);

    await repository.publishPublicReport({
      id: "report-1",
      scanId: "scan-1",
      artifactKey: "public/scan-1/report-1.json",
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });
    await expect(
      repository.claimPendingPublicReportArtifact(
        "scan-1",
        "public/scan-1/report-1.json",
        "2026-07-16T00:15:00.000Z",
      ),
    ).resolves.toBe(false);

    const publishUpdate = prepared.find(
      (statement) =>
        statement.query.includes("UPDATE public_report_artifacts") &&
        statement.query.includes("published_at"),
    );
    const publishInsert = prepared.find((statement) =>
      statement.query.includes("INSERT INTO public_reports"),
    );
    const cleanupClaim = prepared.find((statement) =>
      statement.query.includes("SET cleanup_claimed_at"),
    );
    expect(publishUpdate?.query).toContain("cleanup_claimed_at IS NULL");
    expect(publishInsert?.query).toContain("cleanup_claimed_at IS NULL");
    expect(cleanupClaim?.query).toContain("published_at IS NULL");
    expect(cleanupClaim?.query).toContain("RETURNING object_key");
  });

  it.each(["completed", "cancelled", "failed", "expired"] as const)(
    "treats cancellation of a terminal %s scan as idempotent",
    async (status) => {
      const db = {
        prepare: () => {
          throw new Error("terminal cancellation must not write to D1");
        },
        batch: async () => [],
      } satisfies D1DatabaseLike;
      const repository = new ScanRepository(db);
      const scan = {
        id: "scan-1",
        uploadId: "upload-1",
        mode: "quick" as const,
        status,
        sourceHash: "source-hash",
        privateBundleKey: null,
        privateReportKey: null,
        cancelRequestedAt: null,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        accessTokenHash: "access-token-hash",
      };
      vi.spyOn(repository, "getScan").mockResolvedValue(scan);

      await expect(repository.requestCancel("scan-1")).resolves.toBe(scan);
    },
  );

  it("stores only the scoped Editor session hash and expiry", async () => {
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[] };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-19T00:00:00.000Z");

    await repository.createEditorSession({
      tokenHash: "session-token-hash",
      scanId: "scan-1",
      expiresAt: "2026-07-20T00:00:00.000Z",
    });

    expect(prepared[0]?.query).toContain("INSERT INTO editor_sessions");
    expect(prepared[0]?.values).toEqual([
      "session-token-hash",
      "scan-1",
      "2026-07-20T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
    ]);
  });

  it("authorizes only an unexpired unrevoked session for its completed scan", async () => {
    let query = "";
    let values: unknown[] = [];
    const db = {
      prepare(nextQuery: string) {
        query = nextQuery;
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...nextValues: unknown[]) => {
            values = nextValues;
            return statement;
          },
          first: async <T>() =>
            ({
              id: "scan-1",
              upload_id: "upload-1",
              access_token_hash: "scan-token-hash",
              mode: "quick",
              status: "completed",
              source_hash: "source-hash",
              private_bundle_key: "artifacts/scan-1/bundle.json",
              private_report_key: "artifacts/scan-1/report.json",
              cancel_requested_at: null,
              created_at: "2026-07-18T00:00:00.000Z",
              updated_at: "2026-07-18T00:10:00.000Z",
            }) as T,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    } satisfies D1DatabaseLike;
    const repository = new ScanRepository(db, () => "2026-07-19T00:00:00.000Z");

    await expect(
      repository.authorizeEditorSession("scan-1", "session-token-hash"),
    ).resolves.toMatchObject({ id: "scan-1", status: "completed" });

    expect(query).toContain("FROM editor_sessions");
    expect(query).toContain("editor_sessions.revoked_at IS NULL");
    expect(query).toContain("editor_sessions.expires_at > ?");
    expect(query).toContain("scan_sessions.status = 'completed'");
    expect(values).toEqual([
      "session-token-hash",
      "scan-1",
      "2026-07-19T00:00:00.000Z",
    ]);
  });
});
