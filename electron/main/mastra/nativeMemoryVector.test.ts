import { describe, expect, it, vi } from "vitest";
import type { NapiMemoryVectorBackendLike } from "./napiMemoryBackend.js";
import { NativeMemoryVector } from "./nativeMemoryVector.js";

const json = (value: unknown) => JSON.stringify(value);

function mockVector() {
  const calls: unknown[][] = [];
  let hasVector = true;
  const method = (name: string, result: unknown = null) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return json(result);
    });
  const backend = {
    memoryVectorCreateIndex: method("createIndex"),
    memoryVectorUpsert: method("upsert", ["v1"]),
    memoryVectorQuery: vi.fn(async (...args: unknown[]) => {
      calls.push(["query", ...args]);
      return json(
        hasVector
          ? [{ id: "v1", score: 1, metadata: { messageId: "m1" } }]
          : [],
      );
    }),
    memoryVectorListIndexes: method("listIndexes", ["p1:memory", "p2:memory"]),
    memoryVectorDescribeIndex: method("describeIndex", {
      indexName: "p1:memory",
      dimension: 2,
      count: 1,
    }),
    memoryVectorDeleteIndex: method("deleteIndex"),
    memoryVectorUpdate: method("update"),
    memoryVectorDelete: method("delete"),
    memoryVectorDeleteMany: vi.fn(async (...args: unknown[]) => {
      calls.push(["deleteMany", ...args]);
      hasVector = false;
      return json(null);
    }),
  } as unknown as NapiMemoryVectorBackendLike;
  return { calls, backend, vector: new NativeMemoryVector(backend, "p1") };
}

describe("NativeMemoryVector", () => {
  it("maps all vector methods to project-scoped Native commands", async () => {
    const { calls, vector } = mockVector();
    await vector.createIndex({ indexName: "memory", dimension: 2 });
    await vector.upsert({
      indexName: "memory",
      ids: ["v1"],
      vectors: [[1, 0]],
      metadata: [{ messageId: "m1" }],
    });
    await vector.query({ indexName: "memory", queryVector: [1, 0], topK: 4 });
    await expect(vector.listIndexes()).resolves.toEqual(["memory"]);
    await vector.describeIndex({ indexName: "memory" });
    await vector.updateVector({
      indexName: "memory",
      id: "v1",
      update: { metadata: { tag: "x" } },
    });
    await vector.deleteVector({ indexName: "memory", id: "v1" });
    await vector.deleteVectors({
      indexName: "memory",
      filter: { message_id: { $in: ["m1"] } },
    });
    await vector.deleteIndex({ indexName: "memory" });

    expect(calls).toEqual([
      ["createIndex", "p1:memory", 2],
      [
        "upsert",
        "p1:memory",
        [
          {
            id: "v1",
            vector: [1, 0],
            metadata: { messageId: "m1" },
            messageId: "m1",
            projectId: "p1",
          },
        ],
      ],
      ["query", "p1:memory", [1, 0], 4],
      ["listIndexes"],
      ["describeIndex", "p1:memory"],
      ["update", "p1:memory", "v1", undefined, { tag: "x" }],
      ["delete", "p1:memory", "v1"],
      ["deleteMany", "p1:memory", { messageIds: ["m1"] }],
      ["deleteIndex", "p1:memory"],
    ]);
  });

  it("keeps an InMemory comparison frame for vector upsert, query, and delete", async () => {
    const { vector: native } = mockVector();
    const memory = new Map<
      string,
      { id: string; vector: number[]; metadata: Record<string, unknown> }
    >();
    const input = {
      indexName: "memory",
      ids: ["v1"],
      vectors: [[1, 0]],
      metadata: [{ messageId: "m1" }],
    };
    await native.createIndex({ indexName: input.indexName, dimension: 2 });
    await native.upsert(input);
    input.ids.forEach((id, index) =>
      memory.set(id, {
        id,
        vector: input.vectors[index],
        metadata: input.metadata[index],
      }),
    );
    const queries = await Promise.all([
      native.query({
        indexName: input.indexName,
        queryVector: [1, 0],
        topK: 1,
      }),
      Promise.resolve(
        [...memory.values()]
          .map(({ id, vector }) => ({ id, score: vector[0] }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 1),
      ),
    ]);
    expect(queries.map((rows) => rows.map(({ id }) => id))).toEqual([
      ["v1"],
      ["v1"],
    ]);
    await native.deleteVectors({ indexName: input.indexName, ids: ["v1"] });
    memory.delete("v1");
    const afterDelete = await Promise.all([
      native.query({
        indexName: input.indexName,
        queryVector: [1, 0],
        topK: 1,
      }),
      Promise.resolve([...memory.values()]),
    ]);
    expect(afterDelete.map((rows) => rows.length)).toEqual([0, 0]);
  });
});
