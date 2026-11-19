import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    summary: string | null;
    contextMode: string;
  }>,
}));

vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async () => [],
}));
vi.mock("@/db/client", async () => {
  const { codexEntries } = await import("@/db/schema");
  const query = () => {
    let table: unknown;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      then: (
        resolve: (v: unknown[]) => unknown,
        reject: (r: unknown) => unknown,
      ) =>
        Promise.resolve(table === codexEntries ? h.rows : []).then(
          resolve,
          reject,
        ),
    };
    return chain;
  };
  return { db: { select: query } };
});

import {
  dropCodexHiddenFromAi,
  listCodexIdsHiddenFromAi,
  visibleCodexIdsForAi,
} from "./codexHiddenFromAi";
import { isCodexContextModeHiddenFromAi } from "./codexVisibilityPolicy";

describe("isCodexContextModeHiddenFromAi", () => {
  it("hidden と不明な値だけが秘匿で、suppress・mentioned・always は秘匿ではない", () => {
    expect(isCodexContextModeHiddenFromAi("hidden")).toBe(true);
    expect(isCodexContextModeHiddenFromAi("unknown-mode")).toBe(true);
    expect(isCodexContextModeHiddenFromAi("")).toBe(true);
    expect(isCodexContextModeHiddenFromAi("suppress")).toBe(false);
    expect(isCodexContextModeHiddenFromAi("mentioned")).toBe(false);
    expect(isCodexContextModeHiddenFromAi("always")).toBe(false);
  });
});

describe("listCodexIdsHiddenFromAi", () => {
  beforeEach(() => {
    h.rows = [
      { id: "m", summary: null, contextMode: "mentioned" },
      { id: "h", summary: null, contextMode: "hidden" },
      { id: "u", summary: null, contextMode: "weird" },
    ];
  });

  it("hidden・不明な mode・DB に無い id を秘匿に数える", async () => {
    const hidden = await listCodexIdsHiddenFromAi({
      entryIds: ["m", "h", "u", "gone"],
    });
    expect([...hidden].sort()).toEqual(["gone", "h", "u"]);
  });

  it("空の入力は DB を引かず空", async () => {
    expect((await listCodexIdsHiddenFromAi({ entryIds: [] })).size).toBe(0);
  });

  it("dropCodexHiddenFromAi は順序を保って hidden の行を除く", async () => {
    const rows = [{ id: "h" }, { id: "m" }];
    expect(await dropCodexHiddenFromAi(rows)).toEqual([{ id: "m" }]);
  });

  it("visibleCodexIdsForAi は DB が失敗したら何も渡さない", async () => {
    Object.defineProperty(h, "rows", {
      get() {
        throw new Error("db down");
      },
      configurable: true,
    });
    expect(await visibleCodexIdsForAi(["m"])).toEqual([]);
  });
});
