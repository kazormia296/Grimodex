import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/db/client", () => ({ db: {} }));

import { setEntryTags, setSnippetEntryTags } from "./tagApi";

describe("typed entity tag persistence", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("sets Codex tags without sending renderer-authored SQL", async () => {
    await setEntryTags("codex-1", ["tag-2", "tag-1"]);

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("entity_tags_set", {
      payload: {
        entityKind: "codex",
        entityId: "codex-1",
        tagIds: ["tag-2", "tag-1"],
        updatedAt: expect.any(String),
      },
    });
  });

  it("sets snippet tags through the same typed aggregate", async () => {
    await setSnippetEntryTags("snippet-1", []);

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("entity_tags_set", {
      payload: {
        entityKind: "snippet",
        entityId: "snippet-1",
        tagIds: [],
        updatedAt: null,
      },
    });
  });
});
