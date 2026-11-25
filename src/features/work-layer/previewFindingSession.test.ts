import { describe, expect, it } from "vitest";

import {
  createPreviewFindingSessionState,
  deriveActivePreviewAttention,
  recordPreviewFindingDisposition,
} from "./previewFindingSession";
import { WORK_LAYER_FIXTURE } from "./workLayerFixture";
import { modelForPrototypeMode } from "./workLayerPrototype";

describe("preview Finding session", () => {
  it("filters preview dispositions only inside their originating scope", () => {
    const model = modelForPrototypeMode("ambient", WORK_LAYER_FIXTURE);
    const [firstFinding, secondFinding] = model.attention;
    expect(firstFinding).toBeDefined();
    expect(secondFinding).toBeDefined();
    if (firstFinding == null || secondFinding == null) return;

    const resolved = recordPreviewFindingDisposition(
      createPreviewFindingSessionState(model.scopeId),
      model.scopeId,
      firstFinding.id,
      "resolved",
    );
    const held = recordPreviewFindingDisposition(
      resolved,
      model.scopeId,
      secondFinding.id,
      "held",
    );

    expect(deriveActivePreviewAttention(model, held)).toEqual([]);
    expect(
      deriveActivePreviewAttention(
        { ...model, scopeId: "other-preview" },
        held,
      ),
    ).toEqual(model.attention);
  });
});
