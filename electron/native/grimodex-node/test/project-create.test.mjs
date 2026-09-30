// Canonical Project publication through the built N-API boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-project-create-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const backend = new Backend(join(root, "app-data"));

async function rows(sql, params = [], method = "all") {
  return JSON.parse(await backend.dbExecute(sql, params, method)).rows;
}

const createPayload = {
  projectId: "napi-project",
  requestId: "napi-project-request",
  sessionId: "napi-project-session",
  eventUid: "napi-project-event",
  origin: "human",
  originalTransactionId: null,
  undoJournalId: null,
  title: "N-API Project",
  genre: null,
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

test("projectCreate requires an open workspace", async () => {
  await assert.rejects(
    backend.projectCreate(createPayload),
    /No workspace is open/,
  );
});

test("projectCreate returns a stable receipt and ordered builtin Feed", async () => {
  await backend.openWorkspace(join(root, "workspace"));
  const first = JSON.parse(await backend.projectCreate(createPayload));
  const retry = JSON.parse(
    await backend.projectCreate({
      ...createPayload,
      sessionId: "napi-project-retry-session",
      eventUid: "napi-project-retry-event",
    }),
  );
  assert.deepEqual(retry, first);
  assert.equal(first.id, "napi-project");
  assert.equal(first.language, "en");
  assert.equal(first.__writeReceipt.changeEventUid, "napi-project-event");
  assert.equal(typeof first.__writeReceipt.maintenanceTransactionId, "string");
  assert.deepEqual(
    await rows(
      `SELECT type.slug, type.label, event.event_ordinal
         FROM narrative_change_events event
         JOIN codex_types type
           ON type.id = substr(
                json_extract(event.object_key_json, '$.componentId'),
                length('codex-type:') + 1
              )
        WHERE event.project_id = 'napi-project'
        ORDER BY event.event_ordinal`,
    ),
    [
      { slug: "character", label: "Character", event_ordinal: 0 },
      { slug: "location", label: "Location", event_ordinal: 1 },
      { slug: "item", label: "Item", event_ordinal: 2 },
      { slug: "lore", label: "Lore & Worldbuilding", event_ordinal: 3 },
    ],
  );
});

test("generic renderer SQL cannot create a Project indirectly", async () => {
  await assert.rejects(
    backend.dbExecute(
      "INSERT INTO projects (id, title) VALUES ('forged-project', 'Forged')",
      [],
      "run",
    ),
    /PROTECTED_WRITER_SQL/,
  );
});
