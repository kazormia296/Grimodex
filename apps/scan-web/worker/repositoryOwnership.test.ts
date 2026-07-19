import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike, ScanEnv } from "./env";
import { ScanRepository } from "./repository";
import { purgeDeletedScan } from "./retention";

const consent = {
  consentId: `consent_${"a".repeat(64)}`,
  policyVersion: "2026-07-19.9",
  provider: "workers-ai",
  route: "scan" as const,
};

function recordingDb(firstResult: unknown = null) {
  const prepared: Array<{ query: string; values: unknown[] }> = [];
  const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
  const statementRecords = new Map<
    D1PreparedStatementLike,
    { query: string; values: unknown[] }
  >();
  const db = {
    prepare(query: string) {
      const recorded = { query, values: [] as unknown[] };
      prepared.push(recorded);
      const statement: D1PreparedStatementLike = {
        bind: (...values: unknown[]) => {
          recorded.values = values;
          return statement;
        },
        first: async <T>() => firstResult as T | null,
        all: async <T>() => ({ results: [] as T[] }),
        run: async () => ({ success: true }),
      };
      statementRecords.set(statement, recorded);
      return statement;
    },
    batch: async (statements) => {
      batches.push(
        statements.map(
          (statement) =>
            statementRecords.get(statement) ?? { query: "", values: [] },
        ),
      );
      return [];
    },
  } satisfies D1DatabaseLike;
  return { db, prepared, batches };
}

