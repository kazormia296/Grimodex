import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// L1: runtime policy gate lives at the top of runAiTreeGeneration, independent of
// the React dialog. These tests drive it directly via a mocked policyGuard.
const h = vi.hoisted(() => ({ blocked: new Set<string>() }));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  isAiFeatureBlockedByPolicy: (f: string) => h.blocked.has(f),
}));
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-1",
}));
vi.mock("@/features/project/contextAtoms", () => ({
  fetchProjectContext: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: { getState: () => ({ settings: { model: "m" } }) },
}));
vi.mock("../treeStore", () => ({
  useTreeStore: {
    getState: () => ({ nodes: [], reloadTreeOrThrow: vi.fn() }),
  },
}));

import { runAiTreeGeneration } from "./runAiTreeGeneration";
import { invoke } from "@/lib/tauri";

describe("runAiTreeGeneration — runtime policy gate (L1 / double-gate #11)", () => {
  beforeEach(() => {
    h.blocked = new Set();
    (invoke as Mock).mockClear();
  });

  it("throws and never calls invoke when structureWrite is blocked", async () => {
    h.blocked = new Set(["structureWrite"]);
    await expect(
      runAiTreeGeneration({
        mode: "scaffold",
        rootRef: null,
        instruction: "x",
        withSynopsis: false,
      }),
    ).rejects.toThrow(/structureWrite/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires bodyWrite too when withSynopsis (structureWrite allowed, bodyWrite blocked)", async () => {
    h.blocked = new Set(["bodyWrite"]);
    await expect(
      runAiTreeGeneration({
        mode: "scaffold",
        rootRef: null,
        instruction: "x",
        withSynopsis: true,
      }),
    ).rejects.toThrow(/bodyWrite/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does NOT block on bodyWrite when withSynopsis is false", async () => {
    h.blocked = new Set(["bodyWrite"]);
    // bodyWrite off but no synopsis requested -> the gate must NOT reject for bodyWrite;
    // it proceeds past the gate (and fails later inside generate, which is fine here).
    await expect(
      runAiTreeGeneration({
        mode: "scaffold",
        rootRef: null,
        instruction: "x",
        withSynopsis: false,
      }),
    ).rejects.not.toThrow(/policy is disabled/);
  });
});
