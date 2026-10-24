import { describe, expect, it, vi } from "vitest";
import { createStickyDraftController } from "./stickyDraftController";

// W-1 (K3/2; DR-DA2B-R8): from activation stage 4 to 7 the generic DB write
// of a sticky body is refused. The draft keeps the unsaved body and the next
// save (the next edit, blur or quiescence flush) writes it.

describe("sticky draft and a refused write", () => {
  it("keeps the body dirty after a D2a refusal and writes it on the next save", async () => {
    const persist = vi
      .fn<(body: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new Error(
          "db_execute rejected: D2A_EGRESS_DENIED: plaintext-publication: route db_execute is unavailable in profile local-only mode",
        ),
      )
      .mockResolvedValue(undefined);
    const draft = createStickyDraftController("s1", "{}");
    draft.setPersist(persist);
    draft.markDirty('{"type":"doc","content":[{"type":"text","text":"x"}]}');

    await expect(draft.save()).rejects.toThrow("D2A_EGRESS_DENIED");
    expect(draft.dirty).toBe(true);

    await draft.save();
    expect(draft.dirty).toBe(false);
    expect(persist.mock.calls.map(([body]) => body)).toEqual([
      '{"type":"doc","content":[{"type":"text","text":"x"}]}',
      '{"type":"doc","content":[{"type":"text","text":"x"}]}',
    ]);
  });
});