function racingCapabilityDb() {
  const state: {
    uploadOwner: string | null;
    editorTokenOwner: string | null;
    editorSessionOwner: string | null;
    scanOwner: string | null;
  } = {
    uploadOwner: null,
    editorTokenOwner: null,
    editorSessionOwner: null,
    scanOwner: null,
  };
  const statementRecords = new Map<
    D1PreparedStatementLike,
    { query: string; values: unknown[] }
  >();
  const uploadRow = () => ({
    id: "upload-1",
    token_hash: "upload-token-hash",
    filename: "novel.txt",
    content_type: "text/plain",
    expected_size: 12,
    source_key: "incoming/upload-1/source.txt",
    status: "uploaded",
    expires_at: "2026-07-20T00:00:00.000Z",
    actual_size: 12,
    source_hash: "source-hash",
    owner_subject: state.uploadOwner,
    ai_consent_id: consent.consentId,
    ai_consent_policy_version: consent.policyVersion,
    ai_consent_provider: consent.provider,
    ai_consent_route: consent.route,
  });
  const scanRow = () => ({
    id: "scan-1",
    upload_id: "upload-1",
    access_token_hash: "scan-token-hash",
    mode: "quick",
    status: "completed",
    source_hash: "source-hash",
    private_bundle_key: "artifacts/scan-1/bundle.json",
    private_report_key: "artifacts/scan-1/report.json",
    cancel_requested_at: null,
    owner_subject: state.scanOwner,
    ai_consent_id: consent.consentId,
    ai_consent_policy_version: consent.policyVersion,
    ai_consent_provider: consent.provider,
    ai_consent_route: consent.route,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:01:00.000Z",
  });
  const applyBatchStatement = (record: {
    query: string;
    values: unknown[];
  }) => {
    if (record.query.includes("UPDATE editor_tokens")) {
      const [
        subject,
        token,
        ,
        expectedOwner,
        expectedScanOwner,
        expectedUploadOwner,
      ] = record.values;
      if (
        token === "editor-token-hash" &&
        (state.editorTokenOwner === expectedOwner ||
          state.editorTokenOwner === null) &&
        (state.scanOwner === expectedScanOwner || state.scanOwner === null) &&
        (state.uploadOwner === expectedUploadOwner ||
          state.uploadOwner === null)
      ) {
        state.editorTokenOwner ??= String(subject);
      }
      return;
    }
    if (
      record.query.includes("UPDATE scan_sessions") &&
      record.query.includes("FROM editor_tokens")
    ) {
      const [subject, expectedOwner, token, , tokenOwner, expectedUploadOwner] =
        record.values;
      if (
        token === "editor-token-hash" &&
        state.editorTokenOwner === tokenOwner &&
        (state.scanOwner === expectedOwner || state.scanOwner === null) &&
        (state.uploadOwner === expectedUploadOwner ||
          state.uploadOwner === null)
      ) {
        state.scanOwner ??= String(subject);
      }
      return;
    }
    if (
      record.query.includes("UPDATE upload_intents") &&
      record.query.includes("FROM editor_tokens")
    ) {
      const [subject, expectedOwner, scanOwner, token, , tokenOwner] =
        record.values;
      if (
        token === "editor-token-hash" &&
        state.scanOwner === scanOwner &&
        state.editorTokenOwner === tokenOwner &&
        (state.uploadOwner === expectedOwner || state.uploadOwner === null)
      ) {
        state.uploadOwner ??= String(subject);
      }
      return;
    }
    if (record.query.includes("UPDATE editor_sessions")) {
      const [
        subject,
        token,
        scanId,
        ,
        expectedOwner,
        expectedScanOwner,
        expectedUploadOwner,
      ] = record.values;
      if (
        token === "editor-session-token-hash" &&
        scanId === "scan-1" &&
        (state.editorSessionOwner === expectedOwner ||
          state.editorSessionOwner === null) &&
        (state.scanOwner === expectedScanOwner || state.scanOwner === null) &&
        (state.uploadOwner === expectedUploadOwner ||
          state.uploadOwner === null)
      ) {
        state.editorSessionOwner ??= String(subject);
      }
      return;
    }
    if (
      record.query.includes("UPDATE scan_sessions") &&
      record.query.includes("FROM editor_sessions")
    ) {
      const [
        subject,
        scanId,
        expectedOwner,
        token,
        ,
        sessionOwner,
        expectedUploadOwner,
      ] = record.values;
      if (
        scanId === "scan-1" &&
        token === "editor-session-token-hash" &&
        state.editorSessionOwner === sessionOwner &&
        (state.scanOwner === expectedOwner || state.scanOwner === null) &&
        (state.uploadOwner === expectedUploadOwner ||
          state.uploadOwner === null)
      ) {
        state.scanOwner ??= String(subject);
      }
      return;
    }
    if (
      record.query.includes("UPDATE upload_intents") &&
      record.query.includes("FROM editor_sessions")
    ) {
      const [subject, expectedOwner, scanId, scanOwner, token, , sessionOwner] =
        record.values;
      if (
        scanId === "scan-1" &&
        token === "editor-session-token-hash" &&
        state.scanOwner === scanOwner &&
        state.editorSessionOwner === sessionOwner &&
        (state.uploadOwner === expectedOwner || state.uploadOwner === null)
      ) {
        state.uploadOwner ??= String(subject);
      }
    }
  };
  const db = {
    prepare(query: string) {
      const record = { query, values: [] as unknown[] };
      const statement: D1PreparedStatementLike = {
        bind: (...values: unknown[]) => {
          record.values = values;
          return statement;
        },
        first: async <T>() => {
          if (
            query.includes("SELECT") &&
            query.includes("FROM upload_intents")
          ) {
            const [id, token, , owner] = record.values;
            return (
              id === "upload-1" &&
              token === "upload-token-hash" &&
              state.uploadOwner === owner
                ? uploadRow()
                : null
            ) as T | null;
          }
          if (query.includes("UPDATE upload_intents")) {
            const [subject, id, token] = record.values;
            if (
              id === "upload-1" &&
              token === "upload-token-hash" &&
              state.uploadOwner === null
            ) {
              state.uploadOwner = String(subject);
              return uploadRow() as T;
            }
            return null;
          }
          if (
            query.includes("FROM editor_tokens") &&
            query.includes("SELECT scan_id")
          ) {
            const [token, , tokenOwner, scanOwner, uploadOwner] = record.values;
            return (
              token === "editor-token-hash" &&
              state.editorTokenOwner === tokenOwner &&
              state.scanOwner === scanOwner &&
              state.uploadOwner === uploadOwner
                ? {
                    scan_id: "scan-1",
                    artifact_key: "artifacts/scan-1/bundle.json",
                    expires_at: "2026-07-20T00:00:00.000Z",
                  }
                : null
            ) as T | null;
          }
          if (
            query.includes("FROM editor_sessions") &&
            query.includes("INNER JOIN scan_sessions")
          ) {
            const [token, scanId, , sessionOwner, scanOwner, uploadOwner] =
              record.values;
            return (
              token === "editor-session-token-hash" &&
              scanId === "scan-1" &&
              state.editorSessionOwner === sessionOwner &&
              state.scanOwner === scanOwner &&
              state.uploadOwner === uploadOwner
                ? scanRow()
                : null
            ) as T | null;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[] }),
        run: async () => ({ success: true }),
      };
      statementRecords.set(statement, record);
      return statement;
    },
    batch: async (statements) => {
      for (const statement of statements) {
        const record = statementRecords.get(statement);
        if (record) applyBatchStatement(record);
      }
      return [];
    },
  } satisfies D1DatabaseLike;
  return { db, state };
}

