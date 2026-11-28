import { MemoryStorage, type StorageOrderBy } from "@mastra/core/storage";
import type { NapiMemoryBackendLike } from "./napiMemoryBackend.js";

function decode<T>(wire: string): T {
  const fromWire = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fromWire);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          (key === "createdAt" || key === "updatedAt") &&
          typeof entry === "string"
            ? new Date(entry)
            : fromWire(entry),
        ]),
      );
    }
    return value;
  };
  return fromWire(JSON.parse(wire)) as T;
}

function unsupported(method: string): Error {
  return new Error(
    `Mastra memory storage method is not implemented: ${method}`,
  );
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nativeOrderBy(orderBy: StorageOrderBy) {
  switch (orderBy.direction) {
    case undefined:
      return orderBy;
    case "ASC":
      return { ...orderBy, direction: "asc" };
    case "DESC":
      return { ...orderBy, direction: "desc" };
    default:
      throw new TypeError("Invalid Mastra memory sort direction");
  }
}

const OM_FIELDS = new Set([
  "updatedAt",
  "lastObservedAt",
  "originType",
  "generationCount",
  "supersededBy",
  "activeObservations",
  "bufferedObservationChunks",
  "bufferedObservations",
  "bufferedObservationTokens",
  "bufferedMessageIds",
  "bufferedReflection",
  "bufferedReflectionTokens",
  "bufferedReflectionInputTokens",
  "reflectedObservationLineCount",
  "observedMessageIds",
  "observedTimezone",
  "totalTokensObserved",
  "observationTokenCount",
  "pendingMessageTokens",
  "isReflecting",
  "isObserving",
  "isBufferingObservation",
  "isBufferingReflection",
  "lastBufferedAtTokens",
  "lastBufferedAtTime",
  "config",
  "metadata",
]);

function omRecord(args: unknown[]): Record<string, unknown> {
  const [first, second] = args;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  if (second && typeof second === "object" && !Array.isArray(second)) {
    return { ...(second as Record<string, unknown>), id: first };
  }
  return { id: first, value: second };
}

/** Main-only adapter. Persistence and validation stay in the typed Native commands. */
export class NativeMemoryStorage extends MemoryStorage {
  readonly supportsObservationalMemory = true;
  readonly supportsPartialThreadUpdate = true;
  readonly supportsAtomicWorkingMemoryMerge = false;

  supportsRunFencing(): false {
    return false;
  }

  constructor(
    private readonly backend: NapiMemoryBackendLike,
    private readonly projectId: string,
  ) {
    super();
  }

  async dangerouslyClearAll(): Promise<void> {
    throw unsupported("dangerouslyClearAll");
  }

  async getThreadById(args: Parameters<MemoryStorage["getThreadById"]>[0]) {
    return decode<Awaited<ReturnType<MemoryStorage["getThreadById"]>>>(
      await this.backend.memoryThreadRead({ operation: "get", ...args }),
    );
  }

  async saveThread(args: Parameters<MemoryStorage["saveThread"]>[0]) {
    const { id, resourceId, title, createdAt, updatedAt, metadata } =
      args.thread;
    return decode<Awaited<ReturnType<MemoryStorage["saveThread"]>>>(
      await this.backend.memoryThreadWrite({
        operation: "save",
        thread: {
          id,
          resourceId,
          ...(title === undefined ? {} : { title }),
          createdAt: isoDate(createdAt),
          updatedAt: isoDate(updatedAt),
          ...(metadata === undefined ? {} : { metadata }),
        },
      }),
    );
  }

  async updateThread(args: Parameters<MemoryStorage["updateThread"]>[0]) {
    const { id, title, metadata } = args;
    return decode<Awaited<ReturnType<MemoryStorage["updateThread"]>>>(
      await this.backend.memoryThreadWrite({
        operation: "update",
        id,
        ...(title === undefined ? {} : { title }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    );
  }

  async deleteThread(args: Parameters<MemoryStorage["deleteThread"]>[0]) {
    await this.backend.memoryThreadDelete(args);
  }

  async copyThread(
    ..._args: Parameters<MemoryStorage["copyThread"]>
  ): ReturnType<MemoryStorage["copyThread"]> {
    throw unsupported("copyThread");
  }
  async cloneThread(
    ..._args: Parameters<MemoryStorage["cloneThread"]>
  ): ReturnType<MemoryStorage["cloneThread"]> {
    throw unsupported("cloneThread");
  }
  async updateThreadResourceId(
    ..._args: Parameters<MemoryStorage["updateThreadResourceId"]>
  ): ReturnType<MemoryStorage["updateThreadResourceId"]> {
    throw unsupported("updateThreadResourceId");
  }
  async listMessagesByResourceId(
    ..._args: Parameters<MemoryStorage["listMessagesByResourceId"]>
  ): ReturnType<MemoryStorage["listMessagesByResourceId"]> {
    throw unsupported("listMessagesByResourceId");
  }

  async listThreads(args: Parameters<MemoryStorage["listThreads"]>[0]) {
    const { filter, orderBy, ...pagination } = args;
    return decode<Awaited<ReturnType<MemoryStorage["listThreads"]>>>(
      await this.backend.memoryThreadRead({
        operation: "list",
        ...pagination,
        ...(orderBy === undefined ? {} : { orderBy: nativeOrderBy(orderBy) }),
        ...filter,
      }),
    );
  }

  async listMessages(args: Parameters<MemoryStorage["listMessages"]>[0]) {
    const { threadId, resourceId, page, perPage, orderBy, filter } = args;
    return decode<Awaited<ReturnType<MemoryStorage["listMessages"]>>>(
      await this.backend.memoryMessageRead({
        operation: "list",
        threadId,
        ...(resourceId === undefined ? {} : { resourceId }),
        ...(page === undefined ? {} : { page }),
        ...(perPage === undefined ? {} : { perPage }),
        ...(orderBy === undefined ? {} : { orderBy: nativeOrderBy(orderBy) }),
        ...(filter?.dateRange === undefined
          ? {}
          : { dateRange: filter.dateRange }),
        ...(filter?.metadata === undefined
          ? {}
          : { metadata: filter.metadata }),
      }),
    );
  }

  async listMessagesById(
    args: Parameters<MemoryStorage["listMessagesById"]>[0],
  ) {
    return decode<Awaited<ReturnType<MemoryStorage["listMessagesById"]>>>(
      await this.backend.memoryMessageRead({ operation: "byId", ...args }),
    );
  }

  async saveMessages(args: Parameters<MemoryStorage["saveMessages"]>[0]) {
    return decode<Awaited<ReturnType<MemoryStorage["saveMessages"]>>>(
      await this.backend.memoryMessageWrite({
        operation: "save",
        messages: args.messages.map((message) => {
          const isInjected = (
            message as typeof message & { isInjected?: boolean }
          ).isInjected;
          return {
            id: message.id,
            threadId: message.threadId,
            role: message.role,
            createdAt: isoDate(message.createdAt),
            content: message.content,
            ...(isInjected === undefined ? {} : { isInjected }),
          };
        }),
      }),
    );
  }

  async updateMessages(args: Parameters<MemoryStorage["updateMessages"]>[0]) {
    return decode<Awaited<ReturnType<MemoryStorage["updateMessages"]>>>(
      await this.backend.memoryMessageWrite({
        operation: "update",
        messages: args.messages.map(({ id, content }) => ({ id, content })),
      }),
    );
  }

  async deleteMessages(
    ...args: Parameters<MemoryStorage["deleteMessages"]>
  ): Promise<void> {
    await this.backend.memoryMessageDelete({ messageIds: args[0] });
  }

  async getResourceById(args: Parameters<MemoryStorage["getResourceById"]>[0]) {
    const resource = decode<
      Awaited<ReturnType<MemoryStorage["getResourceById"]>>
    >(
      await this.backend.memoryResourceRead({
        operation: "get",
        projectId: this.projectId,
      }),
    );
    return resource?.id === args.resourceId ? resource : null;
  }

  async saveResource(args: Parameters<MemoryStorage["saveResource"]>[0]) {
    const { id, workingMemory, metadata } = args.resource;
    return decode<Awaited<ReturnType<MemoryStorage["saveResource"]>>>(
      await this.backend.memoryResourceWrite({
        operation: "save",
        id,
        projectId: this.projectId,
        ...(workingMemory === undefined ? {} : { workingMemory }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    );
  }

  async updateResource(args: Parameters<MemoryStorage["updateResource"]>[0]) {
    const { resourceId, workingMemory, metadata } = args;
    return decode<Awaited<ReturnType<MemoryStorage["updateResource"]>>>(
      await this.backend.memoryResourceWrite({
        operation: "update",
        id: resourceId,
        ...(workingMemory === undefined ? {} : { workingMemory }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    );
  }

  async mergeResourceWorkingMemory(
    args: Parameters<MemoryStorage["mergeResourceWorkingMemory"]>[0],
  ) {
    const resource = await this.getResourceById({
      resourceId: args.resourceId,
    });
    return this.updateResource({
      resourceId: args.resourceId,
      workingMemory: args.merge(resource?.workingMemory),
    });
  }

  async getObservationalMemory(
    ...args: Parameters<MemoryStorage["getObservationalMemory"]>
  ): ReturnType<MemoryStorage["getObservationalMemory"]> {
    return this.readObservationalMemory("get", args) as ReturnType<
      MemoryStorage["getObservationalMemory"]
    >;
  }
  async getObservationalMemoryHistory(
    ...args: Parameters<MemoryStorage["getObservationalMemoryHistory"]>
  ): ReturnType<MemoryStorage["getObservationalMemoryHistory"]> {
    return this.readObservationalMemory("history", args) as ReturnType<
      MemoryStorage["getObservationalMemoryHistory"]
    >;
  }
  async initializeObservationalMemory(
    ...args: Parameters<MemoryStorage["initializeObservationalMemory"]>
  ): ReturnType<MemoryStorage["initializeObservationalMemory"]> {
    return this.saveObservationalMemory(args[0]) as ReturnType<
      MemoryStorage["initializeObservationalMemory"]
    >;
  }
  async updateActiveObservations(
    ...args: Parameters<MemoryStorage["updateActiveObservations"]>
  ): ReturnType<MemoryStorage["updateActiveObservations"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["updateActiveObservations"]
    >;
  }
  async commitActiveObservations(
    ...args: Parameters<MemoryStorage["commitActiveObservations"]>
  ): ReturnType<MemoryStorage["commitActiveObservations"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["commitActiveObservations"]
    >;
  }
  async updateBufferedObservations(
    ...args: Parameters<MemoryStorage["updateBufferedObservations"]>
  ): ReturnType<MemoryStorage["updateBufferedObservations"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["updateBufferedObservations"]
    >;
  }
  async appendBufferedObservations(
    ...args: Parameters<MemoryStorage["appendBufferedObservations"]>
  ): ReturnType<MemoryStorage["appendBufferedObservations"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["appendBufferedObservations"]
    >;
  }
  async swapBufferedToActive(
    ...args: Parameters<MemoryStorage["swapBufferedToActive"]>
  ): ReturnType<MemoryStorage["swapBufferedToActive"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["swapBufferedToActive"]
    >;
  }
  async createReflectionGeneration(
    ...args: Parameters<MemoryStorage["createReflectionGeneration"]>
  ): ReturnType<MemoryStorage["createReflectionGeneration"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["createReflectionGeneration"]
    >;
  }
  async updateBufferedReflection(
    ...args: Parameters<MemoryStorage["updateBufferedReflection"]>
  ): ReturnType<MemoryStorage["updateBufferedReflection"]> {
    return this.updateObservationalMemoryVoid(args);
  }
  async swapBufferedReflectionToActive(
    ...args: Parameters<MemoryStorage["swapBufferedReflectionToActive"]>
  ): ReturnType<MemoryStorage["swapBufferedReflectionToActive"]> {
    return this.updateObservationalMemory(args) as ReturnType<
      MemoryStorage["swapBufferedReflectionToActive"]
    >;
  }
  async setReflectingFlag(
    ...args: Parameters<MemoryStorage["setReflectingFlag"]>
  ): ReturnType<MemoryStorage["setReflectingFlag"]> {
    return this.updateObservationalMemoryVoid(args, "isReflecting");
  }
  async setObservingFlag(
    ...args: Parameters<MemoryStorage["setObservingFlag"]>
  ): ReturnType<MemoryStorage["setObservingFlag"]> {
    return this.updateObservationalMemoryVoid(args, "isObserving");
  }
  async setBufferingObservationFlag(
    ...args: Parameters<MemoryStorage["setBufferingObservationFlag"]>
  ): ReturnType<MemoryStorage["setBufferingObservationFlag"]> {
    return this.updateObservationalMemoryVoid(args, "isBufferingObservation");
  }
  async setBufferingReflectionFlag(
    ...args: Parameters<MemoryStorage["setBufferingReflectionFlag"]>
  ): ReturnType<MemoryStorage["setBufferingReflectionFlag"]> {
    return this.updateObservationalMemoryVoid(args, "isBufferingReflection");
  }
  async insertObservationalMemoryRecord(
    ...args: Parameters<MemoryStorage["insertObservationalMemoryRecord"]>
  ): ReturnType<MemoryStorage["insertObservationalMemoryRecord"]> {
    return this.saveObservationalMemoryVoid(args[0]);
  }
  async clearObservationalMemory(
    ...args: Parameters<MemoryStorage["clearObservationalMemory"]>
  ): ReturnType<MemoryStorage["clearObservationalMemory"]> {
    const [threadId, resourceId] = args;
    return this.writeObservationalMemoryVoid({
      operation: "clear",
      threadId,
      resourceId,
    });
  }
  async setPendingMessageTokens(
    ...args: Parameters<MemoryStorage["setPendingMessageTokens"]>
  ): ReturnType<MemoryStorage["setPendingMessageTokens"]> {
    return this.updateObservationalMemoryVoid(args, "pendingMessageTokens");
  }
  async updateObservationalMemoryConfig(
    ...args: Parameters<MemoryStorage["updateObservationalMemoryConfig"]>
  ): ReturnType<MemoryStorage["updateObservationalMemoryConfig"]> {
    return this.updateObservationalMemoryVoid(args, "config");
  }

  private readObservationalMemory(
    operation: "get" | "history",
    args: unknown[],
  ) {
    const [threadId, resourceId, limit] = args;
    return this.backend
      .memoryObservationalMemoryRead({
        operation,
        threadId: threadId ?? undefined,
        resourceId,
        ...(operation === "history" && limit !== undefined ? { limit } : {}),
      })
      .then((wire) => decode(wire));
  }

  private saveObservationalMemory(record: unknown) {
    const value =
      record && typeof record === "object" && "record" in record
        ? (record as { record: unknown }).record
        : record;
    return this.backend
      .memoryObservationalMemoryWrite({ operation: "save", record: value })
      .then((wire) => decode(wire));
  }

  private updateObservationalMemory(args: unknown[], field?: string) {
    const { id, value, ...values } = omRecord(args);
    const fields = Object.fromEntries(
      Object.entries(values).filter(([key]) => OM_FIELDS.has(key)),
    );
    if (field && !Object.hasOwn(fields, field))
      fields[field] = value ?? args[1];
    return this.backend
      .memoryObservationalMemoryWrite({ operation: "update", id, fields })
      .then((wire) => decode(wire));
  }

  private writeObservationalMemory(request: unknown) {
    return this.backend
      .memoryObservationalMemoryWrite(request)
      .then((wire) => decode(wire));
  }

  private async updateObservationalMemoryVoid(
    args: unknown[],
    field?: string,
  ): Promise<void> {
    await this.updateObservationalMemory(args, field);
  }

  private async saveObservationalMemoryVoid(record: unknown): Promise<void> {
    await this.saveObservationalMemory(record);
  }

  private async writeObservationalMemoryVoid(request: unknown): Promise<void> {
    await this.writeObservationalMemory(request);
  }
}
