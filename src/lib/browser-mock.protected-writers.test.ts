// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";
import { installBrowserMock } from "./tauri";
import { incrementSnippetUsageCount } from "@/features/snippets/api";

describe("Browser generic SQL Writer Authority", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = await createBrowserMock();
  });

  afterEach(() => mock.close());

  it("allows read-only inspection but rejects protected domain and Change Feed writes", async () => {
    await expect(
      mock.invoke("db_execute", {
        sql: "SELECT COUNT(*) AS count FROM narrative_change_transactions",
        params: [],
        method: "all",
      }),
    ).resolves.toEqual({ rows: [{ count: 0 }] });

    await expect(
      mock.invoke("db_execute", {
        sql: "INSERT INTO projects (id, title) VALUES ('forged-project', 'Forged')",
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(/protected narrative table projects/u);

    // Existing Project metadata remains renderer-updateable; only structural
    // INSERT/DELETE executes protected trigger/cascade subprograms.
    await expect(
      mock.invoke("db_execute", {
        sql: "UPDATE projects SET title = title WHERE id = 'default-project'",
        params: [],
        method: "run",
      }),
    ).resolves.toEqual({ rows: [] });

    await expect(
      mock.invoke("db_execute", {
        sql: "DELETE FROM projects WHERE id = 'default-project'",
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(/protected narrative table projects/u);

    await expect(
      mock.invoke("db_execute", {
        sql: `/* misleading INSERT INTO projects */
              INSERT INTO main."narrative_change_transactions"
                (id, project_id, request_id, source_domain,
                 source_change_event_uid, source_change_event_sequence,
                 cause_kind, origin, application_ids_json, payload_digest,
                 created_at)
              VALUES ('forged', 'default-project', 'forged', 'forged',
                      'forged', 1, 'forward', 'human', '[]', 'sha256:forged',
                      '2026-08-13T00:00:00.000Z')`,
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(
      /PROTECTED_WRITER_SQL: denied mutation of protected narrative table narrative_change_transactions/u,
    );

    await expect(
      mock.invoke("db_execute", {
        sql: `UPDATE tree_nodes SET title = 'forged' WHERE id = 'missing'`,
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(
      /PROTECTED_WRITER_SQL: denied mutation of protected narrative table tree_nodes/u,
    );

    await expect(
      mock.invoke("db_execute", {
        sql: `UPDATE snippets SET title = 'forged' WHERE id = 'missing'`,
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(/protected column snippets\.title/u);

    await expect(
      mock.invoke("db_execute", {
        sql: `UPDATE snippets SET usage_count = usage_count + 1 WHERE id = 'missing';
              UPDATE snippets SET content = '{}' WHERE id = 'missing'`,
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(/protected narrative table snippets/u);

    // usage_count is a non-Narrative renderer convenience counter. The
    // aggregate row remains column-protected while this isolated increment is
    // intentionally outside the canonical change transaction.
    await expect(
      mock.invoke("db_execute", {
        sql: `UPDATE snippets SET usage_count = usage_count + 1 WHERE id = 'missing'`,
        params: [],
        method: "run",
      }),
    ).resolves.toEqual({ rows: [] });
  });

  it("rolls back an earlier unprotected statement when a protected batch write is rejected", async () => {
    await expect(
      mock.invoke("db_execute_batch", {
        statements: [
          {
            sql: `INSERT INTO project_settings (project_id, key, value)
                  VALUES ('default-project', 'batch-before-denial', 'Transient')`,
            params: [],
            method: "run",
          },
          {
            sql: "DELETE FROM narrative_change_events WHERE project_id = 'default-project'",
            params: [],
            method: "run",
          },
        ],
      }),
    ).rejects.toThrow(
      /PROTECTED_WRITER_SQL: denied mutation of protected narrative table narrative_change_events/u,
    );

    await expect(
      mock.invoke("db_execute", {
        sql: `SELECT value FROM project_settings
              WHERE project_id = 'default-project'
                AND key = 'batch-before-denial'`,
        params: [],
        method: "all",
      }),
    ).resolves.toEqual({ rows: [] });
  });

  it("keeps the renderer usage counter writable through the real Snippet API", async () => {
    installBrowserMock(mock);
    await incrementSnippetUsageCount("default-project", "missing-snippet");

    await expect(
      mock.invoke("db_execute", {
        sql: "SELECT COUNT(*) AS count FROM snippets WHERE usage_count > 0",
        params: [],
        method: "all",
      }),
    ).resolves.toEqual({ rows: [{ count: 0 }] });
  });
});
