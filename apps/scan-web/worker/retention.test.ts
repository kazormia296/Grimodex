import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike, ScanEnv } from "./env";
import type { ScanRepository } from "./repository";
import { purgeDeletedScan, runRetentionCleanup } from "./retention";

describe("scan retention", () => {
  it("keeps cleanup pending when the R2 prefix listing is incomplete", async () => {
    const deletedKeys: string[] = [];
    const scrubDeletedScan = vi.fn(async () => undefined);
    const repository = {
      getScan: vi.fn(async () => ({
        id: "scan-1",
        uploadId: "upload-1",
        mode: "quick" as const,
        status: "deleted" as const,
        sourceHash: "source-hash",
        privateBundleKey: "artifacts/scan-1/bundle.json",
        privateReportKey: "artifacts/scan-1/report.json",
        cancelRequestedAt: null,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        accessTokenHash: "access-token-hash",
      })),
      getUploadIntent: vi.fn(async () => ({
        id: "upload-1",
        tokenHash: "upload-token-hash",
        filename: "novel.txt",
        contentType: "text/plain",
        expectedSize: 1,
        sourceKey: "incoming/upload-1/source.txt",
        status: "consumed" as const,
        expiresAt: "2026-07-17T00:00:00.000Z",
        actualSize: 1,
        sourceHash: "source-hash",
      })),
      getPublicReportByScanId: vi.fn(async () => null),
      listScanArtifacts: vi.fn(async () => []),
      scrubDeletedScan,
    } as unknown as ScanRepository;
    const env = {
      SCAN_BUCKET: {
        put: async () => undefined,
        get: async () => null,
        head: async () => null,
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
        list: async ({ prefix }: { prefix?: string } = {}) => {
          if (prefix?.startsWith("artifacts/")) {
            throw new Error("R2 listing is temporarily unavailable");
          }
          return {
            objects: [{ key: "public/scan-1/old-publication.json" }],
            truncated: false,
          };
        },
      },
    } as unknown as ScanEnv;

    const result = await purgeDeletedScan(env, repository, "scan-1");

    expect(deletedKeys).toContain("public/scan-1/old-publication.json");
    expect(deletedKeys).toHaveLength(4);
    expect(result).toEqual({ deletedObjects: 4, cleanupPending: true });
    expect(scrubDeletedScan).toHaveBeenCalledWith("scan-1", deletedKeys, false);
  });

  it("bounds row selection, R2 concurrency, and D1 progress batches", async () => {
    const oldScans = Array.from({ length: 120 }, (_, index) => ({
      id: `scan-${index}`,
      upload_id: `upload-${index}`,
      status: "completed",
      updated_at: "2026-06-01T00:00:00.000Z",
      private_bundle_key: null,
      private_report_key: null,
      public_report_id: null,
      public_artifact_key: null,
    }));
    const expiredUploads = oldScans.map((scan) => ({
      upload_id: scan.upload_id,
      source_key: `incoming/${scan.upload_id}/source.txt`,
    }));
    const prepared: Array<{
      query: string;
      values: unknown[];
      allCalled: boolean;
    }> = [];
    const resultsFor = (query: string): unknown[] => {
      if (query.includes("SELECT id AS upload_id")) return expiredUploads;
      if (query.includes("SELECT s.id, s.upload_id")) return oldScans;
      return [];
    };
    const db = {
      prepare(query: string) {
        const record = {
          query,
          values: [] as unknown[],
          allCalled: false,
        };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() =>
            (query.includes("SET status = 'expired'")
              ? { id: record.values[0] }
              : null) as T | null,
          all: async <T>() => {
            record.allCalled = true;
            return { results: resultsFor(query) as T[] };
          },
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async (statements: D1PreparedStatementLike[]) => {
        expect(statements.length).toBeLessThanOrEqual(8);
        return [];
      }),
    } satisfies D1DatabaseLike;
    let activeLists = 0;
    let maxActiveLists = 0;
    let listCalls = 0;
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const bucket = {
      marker: true,
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
      delete: async () => {
        activeDeletes += 1;
        maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
        await Promise.resolve();
        activeDeletes -= 1;
      },
      async list() {
        if (!this.marker) throw new Error("R2 list receiver was lost");
        listCalls += 1;
        activeLists += 1;
        maxActiveLists = Math.max(maxActiveLists, activeLists);
        await Promise.resolve();
        activeLists -= 1;
        return { objects: [], truncated: false };
      },
    };

    const result = await runRetentionCleanup(
      { DB: db, SCAN_BUCKET: bucket } as unknown as ScanEnv,
      undefined,
      new Date("2026-07-16T00:00:00.000Z"),
    );

    expect(result.scrubbedScans).toBe(16);
    expect(
      Math.max(...prepared.map((record) => record.values.length)),
    ).toBeLessThanOrEqual(100);
    expect(
      prepared
        .filter((record) => record.allCalled)
        .every((record) => /LIMIT \?/.test(record.query)),
    ).toBe(true);
    expect(db.batch).toHaveBeenCalledTimes(2);
    expect(listCalls).toBe(32);
    expect(maxActiveLists).toBeLessThanOrEqual(4);
    expect(maxActiveDeletes).toBeLessThanOrEqual(4);
  });

  it("stops paginated R2 listing at the per-run subrequest budget", async () => {
    const repository = {
      getScan: vi.fn(async () => ({
        id: "scan-1",
        uploadId: "upload-1",
        privateBundleKey: null,
        privateReportKey: null,
      })),
      getUploadIntent: vi.fn(async () => null),
      getPublicReportByScanId: vi.fn(async () => null),
      listScanArtifacts: vi.fn(async () => []),
      scrubDeletedScan: vi.fn(async () => undefined),
    } as unknown as ScanRepository;
    let listCalls = 0;
    const env = {
      SCAN_BUCKET: {
        delete: async () => undefined,
        list: async () => {
          listCalls += 1;
          return {
            objects: [{ key: `artifacts/scan-1/page-${listCalls}.json` }],
            truncated: true,
            cursor: `cursor-${listCalls}`,
          };
        },
      },
    } as unknown as ScanEnv;

    const result = await purgeDeletedScan(env, repository, "scan-1");

    expect(listCalls).toBe(32);
    expect(result).toEqual({ deletedObjects: 32, cleanupPending: true });
  });

  it("caps R2 deletes and leaves excess keys for the next pass", async () => {
    const repository = {
      getScan: vi.fn(async () => ({
        id: "scan-1",
        uploadId: "upload-1",
        privateBundleKey: null,
        privateReportKey: null,
      })),
      getUploadIntent: vi.fn(async () => null),
      getPublicReportByScanId: vi.fn(async () => null),
      listScanArtifacts: vi.fn(async () => []),
      scrubDeletedScan: vi.fn(async () => undefined),
    } as unknown as ScanRepository;
    const deleted: string[] = [];
    const env = {
      SCAN_BUCKET: {
        delete: async (key: string) => {
          deleted.push(key);
        },
        list: async ({ prefix }: { prefix?: string } = {}) => ({
          objects: prefix?.startsWith("artifacts/")
            ? Array.from({ length: 100 }, (_, index) => ({
                key: `artifacts/scan-1/${index}.json`,
              }))
            : [],
          truncated: false,
        }),
      },
    } as unknown as ScanEnv;

    const result = await purgeDeletedScan(env, repository, "scan-1");

    expect(deleted).toHaveLength(64);
    expect(result).toEqual({ deletedObjects: 64, cleanupPending: true });
  });

  it("removes stale uncommitted public report artifacts", async () => {
    const prepared: Array<{ query: string; values: unknown[]; ran: boolean }> =
      [];
    const db = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[], ran: false };
        prepared.push(record);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: (...values: unknown[]) => {
            record.values = values;
            return statement;
          },
          first: async <T>() =>
            (query.includes("SET cleanup_claimed_at")
              ? { object_key: "public/scan-1/abandoned.json" }
              : null) as T | null,
          all: async <T>() => ({
            results: (query.includes("published_at IS NULL")
              ? [
                  {
                    scan_id: "scan-1",
                    object_key: "public/scan-1/abandoned.json",
                  },
                ]
              : []) as T[],
          }),
          run: async () => {
            record.ran = true;
            return { success: true };
          },
        };
        return statement;
      },
      batch: vi.fn(async () => []),
    } satisfies D1DatabaseLike;
    const deleted: string[] = [];

    const result = await runRetentionCleanup(
      {
        DB: db,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => null,
          head: async () => null,
          delete: async (key) => {
            deleted.push(key);
          },
        },
      },
      undefined,
      new Date("2026-07-16T12:00:00.000Z"),
    );

    expect(deleted).toEqual(["public/scan-1/abandoned.json"]);
    expect(
      prepared.find((record) => record.query.includes("published_at IS NULL"))
        ?.values,
    ).toEqual(["2026-07-16T11:45:00.000Z", "2026-07-16T11:45:00.000Z", 20]);
    expect(
      prepared.find(
        (record) =>
          record.ran &&
          record.query.includes("DELETE FROM public_report_artifacts"),
      )?.values,
    ).toEqual(["scan-1", "public/scan-1/abandoned.json"]);
    expect(result.deletedObjects).toBe(1);
  });

  it("does not delete a pending artifact when publication wins the D1 race", async () => {
    const db = {
      prepare(query: string) {
        let statement: D1PreparedStatementLike;
        statement = {
          bind: () => statement,
          first: async <T>() => null as T | null,
          all: async <T>() => ({
            results: (query.includes("published_at IS NULL")
              ? [
                  {
                    scan_id: "scan-1",
                    object_key: "public/scan-1/published.json",
                  },
                ]
              : []) as T[],
          }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async () => []),
    } satisfies D1DatabaseLike;
    const deleteObject = vi.fn(async () => undefined);

    await runRetentionCleanup(
      {
        DB: db,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => null,
          head: async () => null,
          delete: deleteObject,
        },
      },
      undefined,
      new Date("2026-07-16T12:00:00.000Z"),
    );

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("does not settle a queued scan that advanced before the CAS claim", async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        let statement: D1PreparedStatementLike;
        statement = {
          bind: () => statement,
          first: async <T>() => null as T | null,
          all: async <T>() => ({
            results: (query.includes("status = 'queued'")
              ? [{ id: "scan-raced" }]
              : []) as T[],
          }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async () => []),
    } satisfies D1DatabaseLike;

    await runRetentionCleanup(
      {
        DB: db,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => null,
          head: async () => null,
          delete: async () => undefined,
        },
      },
      undefined,
      new Date("2026-07-16T12:00:00.000Z"),
    );

    expect(queries.some((query) => query.includes("FROM scan_jobs"))).toBe(
      false,
    );
  });

  it("charges a persisted successful editor result after final accounting was lost", async () => {
    type RecordedStatement = D1PreparedStatementLike & {
      query: string;
      values: unknown[];
    };
    const operationId = `editor-ai:${"a".repeat(64)}`;
    const requestHash = "b".repeat(64);
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
          first: async <T>() =>
            (query.includes("FROM ai_usage_ledger")
              ? {
                  operation_id: operationId,
                  scan_id: "scan-1",
                  status: "reserved",
                  provider: "workers-ai",
                  model: "reserved-model",
                  request_hash: requestHash,
                  reservation_id: "reservation-1",
                  reserved_units: 2,
                  bucket_keys_json: JSON.stringify(["daily:2026-07-16"]),
                  updated_at: "2026-07-16T10:00:00.000Z",
                }
              : null) as T | null,
          all: async <T>() => ({
            results: (query.includes(
              "status = 'reserved' AND reservation_id IS NOT NULL",
            )
              ? [{ operation_id: operationId }]
              : []) as T[],
          }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: vi.fn(async (statements: D1PreparedStatementLike[]) => {
        batches.push(statements as RecordedStatement[]);
        return [];
      }),
    } satisfies D1DatabaseLike;
    const artifact = JSON.stringify({
      schemaVersion: "grimodex-scan/editor-ai-operation/1",
      operationId,
      requestHash,
      status: "completed",
      provider: "ai-gateway",
      model: "completed-model",
      costWeight: 2,
      response: "persisted success",
    });
    const requestedKeys: string[] = [];

    await runRetentionCleanup(
      {
        DB: db,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async (key) => {
            requestedKeys.push(key);
            return {
              body: new Response(artifact).body,
              size: artifact.length,
            };
          },
          head: async () => null,
          delete: async () => undefined,
        },
      },
      undefined,
      new Date("2026-07-16T12:00:00.000Z"),
    );

    expect(requestedKeys).toEqual([
      `artifacts/scan-1/editor-ai/${"a".repeat(64)}.json`,
    ]);
    const settlementStatements = batches.flat();
    const ledgerSettlement = settlementStatements.find((statement) =>
      statement.query.includes("UPDATE ai_usage_ledger"),
    );
    const bucketSettlement = settlementStatements.find((statement) =>
      statement.query.includes("UPDATE usage_buckets"),
    );
    expect(ledgerSettlement?.values.slice(0, 3)).toEqual([
      "ai-gateway",
      "completed-model",
      "completed",
    ]);
    expect(bucketSettlement?.values.slice(0, 2)).toEqual([2, 2]);
  });
});
