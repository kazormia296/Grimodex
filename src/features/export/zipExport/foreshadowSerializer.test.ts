import { describe, it, expect } from "vitest";
import { serializeForeshadow } from "./foreshadowSerializer";
import type {
  ForeshadowRow,
  ForeshadowSetupRow,
} from "@/features/foreshadow/types";

describe("foreshadowSerializer", () => {
  const foreshadow: ForeshadowRow = {
    id: "f1",
    projectId: "p1",
    title: "Hidden Key",
    intent: "Reveal later",
    notes: "Plant early",
    payoffSceneId: "scene-payoff",
    payoffFromPos: 340,
    payoffToPos: 410,
    payoffConfirmed: false,
    abandoned: false,
    secret: true,
    loadBearing: "critical",
    version: 0,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
  };

  const setup: ForeshadowSetupRow = {
    id: "s1",
    foreshadowId: "f1",
    sceneId: "scene-setup",
    fromPos: 120,
    toPos: 180,
    kind: "designated_existing",
    strength: "subtle",
    aiStrength: null,
    aiReasoning: null,
    attribution: "human",
    aiRationale: null,
    lastEvaluatedAt: null,
    isOrphan: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  const scenePathById = new Map([
    [
      "scene-setup",
      {
        sceneId: "scene-setup",
        relativePath: "chapters/01-ch1/01-opening.md",
        slug: "opening",
      },
    ],
    [
      "scene-payoff",
      {
        sceneId: "scene-payoff",
        relativePath: "chapters/03-ch3/01-climax.md",
        slug: "climax",
      },
    ],
  ]);

  it("resolves setup and payoff scene relative paths", () => {
    const md = serializeForeshadow({
      foreshadow,
      setups: [setup],
      linkedCodexNames: ["Alice"],
      scenePathById,
    });

    expect(md).toContain('linked_codex: ["Alice"]');
    expect(md).toContain(
      "- chapters/01-ch1/01-opening.md  (range 120-180, kind=designated_existing, strength=subtle, attribution=human)",
    );
    expect(md).toContain("- chapters/03-ch3/01-climax.md  (range 340-410)");
  });
});
