import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  value: [] as Array<{ content: string | null }>,
}));
const where = vi.hoisted(() => vi.fn(async () => rows.value));
const from = vi.hoisted(() => vi.fn(() => ({ where })));
const select = vi.hoisted(() => vi.fn(() => ({ from })));

vi.mock("@/db/client", () => ({ db: { select } }));
vi.mock("@/db/schema", () => ({
  treeNodes: {
    content: "content",
    projectId: "project_id",
  },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => "scope") }));

import { getProjectDataStats } from "./dataApi";

describe("getProjectDataStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.value = [];
  });

  it("counts non-empty scene documents and sums nested text", async () => {
    rows.value = [
      {
        content: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "abc" }] },
            { type: "paragraph", content: [{ type: "text", text: "日本" }] },
          ],
        }),
      },
      { content: "{}" },
      { content: null },
      { content: "{broken" },
    ];

    await expect(getProjectDataStats("project-1")).resolves.toEqual({
      sceneCount: 2,
      totalChars: 5,
    });
  });
});
