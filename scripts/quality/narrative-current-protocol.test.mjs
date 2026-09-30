import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURRENT_NARRATIVE_EVAL_PROTOCOL,
  CURRENT_NARRATIVE_EVAL_PROTOCOL_RELATIVE_PATH,
  validateCurrentNarrativeEvalProtocol,
  validateCurrentNarrativeEvalProtocolBinding,
} from "./quality-evaluation-runtime.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("current Narrative protocol is loaded from the versioned canonical declaration", async () => {
  const source = JSON.parse(
    await readFile(
      path.join(repoRoot, CURRENT_NARRATIVE_EVAL_PROTOCOL_RELATIVE_PATH),
      "utf8",
    ),
  );
  assert.deepEqual(CURRENT_NARRATIVE_EVAL_PROTOCOL, source);
  assert.deepEqual(validateCurrentNarrativeEvalProtocol(source), []);
  assert.equal(Object.isFrozen(CURRENT_NARRATIVE_EVAL_PROTOCOL), true);
  assert.equal(Object.isFrozen(CURRENT_NARRATIVE_EVAL_PROTOCOL.versions), true);
});

test("current Narrative protocol rejects legacy mode and malformed declarations", () => {
  const current = CURRENT_NARRATIVE_EVAL_PROTOCOL;
  for (const candidate of [
    { ...current, evidenceMode: "legacy-v1" },
    { ...current, receiptMode: "legacy-v1" },
    { ...current, versions: undefined },
    { ...current, unexpected: true },
  ]) {
    assert.notDeepEqual(validateCurrentNarrativeEvalProtocol(candidate), []);
  }
});

test("current Narrative report binding rejects missing, legacy, and drifted values", () => {
  const current = CURRENT_NARRATIVE_EVAL_PROTOCOL;
  const report = {
    evidenceMode: current.evidenceMode,
    receiptMode: current.receiptMode,
    versions: { ...current.versions },
  };
  assert.equal(validateCurrentNarrativeEvalProtocolBinding(report).ok, true);
  for (const candidate of [
    { ...report, evidenceMode: undefined },
    { ...report, evidenceMode: "legacy-v1" },
    { ...report, receiptMode: undefined },
    {
      ...report,
      versions: {
        ...report.versions,
        extractor: "chronicle-production-full-pipeline/1",
      },
    },
    { ...report, versions: undefined },
  ]) {
    const result = validateCurrentNarrativeEvalProtocolBinding(candidate);
    assert.equal(result.ok, false);
    assert.match(result.message, /mode|version/i);
  }
});
