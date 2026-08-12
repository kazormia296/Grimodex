import { describe, expect, it } from "vitest";

import { buildNativeReconciliationEnvelope } from "./proposalRepository";

const sourceRevisionToken =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const quoteDigest =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("buildNativeReconciliationEnvelope", () => {
  it("binds schema, source, read-set, and evidence per proposal", async () => {
    const first = await buildNativeReconciliationEnvelope({
      runId: "run-envelope-test",
      taskId: "task-envelope-test",
      sourceRevisionToken,
      proposalSchemaId: "narrative.codex-entity.bind",
      reconcilerId: "grimodex.codex-structure-extraction",
      evidenceSet: [
        {
          evidenceRef: "anchor-entity",
          documentRef: "D000001",
          quoteDigest,
        },
      ],
    });
    const second = await buildNativeReconciliationEnvelope({
      runId: "run-envelope-test",
      taskId: "task-envelope-test",
      sourceRevisionToken,
      proposalSchemaId: "narrative.codex-relation.create",
      reconcilerId: "grimodex.codex-structure-extraction",
      evidenceSet: [
        {
          evidenceRef: "anchor-relation",
          documentRef: "D000001",
          quoteDigest,
        },
      ],
    });

    expect(first.proposalSchemaId).toBe("narrative.codex-entity.bind");
    expect(second.proposalSchemaId).toBe("narrative.codex-relation.create");
    expect(first.evidenceSet[0]?.evidenceRef).toBe("anchor-entity");
    expect(second.evidenceSet[0]?.evidenceRef).toBe("anchor-relation");
    expect(first.readSet).toEqual([
      { inputRef: "snapshot:run-envelope-test", kind: "snapshot-document" },
      { inputRef: "anchor-entity", kind: "evidence" },
    ]);
    expect(second.readSet).toEqual([
      { inputRef: "snapshot:run-envelope-test", kind: "snapshot-document" },
      { inputRef: "anchor-relation", kind: "evidence" },
    ]);
    expect(first.readSetDigest).not.toBe(second.readSetDigest);
  });

  it("rejects an unbound source or empty evidence set", async () => {
    await expect(
      buildNativeReconciliationEnvelope({
        runId: "run-envelope-test",
        taskId: "task-envelope-test",
        sourceRevisionToken: "",
        proposalSchemaId: "narrative.test",
        evidenceSet: [{ evidenceRef: "anchor-1", documentRef: "D000001" }],
      }),
    ).rejects.toThrow("immutable source revision token");

    await expect(
      buildNativeReconciliationEnvelope({
        runId: "run-envelope-test",
        taskId: "task-envelope-test",
        sourceRevisionToken,
        proposalSchemaId: "narrative.test",
        evidenceSet: [],
      }),
    ).rejects.toThrow("without proposal evidence");
  });
});
