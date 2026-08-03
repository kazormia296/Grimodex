import { afterEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sql.js/dist/sql-asm.js has no dedicated type declarations
import initSqlJs from "sql.js/dist/sql-asm.js";

import {
  verifyChain,
  type EventForVerify,
} from "@/features/timelapse/hashChain";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

const owned: PersistentBrowserMock[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (owned.length > 0) owned.pop()?.close();
});

function delayNextWebCryptoDigest() {
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let resolveStarted: () => void = () => undefined;
  let releaseDigest: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseDigest = resolve;
  });
  let shouldDelay = true;
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (algorithm, data) => {
      if (shouldDelay) {
        shouldDelay = false;
        resolveStarted();
        await gate;
      }
      return originalDigest(algorithm, data);
    });
  return {
    started,
    release: releaseDigest,
    restore() {
      releaseDigest();
      spy.mockRestore();
    },
  };
}

function auditEvent(
  eventId: string,
  eventType: string,
  timestamp: number,
  executionId = "execution-1",
) {
  return {
    eventId,
    executionId,
    operationId: "operation-1",
    parentExecutionId: null,
    pathId: "browser_byok_web",
    eventType,
    timestamp,
    payload: {
      captureState: "complete",
      credentialsExcluded: true,
      request: { messages: [{ role: "user", content: `prompt:${eventId}` }] },
    },
  };
}

async function legacyProjectOwnedAuditDatabase() {
  const expectedWorkspacePath = "/dev/workspace";
  const event = auditEvent("legacy-project-event", "execution.started", 1);
  const source = await createBrowserMock({
    workspaceIdentity: expectedWorkspacePath,
  });
  const now = new Date().toISOString();
  await source.invoke("db_execute", {
    sql: "INSERT INTO projects (id, title, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    params: ["doomed-project", "Doomed", "ja", now, now],
    method: "run",
  });
  await source.invoke("ai_audit_append_batch", {
    expectedWorkspacePath,
    projectId: "default-project",
    events: [event],
  });
  await source.invoke("ai_audit_append_batch", {
    expectedWorkspacePath,
    projectId: "doomed-project",
    events: [
      auditEvent(
        "legacy-doomed-high-water",
        "execution.started",
        2,
        "execution-doomed",
      ),
    ],
  });
  const snapshot = await source.invoke<{ highWaterHash: string }>(
    "ai_audit_read_snapshot",
    {
      expectedWorkspacePath,
      projectId: "default-project",
    },
  );
  const currentBytes = source.exportDatabase();
  source.close();

  const SQL = await initSqlJs();
  const database = new SQL.Database(currentBytes);
  database.run(`PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE grimodex_ai_audit_events_with_project_fk (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id            TEXT NOT NULL,
      project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
      sequence            INTEGER NOT NULL,
      event_id            TEXT NOT NULL,
      execution_id        TEXT NOT NULL,
      operation_id        TEXT NOT NULL,
      parent_execution_id TEXT,
      path_id             TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      timestamp           INTEGER NOT NULL,
      recorded_at         INTEGER NOT NULL,
      payload             TEXT NOT NULL,
      payload_sha256      TEXT NOT NULL,
      prev_hash           TEXT NOT NULL,
      hash                TEXT NOT NULL,
      CHECK (
        (scope_id = 'workspace' AND project_id IS NULL)
        OR
        (project_id IS NOT NULL AND scope_id = 'project:' || project_id)
      )
    );
    INSERT INTO grimodex_ai_audit_events_with_project_fk
      SELECT * FROM ai_audit_events;
    DROP TABLE ai_audit_events;
    ALTER TABLE grimodex_ai_audit_events_with_project_fk
      RENAME TO ai_audit_events;
    CREATE UNIQUE INDEX uq_ai_audit_scope_seq
      ON ai_audit_events(scope_id, sequence);
    CREATE UNIQUE INDEX uq_ai_audit_scope_event
      ON ai_audit_events(scope_id, event_id);
    CREATE INDEX idx_ai_audit_scope_execution
      ON ai_audit_events(scope_id, execution_id, sequence);
    CREATE INDEX idx_ai_audit_scope_execution_event_type
      ON ai_audit_events(scope_id, execution_id, event_type);
    CREATE INDEX idx_ai_audit_scope_operation
      ON ai_audit_events(scope_id, operation_id, sequence);
    CREATE INDEX idx_ai_audit_scope_timestamp
      ON ai_audit_events(scope_id, timestamp, sequence);
    COMMIT;
    PRAGMA foreign_keys = ON;`);
  database.run("DELETE FROM projects WHERE id = 'doomed-project'");
  expect(
    database.exec("PRAGMA foreign_key_list(ai_audit_events)")[0]?.values,
  ).toHaveLength(1);
  expect(
    database.exec(
      "SELECT seq FROM sqlite_sequence WHERE name = 'ai_audit_events'",
    )[0]?.values,
  ).toEqual([[2]]);
  expect(
    database.exec("SELECT MAX(id) FROM ai_audit_events")[0]?.values,
  ).toEqual([[1]]);
  const bytes = database.export();
  database.close();
  return { bytes, event, highWaterHash: snapshot.highWaterHash };
}

