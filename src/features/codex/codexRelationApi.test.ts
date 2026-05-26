import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", () => ({
  codexRelations: {
    relationType: "relationType",
    fromCodexId: "fromCodexId",
    toCodexId: "toCodexId",
    createdAt: "createdAt",
    id: "id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
}));

import { db } from "@/db/client";
import { findCodexRelationByEdgeEndpoints } from "./codexRelationApi";

const mockDb = vi.mocked(db);

function mockSelectChain(rows: Record<string, unknown>[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  mockDb.select.mockReturnValue(chain as never);
  return chain;
}

describe("findCodexRelationByEdgeEndpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches reverse direction for the same relation type", async () => {
    mockSelectChain([
      {
        id: "rel-ab",
        fromCodexId: "a",
        toCodexId: "b",
        relationType: "custom",
      },
    ]);

    const found = await findCodexRelationByEdgeEndpoints("b", "a", "custom");

    expect(found?.id).toBe("rel-ab");
    const chain = mockDb.select.mock.results[0]?.value as {
      where: ReturnType<typeof vi.fn>;
      orderBy: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(chain.where).toHaveBeenCalledOnce();
    expect(chain.orderBy).toHaveBeenCalledOnce();
    expect(chain.limit).toHaveBeenCalledWith(1);
  });
});
