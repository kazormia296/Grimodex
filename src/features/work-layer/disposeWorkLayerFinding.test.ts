import { describe, expect, it } from "vitest";

import { WORK_LAYER_FIXTURE } from "./workLayerFixture";
import { disposeWorkLayerFinding } from "./disposeWorkLayerFinding";

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
    },
  );
});
