// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  verifyChain,
  type EventForVerify,
} from "@/features/timelapse/hashChain";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

async function rows(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params, method: "all" },
  );
  return result.rows;
}

function payload(projectId: string, requestId: string) {
  return {
    projectId,
    requestId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "human",
    originalTransactionId: null,
    undoJournalId: null,
    title: "Browser Project",
    genre: "Fantasy",
    pov: null,
    tense: null,
    language: "en",
    styleGuide: null,
    aiInstructions: null,
    outline: null,
    targetReaders: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("Browser canonical Project creation", () => {
  let mock: PersistentBrowserMock;
  const onDatabaseDirty = vi.fn<() => void>();

  beforeEach(async () => {
    onDatabaseDirty.mockClear();
    mock = await createBrowserMock({
      onDatabaseDirty,
      allowProtectedWriterTestFixtures: true,
    });
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("atomically publishes one Project and four ordered builtin catalog events", async () => {
    const input = payload("browser-project", "browser-project-request");
    const first = await mock.invoke<Record<string, unknown>>("project_create", {
      payload: input,
    });
    const retry = await mock.invoke<Record<string, unknown>>("project_create", {
      payload: {
        ...input,
        sessionId: "browser-project:retry-session",
        eventUid: "browser-project:retry-event",
      },
    });

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      id: "browser-project",
      title: "Browser Project",
      language: "en",
      __writeReceipt: {
        changeEventUid: "browser-project-request:event",
        maintenanceTransactionId: expect.any(String),
        undoJournalId: null,
      },
    });
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
    expect(
      await rows(
        mock,
        `SELECT type.slug, type.label, event.event_ordinal,
                json_extract(event.object_key_json, '$.componentId') AS component_id
           FROM narrative_change_events event
           JOIN codex_types type
             ON type.id = substr(
                  json_extract(event.object_key_json, '$.componentId'),
                  length('codex-type:') + 1
                )
          WHERE event.project_id = 'browser-project'
          ORDER BY event.event_ordinal`,
      ),
    ).toEqual([
      {
        slug: "character",
        label: "Character",
        event_ordinal: 0,
        component_id: "codex-type:browser-project-character",
      },
      {
        slug: "location",
        label: "Location",
        event_ordinal: 1,
        component_id: "codex-type:browser-project-location",
      },
      {
        slug: "item",
        label: "Item",
        event_ordinal: 2,
        component_id: "codex-type:browser-project-item",
      },
      {
        slug: "lore",
        label: "Lore & Worldbuilding",
        event_ordinal: 3,
        component_id: "codex-type:browser-project-lore",
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM projects
             WHERE id = 'browser-project') AS project_count,
           (SELECT COUNT(*) FROM change_events
             WHERE project_id = 'browser-project'
               AND op_type = 'project.create') AS canonical_count,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE project_id = 'browser-project'
               AND request_id = 'browser-project-request') AS transaction_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'project_create'
               AND request_id = 'browser-project-request') AS receipt_count`,
      ),
    ).toEqual([
      {
        project_count: 1,
        canonical_count: 1,
        transaction_count: 1,
        receipt_count: 1,
      },
    ]);
    const canonicalEvents = await rows(
      mock,
      `SELECT project_id AS projectId, scene_id AS sceneId, domain,
              op_type AS opType, entity_type AS entityType,
              entity_id AS entityId, payload, session_id AS sessionId,
              sequence, timestamp, prev_hash AS prevHash, hash
         FROM change_events
        WHERE project_id = 'browser-project'
        ORDER BY sequence`,
    );
    await expect(
      verifyChain(canonicalEvents as unknown as EventForVerify[]),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects semantic and cross-project retries without creating a second Project", async () => {
    const input = payload("browser-conflict", "browser-conflict-request");
    await mock.invoke("project_create", { payload: input });

    await expect(
      mock.invoke("project_create", {
        payload: { ...input, title: "Different" },
      }),
    ).rejects.toThrow("PROJECT_CREATE_REQUEST_CONFLICT");
    await expect(
      mock.invoke("project_create", {
        payload: {
          ...input,
          projectId: "browser-foreign-retry",
          title: "Browser Project",
        },
      }),
    ).rejects.toThrow("PROJECT_CREATE_REQUEST_CONFLICT");
    expect(
      await rows(
        mock,
        `SELECT COUNT(*) AS count FROM projects
          WHERE id IN ('browser-conflict', 'browser-foreign-retry')`,
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("rolls back Project, trigger rows, canonical event, and receipt on Feed failure", async () => {
    await mock.invoke("db_execute", {
      sql: `CREATE TRIGGER fail_browser_project_feed
            BEFORE INSERT ON narrative_change_events
            BEGIN SELECT RAISE(ABORT, 'forced project Feed failure'); END`,
      params: [],
      method: "run",
    });
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("project_create", {
        payload: payload("browser-rollback", "browser-rollback-request"),
      }),
    ).rejects.toThrow("forced project Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM projects
             WHERE id = 'browser-rollback') AS project_count,
           (SELECT COUNT(*) FROM codex_types
             WHERE project_id = 'browser-rollback') AS type_count,
           (SELECT COUNT(*) FROM map_boards
             WHERE project_id = 'browser-rollback') AS board_count,
           (SELECT COUNT(*) FROM change_events
             WHERE project_id = 'browser-rollback') AS canonical_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id = 'browser-rollback-request') AS receipt_count`,
      ),
    ).toEqual([
      {
        project_count: 0,
        type_count: 0,
        board_count: 0,
        canonical_count: 0,
        receipt_count: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});