describe("BrowserMock AI audit ledger", () => {
  it("migrates the legacy project FK without changing rows, chain, or replay idempotency", async () => {
    const legacy = await legacyProjectOwnedAuditDatabase();
    const dirty = vi.fn();
    const migrated = await createBrowserMock({
      databaseBytes: legacy.bytes,
      workspaceIdentity: "/dev/workspace",
      onDatabaseDirty: dirty,
    });
    owned.push(migrated);

    await expect(
      migrated.invoke("db_execute", {
        sql: 'SELECT "table", "from" FROM pragma_foreign_key_list(?)',
        params: ["ai_audit_events"],
        method: "all",
      }),
    ).resolves.toMatchObject({ rows: [] });
    const indexResult = await migrated.invoke<{
      rows: Array<{ name: string }>;
    }>("db_execute", {
      sql: "SELECT name FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name",
      params: ["ai_audit_events"],
      method: "all",
    });
    expect(indexResult.rows.map(({ name }) => name)).toEqual([
      "idx_ai_audit_scope_execution",
      "idx_ai_audit_scope_execution_event_type",
      "idx_ai_audit_scope_operation",
      "idx_ai_audit_scope_timestamp",
      "uq_ai_audit_scope_event",
      "uq_ai_audit_scope_seq",
    ]);
    await expect(
      migrated.invoke("ai_audit_verify", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
      }),
    ).resolves.toMatchObject({
      ok: true,
      verifiedThroughSequence: 1,
      tailHash: legacy.highWaterHash,
    });
    await expect(
      migrated.invoke("ai_audit_append_batch", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        events: [legacy.event],
      }),
    ).resolves.toMatchObject({
      insertedCount: 0,
      tailSequence: 1,
      tailHash: legacy.highWaterHash,
    });
    expect(dirty).toHaveBeenCalledOnce();

    await migrated.invoke("ai_audit_append_batch", {
      expectedWorkspacePath: "/dev/workspace",
      projectId: "missing-project",
      events: [
        auditEvent(
          "post-migration-id",
          "execution.started",
          3,
          "execution-post-migration",
        ),
      ],
    });
    await expect(
      migrated.invoke("db_execute", {
        sql: "SELECT id FROM ai_audit_events WHERE event_id = ?",
        params: ["post-migration-id"],
        method: "get",
      }),
    ).resolves.toMatchObject({ rows: [{ id: 3 }] });

    const migratedBytes = migrated.exportDatabase();
    const reopenDirty = vi.fn();
    const reopened = await createBrowserMock({
      databaseBytes: migratedBytes,
      workspaceIdentity: "/dev/workspace",
      onDatabaseDirty: reopenDirty,
    });
    owned.push(reopened);
    expect(reopenDirty).not.toHaveBeenCalled();
  });

  it("does not resolve an audit append before its persistent durability ACK", async () => {
    let releaseDurability!: () => void;
    let markDurabilityStarted!: () => void;
    const durabilityGate = new Promise<void>((resolve) => {
      releaseDurability = resolve;
    });
    const durabilityStarted = new Promise<void>((resolve) => {
      markDurabilityStarted = resolve;
    });
    let journalBatch:
      | {
          batchId: string;
          appendArgsJson: string;
        }
      | undefined;
    const onAiAuditDurabilityRequired = vi.fn(
      async (batch: { batchId: string; appendArgsJson: string }) => {
        journalBatch = batch;
        markDurabilityStarted();
        await durabilityGate;
      },
    );
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
      onAiAuditDurabilityRequired,
    });
    owned.push(mock);
    let appendAcknowledged = false;

    const append = mock
      .invoke("ai_audit_append_batch", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        events: [auditEvent("durability-gate", "execution.started", 1)],
      })
      .then((result) => {
        appendAcknowledged = true;
        return result;
      });
    await durabilityStarted;
    expect(appendAcknowledged).toBe(false);
    expect(journalBatch?.batchId).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(journalBatch!.appendArgsJson)).toMatchObject({
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
      events: [expect.objectContaining({ eventId: "durability-gate" })],
    });

    releaseDurability();
    await expect(append).resolves.toMatchObject({ insertedCount: 1 });
    expect(appendAcknowledged).toBe(true);
  });

  it("restores the materialized journal rows exactly after a snapshot crash", async () => {
    let journalBatch: { batchId: string; appendArgsJson: string } | undefined;
    const source = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
      onAiAuditDurabilityRequired: async (batch) => {
        journalBatch = batch;
      },
    });
    owned.push(source);
    // This is the last snapshot that existed before the append ACK reached
    // IndexedDB. The journal is the only durable record of the following rows.
    const preAppendSnapshot = source.exportDatabase();
    const events = [
      auditEvent("crash-start", "execution.started", 1),
      auditEvent("crash-prepared", "request.prepared", 2),
      auditEvent("crash-dispatched", "request.dispatched", 3),
    ];
    await source.invoke("ai_audit_append_batch", {
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
      events,
    });
    const sourceSnapshot = await source.invoke<{
      highWaterHash: string;
      events: unknown[];
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
    });
    expect(journalBatch).toBeDefined();
    const materialized = JSON.parse(journalBatch!.appendArgsJson) as {
      journalVersion: number;
      events: Array<{
        recordedAt: number;
        payloadSha256: string;
        prevHash: string;
        hash: string;
      }>;
    };
    expect(materialized.journalVersion).toBe(1);
    expect(materialized.events.every((event) => event.recordedAt > 0)).toBe(
      true,
    );
    const recovered = await createBrowserMock({
      databaseBytes: preAppendSnapshot,
      workspaceIdentity: "/dev/workspace",
    });
    owned.push(recovered);
    await recovered.invoke(
      "ai_audit_restore_batch",
      JSON.parse(journalBatch!.appendArgsJson),
    );
    const recoveredSnapshot = await recovered.invoke<{
      highWaterHash: string;
      events: unknown[];
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
    });

    expect(recoveredSnapshot).toEqual(sourceSnapshot);
  });

  it("does not fetch when the durable journal ACK rejects before dispatch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const journalError = new Error("AI audit journal is unavailable");
      const mock = await createBrowserMock({
        workspaceIdentity: "/dev/workspace",
        onAiAuditDurabilityRequired: async () => {
          throw journalError;
        },
        authorizeAiRequest: async () => undefined,
      });
      owned.push(mock);

      const auditedDispatch = async () => {
        await mock.invoke("ai_audit_append_batch", {
          expectedWorkspacePath: "/dev/workspace",
          projectId: "default-project",
          events: [auditEvent("journal-reject-fetch", "execution.started", 1)],
        });
        return mock.invoke("send_chat_message", {
          provider: "anthropic",
          model: "claude-test",
          apiKey: "runtime-only-test-key",
          messages: [{ role: "user", content: "must not fetch" }],
        });
      };

      await expect(auditedDispatch()).rejects.toBe(journalError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("durably receipts the complete JSON value parsed from the Browser fetch body", async () => {
    const secret = "sk-browser-header-only-secret";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "provider ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let durabilityCallCount = 0;
    let releaseReceipt!: () => void;
    let markReceiptStarted!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const receiptStarted = new Promise<void>((resolve) => {
      markReceiptStarted = resolve;
    });
    const journalBodies: string[] = [];
    try {
      const mock = await createBrowserMock({
        workspaceIdentity: "/dev/workspace",
        authorizeAiRequest: async () => undefined,
        onAiAuditDurabilityRequired: async (batch) => {
          durabilityCallCount += 1;
          journalBodies.push(batch.appendArgsJson);
          if (durabilityCallCount === 2) {
            markReceiptStarted();
            await receiptGate;
          }
        },
      });
      owned.push(mock);
      await mock.invoke("save_api_key", { provider: "openai", key: secret });
      const context = {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        operationId: "operation-effective-body",
        executionId: "execution-effective-body",
        parentExecutionId: null,
        pathId: "browser_byok_web",
      } as const;
      await mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath: context.expectedWorkspacePath,
        projectId: context.projectId,
        events: [
          auditEvent(
            "effective-started",
            "execution.started",
            1,
            context.executionId,
          ),
          auditEvent(
            "effective-logical-request",
            "request.prepared",
            2,
            context.executionId,
          ),
          auditEvent(
            "effective-dispatched",
            "request.dispatched",
            3,
            context.executionId,
          ),
        ].map((event) => ({
          ...event,
          operationId: context.operationId,
          pathId: context.pathId,
        })),
      });

      const running = mock.invoke("send_chat_message", {
        provider: "openai",
        model: "gpt-effective",
        messages: [
          { role: "system", content: "exact system" },
          { role: "user", content: "exact user" },
        ],
        requestMaxOutputTokens: 77,
        auditContext: context,
      });

      await receiptStarted;
      expect(fetchMock).not.toHaveBeenCalled();
      expect(journalBodies[1]).not.toContain(secret);
      const journalReceipt = JSON.parse(journalBodies[1]) as {
        events: Array<{ payload: Record<string, unknown> }>;
      };
      expect(journalReceipt.events[0].payload).toMatchObject({
        captureState: "complete",
        credentialsExcluded: true,
        effectiveRequestReceipt: true,
        request: {
          provider: "openai",
          model: "gpt-effective",
          body: {
            model: "gpt-effective",
            max_tokens: 77,
            messages: [
              { role: "system", content: "exact system" },
              { role: "user", content: "exact user" },
            ],
          },
          auditMetadata: {
            bodyObservation: {
              representation: "parsed-json-value",
              sourceBodyJsonEqualsFetchBody: true,
              serializedBytesPreserved: false,
              serializationWhitespacePreserved: false,
              serializationKeyOrderPreserved: false,
            },
            routeObservation: {
              captureState: "complete",
              provider: "openai",
              model: "gpt-effective",
              apiVariant: null,
              endpointId: null,
              endpointOrigin: null,
              transportEffectiveRouteObserved: true,
              resolutionBoundary: "browser_final_body_json_value",
            },
          },
        },
      });
      expect(
        (journalReceipt.events[0].payload.request as Record<string, unknown>)
          .options,
      ).toBeUndefined();
      expect(
        (journalReceipt.events[0].payload.request as Record<string, unknown>)
          .bodyJson,
      ).toBeUndefined();

      releaseReceipt();
      await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(fetchMock).toHaveBeenCalledOnce();
      const providerBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      const snapshot = await mock.invoke<{
        events: Array<{
          executionId: string;
          eventType: string;
          payload: Record<string, unknown>;
        }>;
      }>("ai_audit_read_snapshot", {
        expectedWorkspacePath: context.expectedWorkspacePath,
        projectId: context.projectId,
        afterSequence: 0,
      });
      const receipt = snapshot.events.find(
        (event) =>
          event.executionId === context.executionId &&
          event.eventType === "request.prepared" &&
          event.payload.effectiveRequestReceipt === true,
      );
      expect(receipt).toBeDefined();
      expect((receipt?.payload.request as { body: unknown }).body).toEqual(
        providerBody,
      );
      expect(JSON.stringify(receipt)).not.toContain(secret);
    } finally {
      releaseReceipt?.();
      vi.unstubAllGlobals();
    }
  });

  it("blocks Browser AI dispatch across a rejected append and exact retry until durability succeeds", async () => {
    const complete = vi.fn(async () => ({
      blocks: [{ type: "text" as const, content: "must wait" }],
      stopReason: "end_turn" as const,
    }));
    const onDatabaseDirty = vi.fn();
    const durabilityError = new Error("IndexedDB flush rejected");
    let persistenceBlocked = true;
    const onAiAuditDurabilityRequired = vi.fn(async () => {
      if (persistenceBlocked) throw durabilityError;
    });
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
      onDatabaseDirty,
      onAiAuditDurabilityRequired,
      authorizeAiRequest: async () => undefined,
      aiTransport: { complete },
    });
    owned.push(mock);
    const context = {
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
      operationId: "operation-1",
      executionId: "execution-1",
      parentExecutionId: null,
      pathId: "browser_byok_web",
    } as const;
    const events = [
      auditEvent("durability-retry-start", "execution.started", 1),
      auditEvent("durability-retry-prepared", "request.prepared", 2),
      auditEvent("durability-retry-dispatched", "request.dispatched", 3),
    ];
    const auditedDispatch = async () => {
      await mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        events,
      });
      return mock.invoke("send_chat_message", {
        provider: "ollama",
        model: "gpt-test",
        messages: [{ role: "user", content: "must not send early" }],
        auditContext: context,
      });
    };

    await expect(auditedDispatch()).rejects.toBe(durabilityError);
    expect(complete).not.toHaveBeenCalled();
    expect(onDatabaseDirty).toHaveBeenCalledOnce();

    // The row already exists in sql.js, so this exact retry inserts zero rows.
    // The durability barrier must nevertheless run and keep dispatch blocked.
    await expect(auditedDispatch()).rejects.toBe(durabilityError);
    expect(complete).not.toHaveBeenCalled();
    expect(onDatabaseDirty).toHaveBeenCalledOnce();
    expect(onAiAuditDurabilityRequired).toHaveBeenCalledTimes(2);

    persistenceBlocked = false;
    await expect(auditedDispatch()).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(onAiAuditDurabilityRequired).toHaveBeenCalledTimes(3);
  });

  it("rejects non-trimmed or mismatched stream correlation before Browser AI dispatch", async () => {
    const stream = vi.fn(async (): Promise<void> => undefined);
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
      authorizeAiRequest: async () => undefined,
      aiTransport: {
        complete: async () => ({ blocks: [], stopReason: "end_turn" }),
        stream,
      },
    });
    owned.push(mock);

    await expect(
      mock.invoke("send_chat_message_stream", {
        streamId: " stream-1 ",
        auditContext: { executionId: " stream-1 " },
      }),
    ).rejects.toThrow(/trimmed non-empty/iu);
    await expect(
      mock.invoke("send_chat_message_stream", {
        streamId: "stream-1",
        auditContext: {
          expectedWorkspacePath: "/dev/workspace",
          projectId: "default-project",
          operationId: "operation-stream-2",
          executionId: "stream-2",
          parentExecutionId: null,
          pathId: "browser_byok_web",
        },
      }),
    ).rejects.toThrow(/match auditContext\.executionId/iu);
    expect(stream).not.toHaveBeenCalled();
  });

  it.each([
    ["test_ai_connection", { provider: "ollama" }],
    ["send_chat_message", { provider: "ollama", model: "model" }],
    [
      "send_agent_message",
      { provider: "ollama", model: "model", messages: [], tools: [] },
    ],
    [
      "send_chat_message_stream",
      { streamId: "missing-chat-context", provider: "ollama", model: "model" },
    ],
    [
      "send_inline_ai_stream",
      {
        streamId: "missing-inline-context",
        provider: "ollama",
        model: "model",
      },
    ],
  ])(
    "requires exact audit context for Browser inference command %s",
    async (command, args) => {
      const complete = vi.fn(async () => ({
        blocks: [],
        stopReason: "end_turn" as const,
      }));
      const stream = vi.fn(async () => undefined);
      const mock = await createBrowserMock({
        workspaceIdentity: "/dev/workspace",
        authorizeAiRequest: async () => undefined,
        aiTransport: { complete, stream },
      });
      owned.push(mock);

      await expect(mock.invoke(command, args)).rejects.toThrow(
        /auditContext/iu,
      );
      expect(complete).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    },
  );

  it("rejects forged audit context fields and missing durable dispatch lifecycle", async () => {
    const complete = vi.fn(async () => ({
      blocks: [],
      stopReason: "end_turn" as const,
    }));
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
      authorizeAiRequest: async () => undefined,
      aiTransport: { complete },
    });
    owned.push(mock);
    const context = {
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
      operationId: "operation-forged",
      executionId: "execution-forged",
      parentExecutionId: null,
      pathId: "browser_byok_web",
    } as const;

    await expect(
      mock.invoke("send_chat_message", {
        provider: "ollama",
        model: "model",
        auditContext: { ...context, unexpected: true },
      }),
    ).rejects.toThrow(/exact auditContext fields/iu);
    await expect(
      mock.invoke("send_chat_message", {
        provider: "ollama",
        model: "model",
        auditContext: context,
      }),
    ).rejects.toThrow(/AI_AUDIT_DISPATCH_PRECONDITION_FAILED/iu);
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts the exact semantic tokenizer contract keys without relaxing token credentials", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const event = auditEvent(
      "semantic-tokenizer-contract",
      "request.prepared",
      1,
    );
    const tokenizerContract = {
      tokenizerIdentity: {
        identityVersion: 1,
        fingerprintAlgorithm: "sha256",
        fileName: "tokenizer.json",
        sha256: "1".repeat(64),
        byteLength: 1234,
      },
      tokenizerIdentityStatus: "loaded-and-fingerprinted",
      tokenizationCapture: {
        realizedTokenIds: "not-retained",
      },
      tokenization: {
        queryTokensBefore: 5,
        queryTokensAfter: 5,
      },
      tokenizerAddsSpecialTokens: true,
      tokenizerMayTruncateAt: 512,
    };

    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          auditEvent("semantic-tokenizer-start", "execution.started", 0),
          {
            ...event,
            payload: {
              ...event.payload,
              metadata: tokenizerContract,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ insertedCount: 2 });
    const snapshot = await mock.invoke<{
      events: Array<{ payload: Record<string, unknown> }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
    });
    expect(snapshot.events[1]?.payload).toMatchObject({
      metadata: tokenizerContract,
    });
  });

  it.each([
    "apiKey",
    "OPENAI_API_KEY",
    "PRIVATE_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "ANTHROPIC_ACCESS_TOKEN",
    "github_token",
    "token_github",
    "smtp_password",
    "provider_passwd",
    "client_secret",
    "secret_anthropic",
    "session_cookie",
    "proxy_authorization",
    "auth",
    "openaiAuth",
    "auth_anthropic",
    "authentication",
    "providerAuthentication",
    "bearer",
    "tokenizerIdentitySecret",
    "tokenizerIdentityToken",
    "tokenizerIdentityExtra",
    "tokenizationCaptureBackup",
    "tokenizationAccessToken",
  ])("rejects transport credential metadata key %s", async (credentialKey) => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const event = auditEvent(
      `credential-${credentialKey}`,
      "request.prepared",
      1,
    );

    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          {
            ...event,
            payload: {
              ...event.payload,
              metadata: { [credentialKey]: "must-not-persist" },
            },
          },
        ],
      }),
    ).rejects.toThrow(/excluded transport credentials/iu);
  });

  it("preserves credential-like names inside model-visible messages and content", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const event = auditEvent("visible-credential-words", "request.prepared", 1);
    const fictionalContent = {
      apiKey: "fictional API key",
      PRIVATE_KEY: "fictional private key",
      AWS_ACCESS_KEY_ID: "fictional access key id",
      metadata: {
        access_token: "fictional token",
        password: "fictional password",
        secret: "fictional secret",
        cookie: "fictional cookie",
        authorization: "fictional authorization",
      },
    };

    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          auditEvent("visible-credential-start", "execution.started", 0),
          {
            ...event,
            payload: {
              ...event.payload,
              usage: { tokenUsage: 3, tokens: 3 },
              metadata: {
                author: "fictional author",
                authority: "narrative authority",
                authenticity: "story theme",
              },
              request: {
                messages: [{ role: "user", content: fictionalContent }],
              },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ insertedCount: 2 });
    const snapshot = await mock.invoke<{
      events: Array<{ payload: Record<string, unknown> }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
    });
    expect(snapshot.events[1]?.payload).toMatchObject({
      usage: { tokenUsage: 3, tokens: 3 },
      metadata: {
        author: "fictional author",
        authority: "narrative authority",
        authenticity: "story theme",
      },
      request: {
        messages: [{ role: "user", content: fictionalContent }],
      },
    });
  });

  it.each([
    ["metadata.context", { metadata: { context: { apiKey: "secret" } } }],
    [
      "metadata.messages",
      {
        metadata: {
          messages: [{ toolUses: [{ input: { apiKey: "secret" } }] }],
        },
      },
    ],
    ["error.content", { error: { content: { authentication: "secret" } } }],
    ["diagnostic.body", { diagnostic: { body: { privateKey: "secret" } } }],
    [
      "effectiveRequestConfiguration.messages",
      {
        effectiveRequestConfiguration: {
          messages: [{ content: { auth: "secret" } }],
        },
      },
    ],
    [
      "request.options.context",
      { request: { options: { context: { accessToken: "secret" } } } },
    ],
    [
      "request.auditMetadata",
      { request: { auditMetadata: { apiKey: "secret" } } },
    ],
    ["request.legacy-context", { request: { context: { apiKey: "secret" } } }],
  ])(
    "rejects credential-shaped data under non-visible %s",
    async (_path, forbiddenPayload) => {
      const expectedWorkspacePath = "/dev/workspace";
      const mock = await createBrowserMock({
        workspaceIdentity: expectedWorkspacePath,
      });
      owned.push(mock);
      const event = auditEvent(
        `non-visible-${String(_path)}`,
        "request.prepared",
        1,
      );

      await expect(
        mock.invoke("ai_audit_append_batch", {
          expectedWorkspacePath,
          projectId: "default-project",
          events: [
            {
              ...event,
              payload: {
                ...event.payload,
                ...forbiddenPayload,
              },
            },
          ],
        }),
      ).rejects.toThrow(/excluded transport credentials/iu);
    },
  );

  it("preserves credential-shaped fiction under native input and observed response roots", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const semanticInput = {
      content: {
        apiKey: "fictional semantic API key",
        authentication: "fictional oath",
      },
    };
    const modelVisibleContext = {
      apiKey: "fictional contextual key",
      authentication: "fictional contextual oath",
    };
    const observedResponse = {
      block: {
        type: "tool_use",
        input: {
          headers: "fictional manuscript heading",
          privateKey: "fictional plot device",
        },
      },
    };
    const semanticEvent = auditEvent(
      "visible-native-input",
      "request.prepared",
      1,
      "execution-native-input",
    );
    const responseEvent = auditEvent(
      "visible-observed-response",
      "response.completed",
      5,
      "execution-observed-response",
    );

    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          auditEvent(
            "visible-native-start",
            "execution.started",
            0,
            "execution-native-input",
          ),
          {
            ...semanticEvent,
            payload: {
              ...semanticEvent.payload,
              input: semanticInput,
              request: {
                messages: [],
                modelVisibleContext,
              },
            },
          },
          auditEvent(
            "visible-response-start",
            "execution.started",
            2,
            "execution-observed-response",
          ),
          auditEvent(
            "visible-response-prepared",
            "request.prepared",
            3,
            "execution-observed-response",
          ),
          auditEvent(
            "visible-response-dispatched",
            "request.dispatched",
            4,
            "execution-observed-response",
          ),
          {
            ...responseEvent,
            payload: {
              captureState: "complete",
              response: observedResponse,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ insertedCount: 6 });
    const snapshot = await mock.invoke<{
      events: Array<{ payload: Record<string, unknown> }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
    });
    expect(snapshot.events).toHaveLength(6);
    expect(snapshot.events[1]?.payload).toMatchObject({
      input: semanticInput,
      request: { modelVisibleContext },
    });
    expect(snapshot.events[5]?.payload).toMatchObject({
      response: observedResponse,
    });
  });

  it("preserves assistant tool inputs and thinking blocks under declared request messages", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const event = auditEvent(
      "visible-assistant-message",
      "request.prepared",
      1,
      "execution-assistant-message",
    );
    const assistantMessage = {
      role: "assistant",
      content: "tool call follows",
      toolUses: [
        {
          id: "tool-1",
          name: "inspect_fiction",
          input: {
            apiKey: "fictional tool argument",
            authentication: "fictional oath",
          },
        },
      ],
      thinkingBlocks: [
        {
          thinking: {
            privateKey: "fictional hidden clue",
            accessToken: "fictional quest token",
          },
        },
      ],
    };

    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          auditEvent(
            "visible-assistant-start",
            "execution.started",
            0,
            "execution-assistant-message",
          ),
          {
            ...event,
            payload: {
              ...event.payload,
              request: { messages: [assistantMessage] },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ insertedCount: 2 });
    const snapshot = await mock.invoke<{
      events: Array<{ payload: Record<string, unknown> }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
    });
    expect(snapshot.events[1]?.payload).toMatchObject({
      request: { messages: [assistantMessage] },
    });
  });

  it("keeps runtime diagnostics credential-checked without narrowing other observed response data", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const diagnosticEvent = auditEvent(
      "runtime-diagnostic-secret",
      "response.partial",
      1,
      "execution-runtime-diagnostic",
    );

    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          {
            ...diagnosticEvent,
            payload: {
              captureState: "complete",
              response: {
                runtimeDiagnostic: {
                  body: { authentication: "must-not-persist" },
                },
              },
            },
          },
        ],
      }),
    ).rejects.toThrow(/excluded transport credentials/iu);

    const observedEvent = auditEvent(
      "runtime-observed-fiction",
      "response.partial",
      5,
      "execution-runtime-observed",
    );
    const runtimeEvent = {
      item: {
        error: {
          metadata: {
            apiKey: "fictional tool output",
          },
        },
      },
    };
    await expect(
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [
          auditEvent(
            "runtime-observed-start",
            "execution.started",
            2,
            "execution-runtime-observed",
          ),
          auditEvent(
            "runtime-observed-prepared",
            "request.prepared",
            3,
            "execution-runtime-observed",
          ),
          auditEvent(
            "runtime-observed-dispatched",
            "request.dispatched",
            4,
            "execution-runtime-observed",
          ),
          {
            ...observedEvent,
            payload: {
              captureState: "complete",
              response: { runtimeEvent },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ insertedCount: 4 });
    const snapshot = await mock.invoke<{
      events: Array<{ payload: Record<string, unknown> }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
    });
    expect(snapshot.events[3]?.payload).toMatchObject({
      response: { runtimeEvent },
    });
  });

  it("keeps a concurrent general mutation outside a rejected audit append transaction", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const original = auditEvent("event-collision", "execution.started", 1);
    await mock.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: [original],
    });

    const delayedDigest = delayNextWebCryptoDigest();
    const conflicting = {
      ...original,
      payload: {
        ...original.payload,
        request: {
          messages: [{ role: "user", content: "different prompt" }],
        },
      },
    };
    const appendOutcome = mock
      .invoke("ai_audit_append_batch", {
        expectedWorkspacePath,
        projectId: "default-project",
        events: [conflicting],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await delayedDigest.started;
    await mock.invoke("db_execute", {
      sql: "UPDATE projects SET title = ? WHERE id = ?",
      params: ["concurrent-mutation-kept", "default-project"],
      method: "run",
    });
    delayedDigest.release();
    const collision = await appendOutcome;
    delayedDigest.restore();

    expect(collision).toBeInstanceOf(Error);
    expect(String(collision)).toMatch(/eventId collision/iu);
    await expect(
      mock.invoke("db_execute", {
        sql: "SELECT title FROM projects WHERE id = ?",
        params: ["default-project"],
        method: "all",
      }),
    ).resolves.toMatchObject({
      rows: [{ title: "concurrent-mutation-kept" }],
    });
    await mock.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: [auditEvent("event-after-collision", "request.prepared", 2)],
    });
    await expect(
      mock.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: "default-project",
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 2 });
  });

  it("serializes AI audit and timelapse hashing without overlapping SQLite transactions", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const mock = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(mock);
    const delayedDigest = delayNextWebCryptoDigest();
    const auditAppend = mock.invoke<{
      insertedCount: number;
      tailSequence: number;
    }>("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: [auditEvent("event-ai-concurrent", "execution.started", 1)],
    });
    await delayedDigest.started;
    const timelapseAppend = mock.invoke<{
      insertedCount: number;
      tailSequence: number;
    }>("timelapse_append_batch", {
      projectId: "default-project",
      sessionId: "session-concurrent",
      events: [
        {
          eventUid: "timelapse-concurrent",
          sceneId: null,
          domain: "editor",
          opType: "step",
          entityType: null,
          entityId: null,
          payload: '{"i":1}',
          timestamp: 1_700_000_000_000,
        },
      ],
    });
    delayedDigest.release();
    const [auditResult, timelapseResult] = await Promise.all([
      auditAppend,
      timelapseAppend,
    ]);
    delayedDigest.restore();

    expect(auditResult).toMatchObject({ insertedCount: 1, tailSequence: 1 });
    expect(timelapseResult).toMatchObject({
      insertedCount: 1,
      tailSequence: 1,
    });
    await expect(
      mock.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: "default-project",
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 1 });
    const timelapseRows = await mock.invoke<{ rows: EventForVerify[] }>(
      "db_execute",
      {
        sql: "SELECT project_id AS projectId, scene_id AS sceneId, domain, op_type AS opType, entity_type AS entityType, entity_id AS entityId, payload, session_id AS sessionId, sequence, timestamp, prev_hash AS prevHash, hash FROM change_events WHERE project_id = ? ORDER BY sequence",
        params: ["default-project"],
        method: "all",
      },
    );
    await expect(verifyChain(timelapseRows.rows)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("closes an execution after its first terminal while allowing an exact retry", async () => {
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
    });
    owned.push(mock);
    const append = (events: ReturnType<typeof auditEvent>[]) =>
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        events,
      });
    const terminal = auditEvent("event-terminal", "execution.cancelled", 4);
    await append([
      auditEvent("event-start", "execution.started", 1),
      auditEvent("event-prepared", "request.prepared", 2),
      auditEvent("event-dispatch", "request.dispatched", 3),
      terminal,
    ]);

    await expect(append([terminal])).resolves.toMatchObject({
      insertedCount: 0,
    });
    await expect(
      append([auditEvent("event-late", "response.partial", 5)]),
    ).rejects.toThrow(/already reached terminal/iu);
    await expect(
      append([auditEvent("event-second-terminal", "execution.succeeded", 6)]),
    ).rejects.toThrow(/already reached terminal/iu);
  });

  it("mirrors the native audit lifecycle transition rules", async () => {
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
    });
    owned.push(mock);
    const append = (events: ReturnType<typeof auditEvent>[]) =>
      mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        events,
      });

    await expect(
      append([
        auditEvent(
          "missing-start-prepared",
          "request.prepared",
          1,
          "missing-start",
        ),
      ]),
    ).rejects.toThrow(/must begin with execution\.started/iu);

    await append([
      auditEvent("order-start", "execution.started", 2, "ordered"),
    ]);
    await expect(
      append([
        auditEvent("order-dispatch", "request.dispatched", 3, "ordered"),
      ]),
    ).rejects.toThrow(/requires a durable pre-dispatch request\.prepared/iu);
    await expect(
      append([auditEvent("order-response", "response.partial", 4, "ordered")]),
    ).rejects.toThrow(/requires a durable request\.dispatched/iu);
    await expect(
      append([
        auditEvent("order-success", "execution.succeeded", 5, "ordered"),
      ]),
    ).rejects.toThrow(/requires a durable request\.dispatched/iu);
    await expect(
      append([
        auditEvent("order-second-start", "execution.started", 6, "ordered"),
      ]),
    ).rejects.toThrow(/already has execution\.started/iu);

    await append([
      auditEvent("order-prepared", "request.prepared", 7, "ordered"),
      auditEvent("order-dispatched", "request.dispatched", 8, "ordered"),
    ]);
    await expect(
      append([
        auditEvent("order-second-dispatch", "request.dispatched", 9, "ordered"),
      ]),
    ).rejects.toThrow(/already has request\.dispatched/iu);
    await expect(
      append([auditEvent("order-skipped", "execution.skipped", 10, "ordered")]),
    ).rejects.toThrow(/must not follow request\.dispatched/iu);
    await expect(
      append([
        auditEvent("order-cache-hit", "execution.cache_hit", 11, "ordered"),
      ]),
    ).rejects.toThrow(/must not follow request\.dispatched/iu);
    await expect(
      append([
        auditEvent(
          "order-success-before-response",
          "execution.succeeded",
          12,
          "ordered",
        ),
      ]),
    ).rejects.toThrow(/requires a durable response\.completed/iu);
    await expect(
      append([
        auditEvent("order-late-prepared", "request.prepared", 12, "ordered"),
      ]),
    ).rejects.toThrow(/effectiveRequestReceipt=true/iu);

    const effectiveReceiptBase = auditEvent(
      "order-effective-receipt",
      "request.prepared",
      13,
      "ordered",
    );
    const effectiveReceipt = {
      ...effectiveReceiptBase,
      payload: {
        ...effectiveReceiptBase.payload,
        effectiveRequestReceipt: true,
      },
    };
    await append([
      effectiveReceipt,
      auditEvent(
        "order-attempt-started",
        "transport.attempt.started",
        14,
        "ordered",
      ),
      auditEvent("order-partial", "response.partial", 15, "ordered"),
      auditEvent("order-retrying", "execution.retrying", 16, "ordered"),
      auditEvent("order-fallback", "execution.fallback", 17, "ordered"),
      auditEvent(
        "order-attempt-finished",
        "transport.attempt.finished",
        18,
        "ordered",
      ),
      auditEvent("order-completed", "response.completed", 19, "ordered"),
      auditEvent("order-failed", "execution.failed", 20, "ordered"),
    ]);

    await expect(
      append([
        auditEvent("failed-start", "execution.started", 21, "failed-early"),
        auditEvent("failed-terminal", "execution.failed", 22, "failed-early"),
      ]),
    ).resolves.toMatchObject({ insertedCount: 2 });
    await expect(
      append([
        auditEvent(
          "cancelled-start",
          "execution.started",
          23,
          "cancelled-early",
        ),
        auditEvent(
          "cancelled-terminal",
          "execution.cancelled",
          24,
          "cancelled-early",
        ),
      ]),
    ).resolves.toMatchObject({ insertedCount: 2 });
    await expect(
      append([
        auditEvent("skipped-start", "execution.started", 25, "skipped"),
        auditEvent("skipped-terminal", "execution.skipped", 26, "skipped"),
      ]),
    ).resolves.toMatchObject({ insertedCount: 2 });
    await expect(
      append([
        auditEvent("cache-start", "execution.started", 27, "cache-hit"),
        auditEvent("cache-terminal", "execution.cache_hit", 28, "cache-hit"),
      ]),
    ).resolves.toMatchObject({ insertedCount: 2 });
    await expect(
      append([
        auditEvent("success-start", "execution.started", 29, "success"),
        auditEvent("success-prepared", "request.prepared", 30, "success"),
        auditEvent("success-dispatched", "request.dispatched", 31, "success"),
        auditEvent("success-response", "response.completed", 32, "success"),
        auditEvent("success-terminal", "execution.succeeded", 33, "success"),
      ]),
    ).resolves.toMatchObject({ insertedCount: 5 });
  });

  it("AI audit path: browser_byok_web", async () => {
    const dirty = { count: 0 };
    const mock = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
      onDatabaseDirty: () => {
        dirty.count += 1;
      },
    });
    owned.push(mock);
    const expectedWorkspacePath = "/dev/workspace";
    const projectEvents = [
      auditEvent("event-1", "execution.started", 1),
      auditEvent("event-2", "request.prepared", 2),
      auditEvent("event-3", "request.dispatched", 3),
    ];

    const firstAppend = await mock.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: projectEvents,
    });
    const resend = await mock.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: projectEvents,
    });
    const workspaceAppend = await mock.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: null,
      events: projectEvents.slice(0, 2),
    });

    expect(firstAppend).toMatchObject({ insertedCount: 3, tailSequence: 3 });
    expect(resend).toMatchObject({ insertedCount: 0, tailSequence: 3 });
    expect(workspaceAppend).toMatchObject({
      insertedCount: 2,
      tailSequence: 2,
    });
    const firstPage = await mock.invoke<{
      highWaterSequence: number;
      highWaterHash: string;
      nextAfterSequence: number | null;
      events: Array<{ sequence: number; scopeId: string; recordedAt: number }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
      afterSequence: 0,
      limit: 2,
    });
    expect(firstPage).toMatchObject({
      highWaterSequence: 3,
      nextAfterSequence: 2,
    });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.events[0]).toMatchObject({
      sequence: 1,
      scopeId: "project:default-project",
    });
    expect(firstPage.events[0].recordedAt).toBeGreaterThan(0);

    await mock.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: [
        auditEvent("event-4", "response.completed", 4),
        auditEvent("event-5", "execution.succeeded", 5),
      ],
    });
    const secondPage = await mock.invoke<{
      highWaterHash: string;
      nextAfterSequence: number | null;
      events: Array<{ eventId: string }>;
    }>("ai_audit_read_snapshot", {
      expectedWorkspacePath,
      projectId: "default-project",
      afterSequence: firstPage.nextAfterSequence,
      highWaterSequence: firstPage.highWaterSequence,
      limit: 2,
    });
    expect(secondPage.events.map((event) => event.eventId)).toEqual([
      "event-3",
    ]);
    expect(secondPage.nextAfterSequence).toBeNull();
    expect(secondPage.highWaterHash).toBe(firstPage.highWaterHash);
    await expect(
      mock.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: "default-project",
        highWaterSequence: firstPage.highWaterSequence,
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 3 });
    await expect(
      mock.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: null,
        highWaterSequence: 2,
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 2 });

    await expect(
      mock.invoke("db_execute", {
        sql: "UPDATE ai_audit_events SET payload = '{}' WHERE id = 1",
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(/denied mutation of ai_audit_events/iu);
    for (const sql of [
      "UPDATE main.ai_audit_events SET payload = '{}'",
      "DROP TABLE ai_audit_events",
      "ALTER TABLE ai_audit_events RENAME TO hidden_audit",
      "CREATE TRIGGER erase_audit AFTER INSERT ON projects BEGIN DELETE FROM ai_audit_events; END",
      "DELETE FROM ai_/**/audit_events",
      "SELECT * FROM ai_audit_events; DELETE FROM ai_audit_events",
    ]) {
      await expect(
        mock.invoke("db_execute", { sql, params: [], method: "run" }),
      ).rejects.toThrow(/denied mutation of ai_audit_events/iu);
    }
    await expect(
      mock.invoke("db_execute", {
        sql: "SELECT count(*) AS count FROM ai_audit_events",
        params: [],
        method: "all",
      }),
    ).resolves.toMatchObject({ rows: [{ count: 7 }] });

    await expect(
      mock.invoke("ai_audit_read_snapshot", {
        expectedWorkspacePath: "/different/workspace",
        projectId: "default-project",
      }),
    ).rejects.toThrow(/AI_AUDIT_WORKSPACE_CHANGED/u);

    const bytes = mock.exportDatabase();
    const reopened = await createBrowserMock({
      databaseBytes: bytes,
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(reopened);
    await expect(
      reopened.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: "default-project",
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 5 });

    await reopened.invoke("db_execute", {
      sql: "DELETE FROM projects WHERE id = ?",
      params: ["default-project"],
      method: "run",
    });
    await expect(
      reopened.invoke("ai_audit_read_snapshot", {
        expectedWorkspacePath,
        projectId: "default-project",
      }),
    ).resolves.toMatchObject({
      highWaterSequence: 5,
      events: expect.arrayContaining([
        expect.objectContaining({ eventId: "event-1" }),
        expect.objectContaining({ eventId: "event-5" }),
      ]),
    });
    await expect(
      reopened.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: "default-project",
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 5 });
    await expect(
      reopened.invoke("ai_audit_verify", {
        expectedWorkspacePath,
        projectId: null,
      }),
    ).resolves.toMatchObject({ ok: true, verifiedThroughSequence: 2 });
    expect(dirty.count).toBeGreaterThan(0);
  });

  it("does not normalize tampered recorder/schema/app versions during verification", async () => {
    const expectedWorkspacePath = "/dev/workspace";
    const source = await createBrowserMock({
      workspaceIdentity: expectedWorkspacePath,
    });
    owned.push(source);
    await source.invoke("ai_audit_append_batch", {
      expectedWorkspacePath,
      projectId: "default-project",
      events: [auditEvent("event-1", "execution.started", 1)],
    });
    const originalBytes = source.exportDatabase();
    const SQL = await initSqlJs();

    for (const [field, value] of [
      ["auditSchemaVersion", 2],
      ["recorder", "different-recorder"],
      ["appVersion", "forged-app-version"],
    ] as const) {
      const database = new SQL.Database(originalBytes);
      const result = database.exec(
        "SELECT payload FROM ai_audit_events WHERE project_id = 'default-project' AND sequence = 1",
      );
      const payload = JSON.parse(String(result[0].values[0][0])) as Record<
        string,
        unknown
      >;
      payload[field] = value;
      database.run(
        "UPDATE ai_audit_events SET payload = ? WHERE project_id = 'default-project' AND sequence = 1",
        [JSON.stringify(payload)],
      );
      const tamperedBytes = database.export();
      database.close();

      const reopened = await createBrowserMock({
        databaseBytes: tamperedBytes,
        workspaceIdentity: expectedWorkspacePath,
      });
      owned.push(reopened);
      await expect(
        reopened.invoke("ai_audit_verify", {
          expectedWorkspacePath,
          projectId: "default-project",
          highWaterSequence: 1,
        }),
        `tampering ${field} must fail verification`,
      ).resolves.toMatchObject({ ok: false, brokenAtSequence: 1 });
    }
  });
});
