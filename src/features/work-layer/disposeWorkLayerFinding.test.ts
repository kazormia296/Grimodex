import { describe, expect, it } from "vitest";

import { WORK_LAYER_FIXTURE } from "./workLayerFixture";
import { disposeWorkLayerFinding } from "./disposeWorkLayerFinding";
import { disposedFindingLedgerItemId } from "./workLedgerItems";

describe("disposeWorkLayerFinding", () => {
  it.each(["held", "basis-ignored"] as const)(
    "moves one active Finding into the %s preview disposition",
    (disposition) => {
      const finding = WORK_LAYER_FIXTURE.attention[1];
      const result = disposeWorkLayerFinding(
        WORK_LAYER_FIXTURE,
        finding.id,
        disposition,
      );

      expect(result.attention.map((item) => item.id)).not.toContain(finding.id);
      expect(result.disposedAttention.at(-1)).toEqual({
        id: finding.id,
        title: finding.title,
        disposition,
      });
      expect(
        result.allWork?.find(
          (item) => item.id === disposedFindingLedgerItemId(finding.id),
        ),
      ).toEqual({
        id: disposedFindingLedgerItemId(finding.id),
        title: finding.title,
        status: "held",
        tag: disposition === "held" ? "HOLD" : "BASIS IGNORED",
      });
    },
  );

  it("replaces an existing ledger projection by its Finding identity", () => {
    const finding = WORK_LAYER_FIXTURE.attention[1];
    const existingLedgerItemId = disposedFindingLedgerItemId(finding.id);
    const result = disposeWorkLayerFinding(
      {
        ...WORK_LAYER_FIXTURE,
        allWork: [
          {
            id: existingLedgerItemId,
            title: "古い表示名",
            status: "waiting",
            detail: "保持する台帳詳細",
          },
        ],
      },
      finding.id,
      "held",
    );

    expect(result.allWork).toEqual([
      {
        id: existingLedgerItemId,
        title: finding.title,
        status: "held",
        detail: "保持する台帳詳細",
        tag: "HOLD",
      },
    ]);
  });
});
