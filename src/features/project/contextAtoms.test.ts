import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: { title: "Test", aiPolicy: "not-json" },
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "p1" }) },
}));
vi.mock("./api", () => ({ getProject: vi.fn(async () => h.project) }));

import { fetchProjectContext } from "./contextAtoms";

describe("fetchProjectContext AI policy", () => {
  it("marks body writing disabled when the loaded policy is invalid", async () => {
    await expect(fetchProjectContext("p1")).resolves.toMatchObject({
      title: "Test",
      bodyWriteDisabled: true,
    });
  });
});
