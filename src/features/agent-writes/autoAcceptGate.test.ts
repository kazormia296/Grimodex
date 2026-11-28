import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAiPolicy } from "@/features/ai-policy/parse";
import { DEFAULT_AI_POLICY } from "@/features/ai-policy/types";

const h = vi.hoisted(() => ({ project: null as { aiPolicy?: string } | null }));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(async () => h.project),
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ getBoolean: () => true }) },
}));

import { isAutoAcceptEnabled } from "./autoAcceptGate";

beforeEach(() => {
  h.project = null;
});

describe("isAutoAcceptEnabled", () => {
  it("keeps auto-accept off when the Project lookup returns null", async () => {
    await expect(isAutoAcceptEnabled("missing-project")).resolves.toBe(false);
  });

  it("follows bodyWrite for a loaded Project", async () => {
    h.project = { aiPolicy: serializeAiPolicy(DEFAULT_AI_POLICY) };
    await expect(isAutoAcceptEnabled("loaded-project")).resolves.toBe(true);
  });
});
