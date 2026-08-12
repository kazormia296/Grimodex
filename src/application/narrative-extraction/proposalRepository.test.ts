import { describe, expect, it } from "vitest";

import { buildNativeReconciliationEnvelope } from "./proposalRepository";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";

const sourceRevisionToken =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const quote = "A witness quote.";

describe("buildNativeReconciliationEnvelope", () => {
  it("binds schema, source, read-set, and evidence per proposal", async () => {
    const quoteDigest = await sha256Digest(quote);
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
          quote,
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
          quote,
          quoteDigest,
        },
      ],
    });

    expect(first.proposalSchemaId).toBe("narrative.codex-entity.bind");
    expect(second.proposalSchemaId).toBe("narrative.codex-relation.create");
    expect(first.evidenceSet[0]?.evidenceRef).toBe("anchor-entity");
    expect(second.evidenceSet[0]?.evidenceRef).toBe("anchor-relation");
    expect(first.evidenceSet[0]?.quote).toBe(quote);
    expect(first.evidenceSet[0]?.quoteDigest).toBe(quoteDigest);
    expect(first.readSet).toEqual([
      {
        inputRef: "snapshot:run-envelope-test",
        kind: "snapshot-document",
        sourceKind: "snapshot-document",
        revisionToken: sourceRevisionToken,
      },
      {
        inputRef: "evidence:anchor-entity",
        kind: "evidence",
        sourceKind: "evidence-anchor",
        revisionToken: sourceRevisionToken,
      },
    ]);
    expect(second.readSet).toEqual([
      {
        inputRef: "snapshot:run-envelope-test",
        kind: "snapshot-document",
        sourceKind: "snapshot-document",
        revisionToken: sourceRevisionToken,
      },
      {
        inputRef: "evidence:anchor-relation",
        kind: "evidence",
        sourceKind: "evidence-anchor",
        revisionToken: sourceRevisionToken,
      },
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

  it("rejects an evidence quote whose supplied digest is not its raw SHA-256", async () => {
    await expect(
      buildNativeReconciliationEnvelope({
        runId: "run-envelope-test",
        taskId: "task-envelope-test",
        sourceRevisionToken,
        proposalSchemaId: "narrative.test",
        evidenceSet: [
          {
            evidenceRef: "anchor-tampered",
            documentRef: "D000001",
            quote,
            quoteDigest: sourceRevisionToken,
          },
        ],
      }),
    ).rejects.toThrow("Evidence quote digest mismatch");
  });
});
