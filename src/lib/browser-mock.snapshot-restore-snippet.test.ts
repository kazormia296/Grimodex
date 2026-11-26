// The snippet row of a snapshot restore plan has one shape in three places: the
// Native canonical plan (grimodex-db `project_snapshots.rs`,
// `canonical_core_rows`), the renderer plan (`projectSnapshotApi.ts`) and this
// mock's copy (`browserSnapshotCanonicalPlan`). Native compares the renderer
// plan to its own exactly, so a renderer row with other columns makes every
// restore of a project with snippets fail with "does not match the owned
// snapshot" (it did from #530 until this fix: the renderer and the mock sent
// `source_marker`, which the `snippets` table does not have). The renderer
// against real Native is pinned by `electron/main/pubgRendererWriters.pipeline.spec.ts`;
// this file pins the mock to the same Native shape.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

const PROJECT = "snapshot-snippet-project";
const SNAPSHOT = "snapshot-snippet-snapshot";
const SNIPPET = "snapshot-snippet";
const STAMP = "2026-11-26T00:00:00.000Z";

async function run(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
) {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

async function snippetTitle(
  mock: PersistentBrowserMock,
): Promise<string | null> {
  const result = await mock.invoke<{ rows: Array<{ title: string }> }>(
    "db_execute",
    {
      sql: "SELECT title FROM snippets WHERE id = ?",
      params: [SNIPPET],
      method: "all",
    },
  );
  return result.rows[0]?.title ?? null;
}

/** The Native canonical snippet row (project_snapshots.rs, canonical_core_rows). */
const nativeSnippetRow = {
  id: SNIPPET,
  project_id: PROJECT,
  title: "Snapshot snippet",
  scene_id: null,
  source_chat_message_id: null,
  content: "{}",
  tags_cache: null,
  content_source: null,
  usage_count: 0,
  version: 0,
  created_at: STAMP,
  updated_at: STAMP,
};

describe("browser snapshot restore: the snippet row has the Native shape", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
    await run(mock, "INSERT INTO projects (id, title) VALUES (?, 'Snippets')", [
      PROJECT,
    ]);
    await run(
      mock,
      `INSERT INTO snippets (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, 'Live snippet', ?, ?)`,
      [SNIPPET, PROJECT, STAMP, STAMP],
    );
    await mock.invoke("project_snapshot_create", {
      payload: {
        projectId: PROJECT,
        snapshotId: SNAPSHOT,
        name: "Snippet snapshot",
        description: null,
        createdAt: STAMP,
        treeRows: [],
        codexRows: [],
        snippetRows: [
          {
            snapshot_id: SNAPSHOT,
            snippet_id: SNIPPET,
            title: "Snapshot snippet",
            scene_id: null,
            source_chat_message_id: null,
            body_version_id: null,
            created_at: STAMP,
            updated_at: STAMP,
          },
        ],
        versionIds: [],
      },
    });
  });

  afterEach(() => mock.close());

  const restore = (row: Record<string, unknown>, requestId: string) =>
    mock.invoke("project_snapshot_apply_restore", {
      payload: {
        requestId,
        sessionId: "session-1",
        projectId: PROJECT,
        snapshotId: SNAPSHOT,
        scopes: ["snippet"],
        inserts: [{ table: "snippets", mode: "insert", row }],
      },
    });

  it("restores a snippet sent in the Native canonical shape", async () => {
    await expect(snippetTitle(mock)).resolves.toBe("Live snippet");
    await expect(
      restore(nativeSnippetRow, "snapshot-snippet-native"),
    ).resolves.toMatchObject({ noOp: false });
    await expect(snippetTitle(mock)).resolves.toBe("Snapshot snippet");
  });

  it("rejects the pre-fix renderer shape (source_marker, no counters) like Native does", async () => {
    const {
      tags_cache: _tagsCache,
      content_source: _contentSource,
      usage_count: _usageCount,
      version: _version,
      ...rest
    } = nativeSnippetRow;
    await expect(
      restore({ ...rest, source_marker: null }, "snapshot-snippet-old-shape"),
    ).rejects.toThrow("does not match the owned snapshot");
    await expect(snippetTitle(mock)).resolves.toBe("Live snippet");
  });
});
