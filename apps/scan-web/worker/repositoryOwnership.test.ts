import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./env";
import { ScanRepository } from "./repository";

const consent = {
  consentId: `consent_${"a".repeat(64)}`,
  policyVersion: "2026-07-19.8",
  provider: "workers-ai",
  route: "scan" as const,
};

function recordingDb() {
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
  return { db, prepared };
}

describe("account-owned Scan repository", () => {
  it("stores the request account with the upload intent", async () => {
    const { db, prepared } = recordingDb();
    const repository = new ScanRepository(
      db,
      () => "2026-07-19T00:00:00.000Z",
      "access-subject-123",
    );

    await repository.createUploadIntent({
      id: "upload-1",
      tokenHash: "upload-token-hash",
      filename: "novel.txt",
      contentType: "text/plain",
      expectedSize: 12,
      sourceKey: "incoming/upload-1/source.txt",
      status: "issued",
      expiresAt: "2026-07-19T00:15:00.000Z",
      actualSize: null,
      sourceHash: null,
      aiConsent: consent,
    });

    expect(prepared[0]?.query).toContain("owner_subject");
    expect(prepared[0]?.values).toContain("access-subject-123");
  });

  it("copies the matching upload owner into the Scan in the same D1 batch", async () => {
    const { db, prepared } = recordingDb();
    const repository = new ScanRepository(db, undefined, "access-subject-123");
    const persisted = {
      id: "11111111-1111-4111-8111-111111111111",
      uploadId: "upload-1",
      mode: "quick" as const,
      status: "queued" as const,
      sourceHash: "source-hash",
      privateBundleKey: null,
      privateReportKey: null,
      cancelRequestedAt: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
      ownerSubject: "access-subject-123",
      aiConsent: consent,
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
        aiConsent: consent,
      }),
    ).resolves.toBe("created");

    const insert = prepared.find(({ query }) =>
      query.includes("INSERT INTO scan_sessions"),
    );
    expect(insert?.query).toContain("owner_subject");
    expect(insert?.query).toContain("u.owner_subject");
    expect(insert?.query).toContain("u.owner_subject = ?");
    expect(insert?.values).toContain("access-subject-123");
  });

  it("atomically claims a legacy capability for one authenticated account", async () => {
    const { db, prepared } = recordingDb();
    const repository = new ScanRepository(db, undefined, "access-subject-123");

    await repository.authorizeScan("scan-1", "scan-token-hash");

    expect(prepared[0]?.query).toContain(
      "owner_subject = COALESCE(owner_subject, ?)",
    );
    expect(prepared[0]?.query).toContain(
      "(owner_subject = ? OR owner_subject IS NULL)",
    );
    expect(prepared[0]?.values).toEqual(
      expect.arrayContaining(["access-subject-123", "scan-token-hash"]),
    );
  });
});
