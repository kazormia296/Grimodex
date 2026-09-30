import { describe, expect, it } from "vitest";

import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import { buildLiveChronicleExistingEventCatalogEnvelope } from "./existingEventCatalog";

describe("live Chronicle existing-event catalog", () => {
  it("pins the byte-identical fresh-start/Native canonical digest", async () => {
    const catalog = buildLiveChronicleExistingEventCatalogEnvelope([
      {
        id: "event:a",
        title: "Alpha",
        note: "note",
        version: 1,
        startTime: null,
        endTime: 99,
      },
      {
        id: "event:b",
        title: "宿舎が砲撃される",
        note: null,
        version: 2,
        startTime: 12,
        endTime: null,
      },
    ]);

    await expect(digestStableJson(catalog)).resolves.toBe(
      "sha256:3a7548c257c0284af4b435d24c105a159eaa43fc512da14270659096640c3780",
    );
  });
});
