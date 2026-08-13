// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  browserNarrativeStateDigest,
  createBrowserMock,
  type PersistentBrowserMock,
} from "./browser-mock";

function context(requestId: string) {
  return {
    requestId,
    sessionId: `session:${requestId}`,
    eventUid: `event:${requestId}`,
    origin: "human",
    originalTransactionId: null,
    undoJournalId: null,
  };
}

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

describe("Browser Narrative Change Feed state digests", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
  });

  afterEach(() => mock.close());

  it("matches the Rust canonical JSON SHA-256 vector including UTF-8 key order", () => {
    const state = {
      あ: "jp",
      z: [3, { b: true, a: null }],
      é: "accent",
      a: "first",
    };

    expect(browserNarrativeStateDigest(state)).toBe(
      "sha256:c1f56a548e2a3ab4573fc13ad51436765db5616ebb773409d9eed7194d270a11",
    );
    expect(
      browserNarrativeStateDigest({
        a: "first",
        é: "accent",
        z: [3, { a: null, b: true }],
        あ: "jp",
      }),
    ).toBe(browserNarrativeStateDigest(state));
  });

  it.each([
    ["undefined", undefined],
    ["function", () => undefined],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["Date", new Date("2026-08-13T00:00:00.000Z")],
    ["Map", new Map([["key", "value"]])],
    ["Set", new Set(["value"])],
    ["typed array", new Uint8Array([1, 2, 3])],
    ["nested undefined", { nested: undefined }],
    ["sparse array", new Array(1)],
  ])("rejects non-JSON %s state synchronously", (_label, state) => {
    expect(() => browserNarrativeStateDigest(state)).toThrow();
  });

  it.each([
    {
      operation: "type.create",
      entityId: "digest-type",
      fields: {
        typeId: "digest-type",
        slug: "browser-type",
        label: "Browser type",
        color: "#654321",
        paletteIndex: null,
        icon: null,
        isBuiltin: false,
        sortOrder: 10,
        createdAt: "2026-08-13T01:02:03.000Z",
      },
      expected:
        "sha256:4299d030a7d33bef4a17d5bdc64f9fe92d82bec425b1d2cc8f387726b94b1665",
    },
    {
      operation: "tag.create",
      entityId: "digest-tag",
      fields: {
        tagId: "digest-tag",
        name: "Tag",
        color: "#123456",
        typeFilter: null,
        createdAt: "2026-08-13T01:02:03.000Z",
      },
      expected:
        "sha256:e030eca3de20300bccd4ac3a95db45af6ff514fbeb263a5e378a756d344ae6eb",
    },
  ])(
    "stores the Native-parity snapshot digest for $operation",
    async ({ operation, fields, expected }) => {
      const requestId = `digest:${operation}`;
      await mock.invoke("agent_codex_mutate", {
        payload: {
          ...context(requestId),
          operation,
          projectId: "default-project",
          surface: "manual",
          ...fields,
        },
      });

      expect(
        await rows(
          mock,
          `SELECT event.before_digest, event.after_digest
             FROM narrative_change_transactions transaction_row
             JOIN narrative_change_events event
               ON event.transaction_id = transaction_row.id
            WHERE transaction_row.request_id = ?`,
          [requestId],
        ),
      ).toEqual([{ before_digest: null, after_digest: expected }]);
    },
  );

  it("keeps one catalog aggregate digest continuous across writer operations", async () => {
    const typeId = "digest-continuity-type";
    const base = {
      projectId: "default-project",
      surface: "manual",
      typeId,
    };
    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("digest-continuity:create"),
        ...base,
        operation: "type.create",
        slug: typeId,
        label: "Before",
        color: "#123456",
        icon: null,
        isBuiltin: false,
        sortOrder: 10,
        createdAt: "2026-08-13T01:02:03.000Z",
      },
    });
    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("digest-continuity:update"),
        ...base,
        operation: "type.update",
        label: "After",
        icon: "star",
      },
    });
    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("digest-continuity:delete"),
        ...base,
        operation: "type.delete",
      },
    });

    const events = await rows(
      mock,
      `SELECT transaction_row.request_id, event.before_digest, event.after_digest
         FROM narrative_change_transactions transaction_row
         JOIN narrative_change_events event
           ON event.transaction_id = transaction_row.id
        WHERE transaction_row.request_id LIKE 'digest-continuity:%'
        ORDER BY event.canonical_sequence`,
    );
    expect(events).toHaveLength(3);
    expect(events[0]!.after_digest).toBe(events[1]!.before_digest);
    expect(events[1]!.after_digest).toBe(events[2]!.before_digest);
    expect(events[0]!.before_digest).toBeNull();
    expect(events[2]!.after_digest).toBeNull();
  });

  it("rolls back a domain mutation when the key-order-independent Feed head mismatches", async () => {
    const typeId = "digest-mismatch-type";
    const base = {
      projectId: "default-project",
      surface: "manual",
      typeId,
    };
    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("digest-mismatch:create"),
        ...base,
        operation: "type.create",
        slug: typeId,
        label: "Original",
        color: "#123456",
        isBuiltin: false,
        sortOrder: 10,
      },
    });
    await mock.invoke("db_execute", {
      sql: `UPDATE narrative_change_events
               SET object_key_json = ?, after_digest = ?
             WHERE project_id = 'default-project'
               AND transaction_id = (
                 SELECT id FROM narrative_change_transactions
                  WHERE request_id = 'digest-mismatch:create'
               )`,
      params: [
        JSON.stringify({
          kind: "component",
          componentId: `codex-type:${typeId}`,
        }),
        `sha256:${"0".repeat(64)}`,
      ],
      method: "run",
    });

    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          ...context("digest-mismatch:update"),
          ...base,
          operation: "type.update",
          label: "Must roll back",
        },
      }),
    ).rejects.toThrow("Narrative Change Feed continuity mismatch");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT label FROM codex_types WHERE id = ?) AS label,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'digest-mismatch:update') AS feed_count,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:digest-mismatch:update') AS canonical_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id = 'digest-mismatch:update') AS receipt_count`,
        [typeId],
      ),
    ).toEqual([
      {
        label: "Original",
        feed_count: 0,
        canonical_count: 0,
        receipt_count: 0,
      },
    ]);
  });
});
