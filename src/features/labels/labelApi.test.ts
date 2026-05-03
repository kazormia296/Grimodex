import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWhere, mockReturning, mockOrderBy } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
  mockReturning: vi.fn(),
  mockOrderBy: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockWhere,
        innerJoin: vi.fn(() => ({ where: mockWhere })),
        orderBy: mockOrderBy,
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockWhere,
        returning: mockReturning,
      })),
    })),
    delete: vi.fn(() => ({ where: mockWhere })),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

vi.mock("@/db/schema", () => ({
  labels: {
    id: "id",
    projectId: "projectId",
    name: "name",
    color: "color",
    sortOrder: "sortOrder",
    createdAt: "createdAt",
  },
  treeNodeLabels: {
    nodeId: "nodeId",
    labelId: "labelId",
  },
}));

import {
  listLabels,
  listNodeLabels,
  listNodeLabelIds,
  setNodeLabels,
  countNodesWithLabel,
  listAllNodeLabels,
} from "./labelApi";
import { db } from "@/db/client";
const mockDb = vi.mocked(db);

type Label = {
  id: string;
  projectId: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: string;
};

function makeLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: "lbl-1",
    projectId: "proj-1",
    name: "テストラベル",
    color: "red",
    sortOrder: 0,
    createdAt: "2024-01-01",
    ...overrides,
  };
}

describe("listLabels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("プロジェクトIDでフィルタして Label[] を返す", async () => {
    const lbl = makeLabel();
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([lbl]);

    const result = await listLabels("proj-1");

    expect(result).toEqual([lbl]);
  });
});

describe("listNodeLabels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ノードに紐付く Label[] を返す", async () => {
    const lbl = makeLabel({ id: "lbl-2" });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([{ label: lbl }]);

    const result = await listNodeLabels("node-1");

    expect(result).toEqual([lbl]);
  });

  it("紐付きがない場合は空配列を返す", async () => {
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockResolvedValue([]);

    const result = await listNodeLabels("node-x");

    expect(result).toEqual([]);
  });
});

describe("listNodeLabelIds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ノードに紐付く labelId[] を返す", async () => {
    mockWhere.mockResolvedValue([{ labelId: "lbl-1" }, { labelId: "lbl-2" }]);

    const result = await listNodeLabelIds("node-1");

    expect(result).toEqual(["lbl-1", "lbl-2"]);
  });
});

describe("setNodeLabels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("labelIds が空のとき delete のみ実行し insert しない", async () => {
    mockWhere.mockResolvedValue(undefined);

    await setNodeLabels("node-1", []);

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("labelIds がある場合 delete → insert の順で実行する", async () => {
    const ops: string[] = [];
    const deleteWhere = vi.fn(async () => {
      ops.push("delete");
    });
    const insertValues = vi.fn(async () => {
      ops.push("insert");
    });
    mockDb.delete.mockReturnValue({ where: deleteWhere } as never);
    mockDb.insert.mockReturnValue({ values: insertValues } as never);

    await setNodeLabels("node-1", ["lbl-1", "lbl-2"]);

    expect(ops).toEqual(["delete", "insert"]);
  });
});

describe("countNodesWithLabel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("件数を返す", async () => {
    mockWhere.mockResolvedValue([{ count: 3 }]);

    const result = await countNodesWithLabel("lbl-1");

    expect(result).toBe(3);
  });

  it("結果が空のとき 0 を返す", async () => {
    mockWhere.mockResolvedValue([]);

    const result = await countNodesWithLabel("lbl-x");

    expect(result).toBe(0);
  });
});

describe("listAllNodeLabels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("nodeId をキー、labelId[] を値とした Record を返す", async () => {
    mockWhere.mockResolvedValue([
      { nodeId: "n1", labelId: "l1" },
      { nodeId: "n1", labelId: "l2" },
      { nodeId: "n2", labelId: "l1" },
    ]);

    const result = await listAllNodeLabels("proj-1");

    expect(result).toEqual({
      n1: ["l1", "l2"],
      n2: ["l1"],
    });
  });

  it("紐付きがない場合は空 Record を返す", async () => {
    mockWhere.mockResolvedValue([]);

    const result = await listAllNodeLabels("proj-x");

    expect(result).toEqual({});
  });
});
