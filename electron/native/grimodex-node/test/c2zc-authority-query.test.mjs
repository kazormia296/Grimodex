// Execute the canonical C2-ZC authority descriptors against the production
// N-API backend.  openWorkspace performs the real Database::migrate() path;
// this test intentionally does not duplicate the migrated schema in SQL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  C2ZC_AUTHORITY_APPLICATION_ROWS_QUERY,
  C2ZC_AUTHORITY_SNAPSHOT_QUERIES,
  countC2ZcSqlPlaceholders,
  resolveC2ZcAuthorityQuery,
} from "../../../../electron/scripts/c2zc-canonical-product-journey.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-c2zc-authority-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));

function canonical(requestId) {
  return {
    requestId,
    projectId: "default-project",
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "ai-apply",
    authorityRoute: "interactive-agent-command",
    caller: "chat-tool-executor",
    controls: [
      "knowledge-write-policy",
      "stable-request-id",
      "agent-provenance",
      "field-authority",
      "typed-writer",
      "occ",
      "undo-journal",
      "change-event",
      "change-feed",
    ],
    provenance: {
      requestId,
      traceId: `${requestId}:trace`,
      executionId: `${requestId}:execution`,
      mainOwnedProvenanceId: `${requestId}:main-provenance`,
    },
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
  };
}

test("C2-ZC authority descriptors prepare and execute on the migrated N-API schema", async () => {
  const workspace = join(root, "workspace");
  const projectId = "default-project";
  await backend.openWorkspace(workspace);

  const created = JSON.parse(
    await backend.agentCodexCreate({
      ...canonical("c2zc-authority-descriptor-entry"),
      entryId: "c2zc-authority-descriptor-entry",
      projectId,
      typeSlug: "character",
      name: "C2-ZC descriptor entry",
      summary: "descriptor contract row",
      content: "{}",
      authorshipSpans: [],
    }),
  );

  const descriptors = [
    ...Object.entries(C2ZC_AUTHORITY_SNAPSHOT_QUERIES).map(
      ([label, definition]) => [label, definition, { projectId }],
    ),
    [
      "applicationRows",
      C2ZC_AUTHORITY_APPLICATION_ROWS_QUERY,
      { commitId: "c2zc-missing-commit" },
    ],
  ];
  assert.equal(descriptors.length, 13);

  const rowsByLabel = {};
  for (const [label, definition, context] of descriptors) {
    const request = resolveC2ZcAuthorityQuery(definition, context);
    assert.equal(
      request.params.length,
      countC2ZcSqlPlaceholders(request.sql),
      `${label} descriptor arity`,
    );
    const result = JSON.parse(
      await backend.dbExecute(request.sql, request.params, "all"),
    );
    assert.ok(Array.isArray(result.rows), `${label} must return rows`);
    rowsByLabel[label] = result.rows;
  }

  assert.deepEqual(rowsByLabel.projectInventory, [{ projectId }]);
  assert.ok(
    rowsByLabel.codexEntries.some(
      (row) =>
        row.entryId === created.entityId &&
        row.projectId === projectId &&
        row.typeSlug === "character",
    ),
    "typed codex row must retain the typeSlug alias",
  );
});

test("C2-ZC placeholder scanner matches SQLite quote/comment behavior", async () => {
  const escapedQuoteSql = "SELECT 'a\\' AS x, ? AS bound";
  assert.equal(countC2ZcSqlPlaceholders(escapedQuoteSql), 1);
  assert.deepEqual(
    JSON.parse(await backend.dbExecute(escapedQuoteSql, [7], "all")).rows,
    [{ x: "a\\", bound: 7 }],
  );

  const quotedAndCommentedSql =
    "SELECT 'a''?b' AS single, 'double?' AS \"double?\", " +
    "'backtick?' AS `backtick?`, 'bracket?' AS [bracket?], " +
    "? AS bound /* ignored ? */ -- ignored ?\n";
  assert.equal(countC2ZcSqlPlaceholders(quotedAndCommentedSql), 1);
  assert.deepEqual(
    JSON.parse(await backend.dbExecute(quotedAndCommentedSql, [11], "all"))
      .rows,
    [
      {
        single: "a'?b",
        "double?": "double?",
        "backtick?": "backtick?",
        "bracket?": "bracket?",
        bound: 11,
      },
    ],
  );

  const sqliteNamedCases = [
    ["SELECT :é AS bound", 17],
    ["SELECT @é AS bound", 19],
    ["SELECT $é AS bound", 23],
    ["SELECT $::foo AS bound", 29],
  ];
  for (const [sql, value] of sqliteNamedCases) {
    assert.deepEqual(
      JSON.parse(await backend.dbExecute(sql, [value], "all")).rows,
      [{ bound: value }],
      `SQLite must bind ${sql}`,
    );
    assert.throws(
      () => resolveC2ZcAuthorityQuery({ sql, params: () => [value] }),
      /unsupported named SQLite placeholder/,
      sql,
    );
  }

  for (const [sql, message] of [
    ["SELECT ?1", /unsupported numbered SQLite placeholder/],
    ["SELECT :name", /unsupported named SQLite placeholder/],
    ["SELECT @name", /unsupported named SQLite placeholder/],
    ["SELECT $name", /unsupported named SQLite placeholder/],
  ]) {
    assert.throws(
      () =>
        resolveC2ZcAuthorityQuery({
          sql,
          params: () => [],
        }),
      message,
      sql,
    );
  }
});
