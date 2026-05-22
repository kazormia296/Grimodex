import { describe, it, expect } from "vitest";
import { buildSceneForeshadowInfoIndex } from "./api";
import type { ForeshadowRow } from "./types";

function makeRow(overrides: Partial<ForeshadowRow> = {}): ForeshadowRow {
  return {
    id: "f1",
    projectId: "p1",
    title: "伏線",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: false,
    loadBearing: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

describe("buildSceneForeshadowInfoIndex", () => {
  it("maps setup and payoff foreshadow ids by scene", () => {
    const index = buildSceneForeshadowInfoIndex(
      [
        makeRow({ id: "f-setup", payoffSceneId: null }),
        makeRow({ id: "f-payoff", payoffSceneId: "scene-payoff" }),
      ],
      [
        { foreshadowId: "f-setup", sceneId: "scene-setup" },
        { foreshadowId: "f-setup", sceneId: "scene-setup" },
      ],
    );

    expect(index["scene-setup"]).toEqual({
      setupForeshadowIds: ["f-setup"],
      payoffForeshadowIds: [],
    });
    expect(index["scene-payoff"]).toEqual({
      setupForeshadowIds: [],
      payoffForeshadowIds: ["f-payoff"],
    });
  });

  it("returns empty object when no rows", () => {
    expect(buildSceneForeshadowInfoIndex([], [])).toEqual({});
  });
});