function legacyScanOwnershipDb() {
  const state: {
    uploadOwner: string | null;
    scanOwner: string | null;
    scanStatus: "completed" | "deleted";
  } = {
    uploadOwner: null,
    scanOwner: null,
    scanStatus: "completed",
  };
  const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
  const statementRecords = new Map<
    D1PreparedStatementLike,
    { query: string; values: unknown[] }
  >();
  const scanRow = () => ({
    id: "scan-1",
    upload_id: "upload-1",
    access_token_hash: "scan-token-hash",
    mode: "quick",
    status: state.scanStatus,
    source_hash: "source-hash",
    private_bundle_key: "artifacts/scan-1/bundle.json",
    private_report_key: "artifacts/scan-1/report.json",
    cancel_requested_at: null,
    owner_subject: state.scanOwner,
    ai_consent_id: consent.consentId,
    ai_consent_policy_version: consent.policyVersion,
    ai_consent_provider: consent.provider,
    ai_consent_route: consent.route,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:01:00.000Z",
  });
  const uploadRow = () => ({
    id: "upload-1",
    token_hash: "upload-token-hash",
    filename: "novel.txt",
    content_type: "text/plain",
    expected_size: 12,
    source_key: "incoming/upload-1/source.txt",
    status: "consumed",
    expires_at: "2026-07-20T00:00:00.000Z",
    actual_size: 12,
    source_hash: "source-hash",
    owner_subject: state.uploadOwner,
    ai_consent_id: consent.consentId,
    ai_consent_policy_version: consent.policyVersion,
    ai_consent_provider: consent.provider,
    ai_consent_route: consent.route,
  });
  const accountSubject = (values: readonly unknown[]): string | null => {
    const value = values.find(
      (entry) =>
        typeof entry === "string" && entry.startsWith("access-subject-"),
    );
    return typeof value === "string" ? value : null;
  };
  const scanIdentityMatches = (
    query: string,
    values: readonly unknown[],
  ): boolean => {
    if (!values.includes("scan-1")) return false;
    if (
      query.includes("access_token_hash = ?") &&
      !values.includes("scan-token-hash")
    )
      return false;
    if (query.includes("upload_id = ?") && !values.includes("upload-1"))
      return false;
    if (query.includes("mode = ?") && !values.includes("quick")) return false;
    if (
      query.includes("ai_consent_id = ?") &&
      ![
        consent.consentId,
        consent.policyVersion,
        consent.provider,
        consent.route,
      ].every((value) => values.includes(value))
    )
      return false;
    return true;
  };
  const applyScanOwnerClaim = (record: {
    query: string;
    values: unknown[];
  }): boolean => {
    const subject = accountSubject(record.values);
    if (!subject || !scanIdentityMatches(record.query, record.values))
      return false;
    if (state.scanOwner !== null && state.scanOwner !== subject) return false;
    if (
      record.query.includes("FROM upload_intents") &&
      state.uploadOwner !== null &&
      state.uploadOwner !== subject
    )
      return false;
    state.scanOwner = subject;
    return true;
  };
  const applyUploadOwnerClaim = (record: {
    query: string;
    values: unknown[];
  }): boolean => {
    const subject = accountSubject(record.values);
    if (
      !subject ||
      !scanIdentityMatches(record.query, record.values) ||
      state.scanOwner !== subject ||
      (state.uploadOwner !== null && state.uploadOwner !== subject)
    )
      return false;
    state.uploadOwner = subject;
    return true;
  };
  const applyBatchStatement = (record: {
    query: string;
    values: unknown[];
  }) => {
    if (
      record.query.includes("UPDATE scan_sessions") &&
      record.query.includes("owner_subject = COALESCE(owner_subject, ?)")
    ) {
      applyScanOwnerClaim(record);
      return;
    }
    if (
      record.query.includes("UPDATE upload_intents") &&
      record.query.includes("owner_subject = COALESCE(owner_subject, ?)")
    ) {
      applyUploadOwnerClaim(record);
    }
  };
  const db = {
    prepare(query: string) {
      const record = { query, values: [] as unknown[] };
      const statement: D1PreparedStatementLike = {
        bind: (...values: unknown[]) => {
          record.values = values;
          return statement;
        },
        first: async <T>() => {
          if (
            query.includes("UPDATE scan_sessions") &&
            query.includes("RETURNING id")
          ) {
            return (applyScanOwnerClaim(record) ? scanRow() : null) as T | null;
          }
          if (query.includes("FROM scan_sessions")) {
            if (!scanIdentityMatches(query, record.values)) return null;
            const subject = accountSubject(record.values);
            if (
              query.includes("owner_subject = ?") &&
              !query.includes("owner_subject = ? OR owner_subject IS NULL") &&
              state.scanOwner !== subject
            )
              return null;
            if (
              query.includes("owner_subject = ? OR owner_subject IS NULL") &&
              state.scanOwner !== null &&
              state.scanOwner !== subject
            )
              return null;
            if (
              query.includes("upload_intents.owner_subject = ?") &&
              state.uploadOwner !== subject
            )
              return null;
            return scanRow() as T;
          }
          if (query.includes("FROM upload_intents")) {
            const subject = accountSubject(record.values);
            if (!record.values.includes("upload-1")) return null;
            if (
              query.includes("owner_subject = ?") &&
              state.uploadOwner !== subject
            )
              return null;
            return uploadRow() as T;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[] }),
        run: async () => ({ success: true }),
      };
      statementRecords.set(statement, record);
      return statement;
    },
    batch: async (statements) => {
      const records = statements.map(
        (statement) =>
          statementRecords.get(statement) ?? { query: "", values: [] },
      );
      batches.push(records);
      for (const record of records) applyBatchStatement(record);
      return [];
    },
  } satisfies D1DatabaseLike;
  return { batches, db, state };
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

  it("creates the Scan before claiming an ownerless Upload and fences both with the capabilities", async () => {
    const { batches, db, prepared } = recordingDb();
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
        uploadTokenHash: "upload-token-hash",
        buckets: [],
        aiConsent: consent,
      }),
    ).resolves.toBe("created");

    const insert = prepared.find(({ query }) =>
      query.includes("INSERT INTO scan_sessions"),
    );
    expect(insert?.query).toContain("owner_subject");
    expect(insert?.query).toContain("u.token_hash = ?");
    expect(insert?.query).toContain(
      "(u.owner_subject = ? OR u.owner_subject IS NULL)",
    );
    expect(insert?.values).toContain("upload-token-hash");
    expect(insert?.values).toContain("access-subject-123");

    const statements = batches[0] ?? [];
    const sessionInsertIndex = statements.findIndex(({ query }) =>
      query.includes("INSERT INTO scan_sessions"),
    );
    const uploadClaimIndex = statements.findIndex(
      ({ query }) =>
        query.includes("UPDATE upload_intents") &&
        query.includes("FROM scan_sessions"),
    );
    expect(sessionInsertIndex).toBeGreaterThanOrEqual(0);
    expect(uploadClaimIndex).toBeGreaterThan(sessionInsertIndex);
    const uploadClaim = statements[uploadClaimIndex];
    expect(uploadClaim?.query).toContain("scan_sessions.access_token_hash = ?");
    expect(uploadClaim?.query).toContain("scan_sessions.mode = ?");
    expect(uploadClaim?.query).toContain("scan_sessions.ai_consent_id = ?");
    expect(uploadClaim?.values).toEqual(
      expect.arrayContaining([
        persisted.id,
        persisted.accessTokenHash,
        "upload-token-hash",
        "access-subject-123",
      ]),
    );
  });

  it("atomically claims a legacy capability for one authenticated account", async () => {
    const { db, prepared } = recordingDb();
    const repository = new ScanRepository(db, undefined, "access-subject-123");

    await repository.authorizeScan("scan-1", "scan-token-hash");

    const claim = prepared.find(({ query }) =>
      query.includes("owner_subject = COALESCE(owner_subject, ?)"),
    );
    expect(claim?.query).toContain(
      "owner_subject = COALESCE(owner_subject, ?)",
    );
    expect(claim?.query).toContain(
      "(owner_subject = ? OR owner_subject IS NULL)",
    );
    expect(claim?.values).toEqual(
      expect.arrayContaining(["access-subject-123", "scan-token-hash"]),
    );
  });

  it("claims a legacy Scan and its parent upload in one batch so deletion purges the source", async () => {
    const { batches, db, state } = legacyScanOwnershipDb();
    const repository = new ScanRepository(
      db,
      () => "2026-07-19T00:02:00.000Z",
      "access-subject-123",
    );
    const deletedKeys: string[] = [];

    await expect(
      repository.authorizeScan("scan-1", "scan-token-hash"),
    ).resolves.toMatchObject({ ownerSubject: "access-subject-123" });
    expect(state).toMatchObject({
      scanOwner: "access-subject-123",
      uploadOwner: "access-subject-123",
    });
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.query).toContain("UPDATE scan_sessions");
    expect(batches[0]?.[1]?.query).toContain("UPDATE upload_intents");

    state.scanStatus = "deleted";
    await purgeDeletedScan(
      {
        DB: db,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => null,
          head: async () => null,
          delete: async (key: string) => {
            deletedKeys.push(key);
          },
          list: async () => ({ objects: [], truncated: false }),
        },
      } as ScanEnv,
      repository,
      "scan-1",
    );

    expect(deletedKeys).toContain("incoming/upload-1/source.txt");
  });

  it("atomically adopts an identical ownerless Scan create retry", async () => {
    const { batches, db, state } = legacyScanOwnershipDb();
    const repository = new ScanRepository(db, undefined, "access-subject-123");

    await expect(
      repository.createScan({
        id: "scan-1",
        uploadId: "upload-1",
        mode: "quick",
        reservedUnits: 1,
        accessTokenHash: "scan-token-hash",
        uploadTokenHash: "upload-token-hash",
        buckets: [],
        aiConsent: consent,
      }),
    ).resolves.toBe("existing");
    expect(state).toMatchObject({
      scanOwner: "access-subject-123",
      uploadOwner: "access-subject-123",
    });
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.query).toContain("access_token_hash = ?");
    expect(batches[0]?.[0]?.query).toContain("upload_id = ?");
    expect(batches[0]?.[0]?.query).toContain("mode = ?");
    expect(batches[0]?.[0]?.query).toContain("ai_consent_id = ?");
  });

  it.each([
    {
      label: "wrong Scan capability",
      input: { accessTokenHash: "wrong-scan-token-hash" },
    },
    {
      label: "different upload",
      input: { uploadId: "upload-2" },
    },
    { label: "different mode", input: { mode: "full" as const } },
    {
      label: "different consent",
      input: {
        aiConsent: { ...consent, policyVersion: "2026-07-20.1" },
      },
    },
  ])("rejects an ownerless Scan retry with $label", async ({ input }) => {
    const { db, state } = legacyScanOwnershipDb();
    const repository = new ScanRepository(db, undefined, "access-subject-123");

    await expect(
      repository.createScan({
        id: "scan-1",
        uploadId: "upload-1",
        mode: "quick",
        reservedUnits: 1,
        accessTokenHash: "scan-token-hash",
        uploadTokenHash: "upload-token-hash",
        buckets: [],
        aiConsent: consent,
        ...input,
      }),
    ).resolves.toBe("conflict");
    expect(state).toMatchObject({ scanOwner: null, uploadOwner: null });
  });

  it("lets only one account adopt the same ownerless Scan retry", async () => {
    const { db, state } = legacyScanOwnershipDb();
    const first = new ScanRepository(db, undefined, "access-subject-first");
    const second = new ScanRepository(db, undefined, "access-subject-second");
    const input = {
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick" as const,
      reservedUnits: 1,
      accessTokenHash: "scan-token-hash",
      uploadTokenHash: "upload-token-hash",
      buckets: [],
      aiConsent: consent,
    };

    const results = await Promise.all([
      first.createScan(input),
      second.createScan(input),
    ]);

    expect(results.filter((result) => result === "existing")).toHaveLength(1);
    expect(results.filter((result) => result === "conflict")).toHaveLength(1);
    expect(state.scanOwner).toBe(state.uploadOwner);
    expect(["access-subject-first", "access-subject-second"]).toContain(
      state.scanOwner,
    );
  });

  it("authorizes an already-owned Scan without entering the D1 write path", async () => {
    const persisted = {
      id: "scan-1",
      upload_id: "upload-1",
      access_token_hash: "scan-token-hash",
      mode: "quick",
      status: "completed",
      source_hash: "source-hash",
      private_bundle_key: "artifacts/scan-1/bundle.json",
      private_report_key: "artifacts/scan-1/report.json",
      cancel_requested_at: null,
      owner_subject: "access-subject-123",
      ai_consent_id: consent.consentId,
      ai_consent_policy_version: consent.policyVersion,
      ai_consent_provider: consent.provider,
      ai_consent_route: consent.route,
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:01:00.000Z",
    };
    const { db, prepared } = recordingDb(persisted);
    const repository = new ScanRepository(db, undefined, "access-subject-123");

    await expect(
      repository.authorizeScan("scan-1", "scan-token-hash"),
    ).resolves.toMatchObject({
      id: "scan-1",
      ownerSubject: "access-subject-123",
    });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.query).toContain("owner_subject = ?");
    expect(prepared[0]?.query).not.toContain("UPDATE scan_sessions");
  });

  it("atomically claims an uploaded legacy intent only with its capability", async () => {
    const { db, prepared } = recordingDb();
    const repository = new ScanRepository(
      db,
      () => "2026-07-19T00:00:00.000Z",
      "access-subject-123",
    );

    await repository.authorizeCompletedUpload("upload-1", "upload-token-hash");

    const claim = prepared.find(
      ({ query }) =>
        query.includes("UPDATE upload_intents") &&
        query.includes("RETURNING id"),
    );
    expect(claim?.query).toContain("token_hash = ?");
    expect(claim?.query).toContain("status = 'uploaded'");
    expect(claim?.query).toContain("owner_subject IS NULL");
    expect(claim?.values).toEqual(
      expect.arrayContaining([
        "access-subject-123",
        "upload-1",
        "upload-token-hash",
      ]),
    );
  });

  it("claims a legacy Editor token, its Scan, and parent Upload in one transactional batch", async () => {
    const { db, prepared, batches } = recordingDb();
    const repository = new ScanRepository(
      db,
      () => "2026-07-19T00:00:00.000Z",
      "access-subject-123",
    );

    await repository.getEditorToken("editor-token-hash");

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    const tokenClaim = prepared.find(({ query }) =>
      query.includes("UPDATE editor_tokens"),
    );
    const scanClaim = prepared.find(
      ({ query }) =>
        query.includes("UPDATE scan_sessions") &&
        query.includes("FROM editor_tokens"),
    );
    const uploadClaim = prepared.find(
      ({ query }) =>
        query.includes("UPDATE upload_intents") &&
        query.includes("FROM editor_tokens"),
    );
    expect(tokenClaim?.query).toContain("token_hash = ?");
    expect(tokenClaim?.query).toContain("consumed_at IS NULL");
    expect(tokenClaim?.query).toContain("expires_at > ?");
    expect(tokenClaim?.query).toContain(
      "(owner_subject = ? OR owner_subject IS NULL)",
    );
    expect(tokenClaim?.query).toContain(
      "(scan_sessions.owner_subject = ? OR scan_sessions.owner_subject IS NULL)",
    );
    expect(scanClaim?.query).toContain("editor_tokens.owner_subject = ?");
    expect(scanClaim?.values).toEqual(
      expect.arrayContaining(["access-subject-123", "editor-token-hash"]),
    );
    expect(uploadClaim?.query).toContain("scan_sessions.owner_subject = ?");
    expect(uploadClaim?.query).toContain("editor_tokens.owner_subject = ?");
    const authorizedRead = prepared.at(-1);
    expect(authorizedRead?.query).toContain("editor_tokens.owner_subject = ?");
    expect(authorizedRead?.query).toContain("scan_sessions.owner_subject = ?");
    expect(authorizedRead?.query).toContain("upload_intents.owner_subject = ?");
  });

  it("claims a legacy Editor session, its Scan, and parent Upload in one transactional batch", async () => {
    const { db, prepared, batches } = recordingDb();
    const repository = new ScanRepository(
      db,
      () => "2026-07-19T00:00:00.000Z",
      "access-subject-123",
    );

    await repository.authorizeEditorSession(
      "scan-1",
      "editor-session-token-hash",
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    const sessionClaim = prepared.find(({ query }) =>
      query.includes("UPDATE editor_sessions"),
    );
    const scanClaim = prepared.find(
      ({ query }) =>
        query.includes("UPDATE scan_sessions") &&
        query.includes("FROM editor_sessions"),
    );
    const uploadClaim = prepared.find(
      ({ query }) =>
        query.includes("UPDATE upload_intents") &&
        query.includes("FROM editor_sessions"),
    );
    expect(sessionClaim?.query).toContain("editor_sessions.token_hash = ?");
    expect(sessionClaim?.query).toContain("editor_sessions.scan_id = ?");
    expect(sessionClaim?.query).toContain("revoked_at IS NULL");
    expect(sessionClaim?.query).toContain("expires_at > ?");
    expect(sessionClaim?.query).toContain(
      "(owner_subject = ? OR owner_subject IS NULL)",
    );
    expect(scanClaim?.query).toContain("editor_sessions.owner_subject = ?");
    expect(scanClaim?.values).toEqual(
      expect.arrayContaining([
        "access-subject-123",
        "scan-1",
        "editor-session-token-hash",
      ]),
    );
    expect(uploadClaim?.query).toContain("scan_sessions.owner_subject = ?");
    expect(uploadClaim?.query).toContain("editor_sessions.owner_subject = ?");
    const authorizedRead = prepared.at(-1);
    expect(authorizedRead?.query).toContain(
      "editor_sessions.owner_subject = ?",
    );
    expect(authorizedRead?.query).toContain("scan_sessions.owner_subject = ?");
    expect(authorizedRead?.query).toContain("upload_intents.owner_subject = ?");
  });

  it("persists the account owner on new Editor tokens and sessions", async () => {
    const { db, prepared } = recordingDb();
    const repository = new ScanRepository(
      db,
      () => "2026-07-19T00:00:00.000Z",
      "access-subject-123",
    );

    await repository.createEditorToken({
      tokenHash: "editor-token-hash",
      scanId: "scan-1",
      artifactKey: "artifacts/scan-1/bundle.json",
      expiresAt: "2026-07-20T00:00:00.000Z",
    });
    await repository.createEditorSession({
      tokenHash: "editor-session-token-hash",
      scanId: "scan-1",
      expiresAt: "2026-07-20T00:00:00.000Z",
    });

    const tokenInsert = prepared.find(({ query }) =>
      query.includes("INSERT INTO editor_tokens"),
    );
    const sessionInsert = prepared.find(({ query }) =>
      query.includes("INSERT INTO editor_sessions"),
    );
    expect(tokenInsert?.query).toContain("owner_subject");
    expect(tokenInsert?.values).toContain("access-subject-123");
    expect(sessionInsert?.query).toContain("owner_subject");
    expect(sessionInsert?.values).toContain("access-subject-123");
  });

  it("lets only one account win an ownerless uploaded capability race", async () => {
    const { db, state } = racingCapabilityDb();
    const first = new ScanRepository(db, undefined, "access-subject-first");
    const second = new ScanRepository(db, undefined, "access-subject-second");

    const results = await Promise.all([
      first.authorizeCompletedUpload("upload-1", "upload-token-hash"),
      second.authorizeCompletedUpload("upload-1", "upload-token-hash"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.ownerSubject).toBe(state.uploadOwner);
    expect(["access-subject-first", "access-subject-second"]).toContain(
      state.uploadOwner,
    );
  });

  it("does not claim an uploaded intent for the wrong capability", async () => {
    const { db, state } = racingCapabilityDb();
    const repository = new ScanRepository(
      db,
      undefined,
      "access-subject-attacker",
    );

    await expect(
      repository.authorizeCompletedUpload("upload-1", "wrong-token-hash"),
    ).resolves.toBeNull();
    expect(state.uploadOwner).toBeNull();
  });

  it("lets only one account claim a legacy Editor token, Scan, and Upload", async () => {
    const { db, state } = racingCapabilityDb();
    const first = new ScanRepository(db, undefined, "access-subject-first");
    const second = new ScanRepository(db, undefined, "access-subject-second");

    const results = await Promise.all([
      first.getEditorToken("editor-token-hash"),
      second.getEditorToken("editor-token-hash"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(state.editorTokenOwner).toBe(state.scanOwner);
    expect(state.editorTokenOwner).toBe(state.uploadOwner);
    expect(["access-subject-first", "access-subject-second"]).toContain(
      state.editorTokenOwner,
    );
  });

  it("lets only one account claim a legacy Editor session, Scan, and Upload", async () => {
    const { db, state } = racingCapabilityDb();
    const first = new ScanRepository(db, undefined, "access-subject-first");
    const second = new ScanRepository(db, undefined, "access-subject-second");

    const results = await Promise.all([
      first.authorizeEditorSession("scan-1", "editor-session-token-hash"),
      second.authorizeEditorSession("scan-1", "editor-session-token-hash"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(state.editorSessionOwner).toBe(state.scanOwner);
    expect(state.editorSessionOwner).toBe(state.uploadOwner);
    expect(["access-subject-first", "access-subject-second"]).toContain(
      state.editorSessionOwner,
    );
  });

  it("does not split a legacy Editor token graph from an Upload owned by another account", async () => {
    const { db, state } = racingCapabilityDb();
    state.uploadOwner = "access-subject-owner";
    const attacker = new ScanRepository(
      db,
      undefined,
      "access-subject-attacker",
    );

    await expect(
      attacker.getEditorToken("editor-token-hash"),
    ).resolves.toBeNull();
    expect(state.uploadOwner).toBe("access-subject-owner");
    expect(state.scanOwner).toBeNull();
    expect(state.editorTokenOwner).toBeNull();
  });

  it("does not split a legacy Editor session graph from an Upload owned by another account", async () => {
    const { db, state } = racingCapabilityDb();
    state.uploadOwner = "access-subject-owner";
    const attacker = new ScanRepository(
      db,
      undefined,
      "access-subject-attacker",
    );

    await expect(
      attacker.authorizeEditorSession("scan-1", "editor-session-token-hash"),
    ).resolves.toBeNull();
    expect(state.uploadOwner).toBe("access-subject-owner");
    expect(state.scanOwner).toBeNull();
    expect(state.editorSessionOwner).toBeNull();
  });
});
