// Diagnostic-only negative probes against an isolated copy of a cold fixture.
// Build the opt-in Native CLI first. Never pass a user's live workspace here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const [binary, fixture, project, revision] = process.argv.slice(2);
assert.ok(
  binary && fixture && project && revision,
  "usage: node scripts/nir1-material-roster-probe.mjs <binary> <cold-fixture.db> <project> <revision>",
);
const directory = mkdtempSync(path.join(tmpdir(), "nir1-roster-probe-"));
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const fixtureHash = hash(fixture);
const results = [];

function probe(name, mutate, verify) {
  const file = path.join(directory, `${name}.db`);
  copyFileSync(fixture, file);
  if (mutate) {
    const db = new DatabaseSync(file);
    try {
      mutate(db);
    } finally {
      db.close();
    }
  }
  const before = hash(file);
  const child = spawnSync(path.resolve(binary), [file, project, revision], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.diagnosticOnly, true);
  if (report.status !== "complete") assert.deepEqual(report.materials, []);
  verify(report);
  assert.equal(hash(file), before, "Native diagnostic must not modify its DB");
  results.push({ name, status: report.status, issues: report.issues });
}

try {
  probe("cold-production", null, (report) => {
    assert.equal(report.protocol, "citation-id-v2");
    assert.equal(report.status, "complete");
    assert.equal(report.completionScope, "source-material-membership-only");
    assert.ok(report.materials.length > 0);
    assert.equal(report.replayedRequests.length, 2);
    for (const proof of report.replayedRequests) {
      for (const field of [
        "contextSetDigest",
        "componentContractDigest",
        "finalRequestDigest",
      ]) {
        assert.equal(proof.reconstructed[field], proof.persisted[field]);
      }
    }
    assert.deepEqual(report.issues, []);
  });
  probe(
    "required-receipt-removed",
    (db) => {
      db.prepare(
        "DELETE FROM narrative_extraction_stage_receipts WHERE stage_execution_id = (SELECT stage_execution_id FROM narrative_extraction_stage_receipts ORDER BY stage_execution_id LIMIT 1)",
      ).run();
    },
    (r) => {
      assert.equal(r.status, "inconsistent");
      assert.deepEqual(
        r.issues.map((i) => i.code),
        ["revision-terminal-binding-invalid"],
      );
    },
  );
  probe(
    "receipt-digest-corrupt",
    (db) => {
      db.prepare(
        "UPDATE narrative_extraction_stage_receipts SET receipt_digest = ?",
      ).run(`sha256:${"1".repeat(64)}`);
    },
    (r) => {
      assert.equal(r.status, "inconsistent");
      assert.deepEqual(
        r.issues.map((i) => i.code),
        ["revision-terminal-binding-invalid"],
      );
    },
  );
  probe(
    "unselected-visible-segment-removed",
    (db) => {
      const root = db
        .prepare(
          "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?",
        )
        .get(revision);
      const envelope = JSON.parse(root.reconciliation_envelope_json);
      const row = db
        .prepare(
          "SELECT id, payload_json FROM narrative_extraction_artifacts WHERE artifact_kind = 'source.snapshot@1'",
        )
        .get();
      const payload = JSON.parse(row.payload_json);
      const entries = payload.evidence.catalog.entries;
      // Select a visible occurrence absent from this revision's Evidence quote
      // set, so dropping only the unselected input cannot look like Evidence loss.
      const quotes = new Set();
      function collect(value) {
        if (!value || typeof value !== "object") return;
        if (typeof value.quote === "string") quotes.add(value.quote);
        for (const child of Object.values(value)) collect(child);
      }
      collect(envelope);
      const index = entries.findIndex((entry) => !quotes.has(entry.quote));
      assert.notEqual(
        index,
        -1,
        "fixture must include an unselected visible occurrence",
      );
      entries.splice(index, 1);
      db.prepare(
        "UPDATE narrative_extraction_artifacts SET payload_json = ? WHERE id = ?",
      ).run(JSON.stringify(payload), row.id);
      // Keep the independently sealed digest. Never reseal expected membership
      // from the subset being diagnosed.
    },
    (r) => {
      assert.equal(r.status, "inconsistent");
      assert.deepEqual(r.issues, [
        {
          code: "artifact-digest-mismatch",
          binding: "snapshot/catalog/payload-digest",
        },
      ]);
    },
  );
  probe(
    "window-binding-removed",
    (db) => {
      const row = db
        .prepare(
          "SELECT id, payload_json FROM narrative_extraction_artifacts WHERE artifact_kind = 'source.window-plan@1'",
        )
        .get();
      const payload = JSON.parse(row.payload_json);
      assert.ok(payload.windows.length > 0);
      payload.windows.pop();
      db.prepare(
        "UPDATE narrative_extraction_artifacts SET payload_json = ? WHERE id = ?",
      ).run(JSON.stringify(payload), row.id);
    },
    (r) => {
      assert.equal(r.status, "inconsistent");
      assert.deepEqual(r.issues, [
        {
          code: "artifact-digest-mismatch",
          binding: "window-plan/payload-digest",
        },
      ]);
    },
  );
  assert.equal(hash(fixture), fixtureHash);
  console.log(
    JSON.stringify(
      { diagnosticOnly: true, fixtureDigest: fixtureHash, results },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
