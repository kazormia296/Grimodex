import { MemoryStorage } from "@mastra/core/storage";
import type { NapiMemoryBackendLike } from "../../shared/ipcContract.js";

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

/** Main-only adapter. Persistence and validation stay in the typed Native commands. */
export class NativeMemoryStorage extends MemoryStorage {
  readonly supportsObservationalMemory = false;
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
    const { filter, ...pagination } = args;
    return decode<Awaited<ReturnType<MemoryStorage["listThreads"]>>>(
      await this.backend.memoryThreadRead({
        operation: "list",
        ...pagination,
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
        ...(orderBy === undefined ? {} : { orderBy }),
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
    ..._args: Parameters<MemoryStorage["getObservationalMemory"]>
  ): ReturnType<MemoryStorage["getObservationalMemory"]> {
    throw unsupported("getObservationalMemory");
  }
  async getObservationalMemoryHistory(
    ..._args: Parameters<MemoryStorage["getObservationalMemoryHistory"]>
  ): ReturnType<MemoryStorage["getObservationalMemoryHistory"]> {
    throw unsupported("getObservationalMemoryHistory");
  }
  async initializeObservationalMemory(
    ..._args: Parameters<MemoryStorage["initializeObservationalMemory"]>
  ): ReturnType<MemoryStorage["initializeObservationalMemory"]> {
    throw unsupported("initializeObservationalMemory");
  }
  async updateActiveObservations(
    ..._args: Parameters<MemoryStorage["updateActiveObservations"]>
  ): ReturnType<MemoryStorage["updateActiveObservations"]> {
    throw unsupported("updateActiveObservations");
  }
  async commitActiveObservations(
    ..._args: Parameters<MemoryStorage["commitActiveObservations"]>
  ): ReturnType<MemoryStorage["commitActiveObservations"]> {
    throw unsupported("commitActiveObservations");
  }
  async updateBufferedObservations(
    ..._args: Parameters<MemoryStorage["updateBufferedObservations"]>
  ): ReturnType<MemoryStorage["updateBufferedObservations"]> {
    throw unsupported("updateBufferedObservations");
  }
  async appendBufferedObservations(
    ..._args: Parameters<MemoryStorage["appendBufferedObservations"]>
  ): ReturnType<MemoryStorage["appendBufferedObservations"]> {
    throw unsupported("appendBufferedObservations");
  }
  async swapBufferedToActive(
    ..._args: Parameters<MemoryStorage["swapBufferedToActive"]>
  ): ReturnType<MemoryStorage["swapBufferedToActive"]> {
    throw unsupported("swapBufferedToActive");
  }
  async createReflectionGeneration(
    ..._args: Parameters<MemoryStorage["createReflectionGeneration"]>
  ): ReturnType<MemoryStorage["createReflectionGeneration"]> {
    throw unsupported("createReflectionGeneration");
  }
  async updateBufferedReflection(
    ..._args: Parameters<MemoryStorage["updateBufferedReflection"]>
  ): ReturnType<MemoryStorage["updateBufferedReflection"]> {
    throw unsupported("updateBufferedReflection");
  }
  async swapBufferedReflectionToActive(
    ..._args: Parameters<MemoryStorage["swapBufferedReflectionToActive"]>
  ): ReturnType<MemoryStorage["swapBufferedReflectionToActive"]> {
    throw unsupported("swapBufferedReflectionToActive");
  }
  async setReflectingFlag(
    ..._args: Parameters<MemoryStorage["setReflectingFlag"]>
  ): ReturnType<MemoryStorage["setReflectingFlag"]> {
    throw unsupported("setReflectingFlag");
  }
  async setObservingFlag(
    ..._args: Parameters<MemoryStorage["setObservingFlag"]>
  ): ReturnType<MemoryStorage["setObservingFlag"]> {
    throw unsupported("setObservingFlag");
  }
  async setBufferingObservationFlag(
    ..._args: Parameters<MemoryStorage["setBufferingObservationFlag"]>
  ): ReturnType<MemoryStorage["setBufferingObservationFlag"]> {
    throw unsupported("setBufferingObservationFlag");
  }
  async setBufferingReflectionFlag(
    ..._args: Parameters<MemoryStorage["setBufferingReflectionFlag"]>
  ): ReturnType<MemoryStorage["setBufferingReflectionFlag"]> {
    throw unsupported("setBufferingReflectionFlag");
  }
  async insertObservationalMemoryRecord(
    ..._args: Parameters<MemoryStorage["insertObservationalMemoryRecord"]>
  ): ReturnType<MemoryStorage["insertObservationalMemoryRecord"]> {
    throw unsupported("insertObservationalMemoryRecord");
  }
  async clearObservationalMemory(
    ..._args: Parameters<MemoryStorage["clearObservationalMemory"]>
  ): ReturnType<MemoryStorage["clearObservationalMemory"]> {
    throw unsupported("clearObservationalMemory");
  }
  async setPendingMessageTokens(
    ..._args: Parameters<MemoryStorage["setPendingMessageTokens"]>
  ): ReturnType<MemoryStorage["setPendingMessageTokens"]> {
    throw unsupported("setPendingMessageTokens");
  }
  async updateObservationalMemoryConfig(
    ..._args: Parameters<MemoryStorage["updateObservationalMemoryConfig"]>
  ): ReturnType<MemoryStorage["updateObservationalMemoryConfig"]> {
    throw unsupported("updateObservationalMemoryConfig");
  }
}
