import { MastraVector } from "@mastra/core/vector";
import type { NapiMemoryVectorBackendLike } from "./napiMemoryBackend.js";

function decode<T>(wire: string): T {
  return JSON.parse(wire) as T;
}

/** Main-only vector adapter. Index names are isolated to the owning project. */
export class NativeMemoryVector extends MastraVector {
  constructor(
    private readonly backend: NapiMemoryVectorBackendLike,
    private readonly projectId: string,
  ) {
    super({ id: `native-memory-vector:${projectId}` });
  }

  private scopedIndex(indexName: string) {
    return `${this.projectId}:${indexName}`;
  }

  async createIndex(args: Parameters<MastraVector["createIndex"]>[0]) {
    return decode<Awaited<ReturnType<MastraVector["createIndex"]>>>(
      await this.backend.memoryVectorCreateIndex(
        this.scopedIndex(args.indexName),
        args.dimension,
      ),
    );
  }

  async upsert(args: Parameters<MastraVector["upsert"]>[0]) {
    const vectors = args.vectors.map((vector, index) => {
      const metadata = args.metadata?.[index] as
        | Record<string, unknown>
        | undefined;
      const messageId = metadata?.messageId ?? metadata?.message_id;
      if (typeof messageId !== "string") {
        throw new Error("Mastra vector metadata must include messageId");
      }
      const id = args.ids?.[index];
      if (!id) throw new Error("Mastra vector upsert requires ids");
      return {
        id,
        vector,
        metadata,
        messageId,
        projectId: this.projectId,
      };
    });
    return decode<Awaited<ReturnType<MastraVector["upsert"]>>>(
      await this.backend.memoryVectorUpsert(
        this.scopedIndex(args.indexName),
        vectors,
      ),
    );
  }

  async query(args: Parameters<MastraVector["query"]>[0]) {
    return decode<Awaited<ReturnType<MastraVector["query"]>>>(
      await this.backend.memoryVectorQuery(
        this.scopedIndex(args.indexName),
        args.queryVector ??
          (() => {
            throw new Error("Mastra vector query requires queryVector");
          })(),
        args.topK ?? 10,
      ),
    );
  }

  async listIndexes() {
    const indexes = decode<string[]>(
      await this.backend.memoryVectorListIndexes(),
    );
    const prefix = `${this.projectId}:`;
    return indexes
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length));
  }

  async describeIndex(args: Parameters<MastraVector["describeIndex"]>[0]) {
    const result = decode<Awaited<ReturnType<MastraVector["describeIndex"]>>>(
      await this.backend.memoryVectorDescribeIndex(
        this.scopedIndex(args.indexName),
      ),
    );
    return { ...result, indexName: args.indexName };
  }

  async deleteIndex(args: Parameters<MastraVector["deleteIndex"]>[0]) {
    return decode<Awaited<ReturnType<MastraVector["deleteIndex"]>>>(
      await this.backend.memoryVectorDeleteIndex(
        this.scopedIndex(args.indexName),
      ),
    );
  }

  async updateVector(args: Parameters<MastraVector["updateVector"]>[0]) {
    return decode<Awaited<ReturnType<MastraVector["updateVector"]>>>(
      await this.backend.memoryVectorUpdate(
        this.scopedIndex(args.indexName),
        args.id ??
          (() => {
            throw new Error("Mastra vector update requires id");
          })(),
        args.update.vector,
        args.update.metadata,
      ),
    );
  }

  async deleteVector(args: Parameters<MastraVector["deleteVector"]>[0]) {
    return decode<Awaited<ReturnType<MastraVector["deleteVector"]>>>(
      await this.backend.memoryVectorDelete(
        this.scopedIndex(args.indexName),
        args.id,
      ),
    );
  }

  async deleteVectors(args: Parameters<MastraVector["deleteVectors"]>[0]) {
    const messageIds = (args.filter as Record<string, unknown> | undefined)
      ?.message_id;
    const values =
      messageIds && typeof messageIds === "object"
        ? (messageIds as { $in?: unknown }).$in
        : undefined;
    const request =
      args.ids ??
      (Array.isArray(values) &&
      values.every((value) => typeof value === "string")
        ? { messageIds: values }
        : undefined);
    if (!request)
      throw new Error("Mastra vector deletion requires ids or message_id.$in");
    return decode<Awaited<ReturnType<MastraVector["deleteVectors"]>>>(
      await this.backend.memoryVectorDeleteMany(
        this.scopedIndex(args.indexName),
        request as never,
      ),
    );
  }
}
