import { InMemoryMemory } from "@mastra/core/storage";
import { describe, expect, it, vi } from "vitest";
import type { NapiMemoryBackendLike } from "./napiMemoryBackend.js";
import { NativeMemoryStorage } from "./nativeMemoryStorage.js";

const json = (value: unknown) => JSON.stringify(value);

function mockedStorage() {
  const calls: Array<[string, unknown]> = [];
  const result = {
    id: "x",
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    messages: [],
    threads: [],
  };
  const method = (name: string) =>
    vi.fn(async (payload: unknown) => {
      calls.push([name, payload]);
      return json(result);
    });
  const backend = {
    memoryThreadRead: method("threadRead"),
    memoryThreadWrite: method("threadWrite"),
    memoryThreadDelete: method("threadDelete"),
    memoryMessageRead: method("messageRead"),
    memoryMessageWrite: method("messageWrite"),
    memoryMessageDelete: method("messageDelete"),
    memoryResourceRead: method("resourceRead"),
    memoryResourceWrite: method("resourceWrite"),
  } as unknown as NapiMemoryBackendLike;
  return { calls, backend, storage: new NativeMemoryStorage(backend, "p1") };
}

describe("NativeMemoryStorage", () => {
  it("maps supported methods to typed N-API payloads and decodes results", async () => {
    const { calls, storage } = mockedStorage();
    const thread = {
      id: "t1",
      resourceId: "r1",
      title: "title",
      createdAt: new Date("2026-11-27T00:00:00.000Z"),
      updatedAt: new Date("2026-11-27T00:00:00.000Z"),
    };
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        role: "user" as const,
        createdAt: new Date("2026-11-27T00:00:00.000Z"),
        content: { text: "hello" } as never,
      },
    ];

    await storage.getThreadById({ threadId: "t1", resourceId: "r1" });
    await storage.saveThread({ thread: thread as never });
    await storage.updateThread({ id: "t1", metadata: { k: "v" } });
    await storage.deleteThread({ threadId: "t1" });
    await storage.listThreads({
      filter: { resourceId: "r1", metadata: { k: "v" } },
    });
    await storage.listMessages({ threadId: "t1", page: 0, perPage: 40 });
    await storage.listMessagesById({ messageIds: ["m1"] });
    await storage.saveMessages({ messages });
    await storage.updateMessages({
      messages: [{ id: "m1", content: { text: "updated" } as never }],
    });
    await storage.deleteMessages(["m1"]);
    await storage.getResourceById({ resourceId: "r1" });
    await storage.saveResource({
      resource: {
        id: "r1",
        workingMemory: "wm",
        metadata: { k: "v" },
        createdAt: new Date("2026-11-27T00:00:00.000Z"),
        updatedAt: new Date("2026-11-27T00:00:00.000Z"),
      } as never,
    });
    await storage.updateResource({ resourceId: "r1", workingMemory: "wm2" });

    expect(calls).toEqual([
      ["threadRead", { operation: "get", threadId: "t1", resourceId: "r1" }],
      [
        "threadWrite",
        {
          operation: "save",
          thread: {
            ...thread,
            createdAt: "2026-11-27T00:00:00.000Z",
            updatedAt: "2026-11-27T00:00:00.000Z",
          },
        },
      ],
      ["threadWrite", { operation: "update", id: "t1", metadata: { k: "v" } }],
      ["threadDelete", { threadId: "t1" }],
      [
        "threadRead",
        { operation: "list", resourceId: "r1", metadata: { k: "v" } },
      ],
      [
        "messageRead",
        { operation: "list", threadId: "t1", page: 0, perPage: 40 },
      ],
      ["messageRead", { operation: "byId", messageIds: ["m1"] }],
      [
        "messageWrite",
        {
          operation: "save",
          messages: [{ ...messages[0], createdAt: "2026-11-27T00:00:00.000Z" }],
        },
      ],
      [
        "messageWrite",
        {
          operation: "update",
          messages: [{ id: "m1", content: { text: "updated" } }],
        },
      ],
      ["messageDelete", { messageIds: ["m1"] }],
      ["resourceRead", { operation: "get", projectId: "p1" }],
      [
        "resourceWrite",
        {
          operation: "save",
          id: "r1",
          projectId: "p1",
          workingMemory: "wm",
          metadata: { k: "v" },
        },
      ],
      [
        "resourceWrite",
        { operation: "update", id: "r1", workingMemory: "wm2" },
      ],
    ]);
    await expect(storage.getThreadById({ threadId: "t1" })).resolves.toEqual({
      id: "x",
      createdAt: new Date("2026-11-27T00:00:00.000Z"),
      updatedAt: new Date("2026-11-27T00:00:00.000Z"),
      messages: [],
      threads: [],
    });
  });

  it("supports a resource merge without claiming atomicity", async () => {
    const { calls, storage } = mockedStorage();
    await storage.mergeResourceWorkingMemory({
      resourceId: "r1",
      merge: (current) => `${current ?? ""}!`,
    });
    expect(calls).toEqual([
      ["resourceRead", { operation: "get", projectId: "p1" }],
      ["resourceWrite", { operation: "update", id: "r1", workingMemory: "!" }],
    ]);
    expect(storage.supportsAtomicWorkingMemoryMerge).toBe(false);
  });

  it("keeps regular memory usable while rejecting OM and clear operations", async () => {
    const { storage } = mockedStorage();
    expect(storage.supportsObservationalMemory).toBe(false);
    await expect(
      storage.getThreadById({ threadId: "t1" }),
    ).resolves.toBeTruthy();
    await expect(storage.getObservationalMemory(null, "r1")).rejects.toThrow(
      /not implemented/,
    );
    await expect(storage.dangerouslyClearAll()).rejects.toThrow(
      /not implemented/,
    );
  });

  it("provides an InMemory comparison frame for the same thread/message sequence", async () => {
    type WireThread = Record<string, unknown> & { id: string };
    type WireMessage = Record<string, unknown> & {
      id: string;
      threadId: string;
    };
    const threads = new Map<string, WireThread>();
    const messages = new Map<string, WireMessage>();
    const backend = {
      memoryThreadRead: vi.fn(async (payload: Record<string, unknown>) => {
        const request = payload as { operation: string; threadId?: string };
        return json(
          request.operation === "get"
            ? (threads.get(request.threadId ?? "") ?? null)
            : {
                threads: [...threads.values()],
                total: threads.size,
                page: 0,
                perPage: false,
                hasMore: false,
              },
        );
      }),
      memoryThreadWrite: vi.fn(async (payload: Record<string, unknown>) => {
        const request = payload as {
          operation: string;
          id?: string;
          thread?: WireThread;
        };
        const threadId = request.thread?.id ?? request.id ?? "";
        if (request.thread) threads.set(threadId, request.thread);
        else
          threads.set(threadId, {
            ...threads.get(threadId),
            ...request,
            id: threadId,
          });
        return json(threads.get(threadId));
      }),
      memoryThreadDelete: vi.fn(async (payload: { threadId: string }) => {
        threads.delete(payload.threadId);
        return json({ deleted: 1 });
      }),
      memoryMessageRead: vi.fn(async (payload: Record<string, unknown>) => {
        const request = payload as {
          operation: string;
          messageIds?: string[];
          threadId?: string | string[];
        };
        const rows = [...messages.values()];
        if (request.operation === "byId")
          return json({
            messages: (request.messageIds ?? []).flatMap((id) =>
              messages.has(id) ? [messages.get(id)] : [],
            ),
          });
        const threadIds = Array.isArray(request.threadId)
          ? request.threadId
          : [request.threadId];
        const found = rows.filter((message) =>
          threadIds.includes(message.threadId),
        );
        return json({
          messages: found,
          total: found.length,
          page: 0,
          perPage: false,
          hasMore: false,
        });
      }),
      memoryMessageWrite: vi.fn(async (payload: Record<string, unknown>) => {
        const request = payload as { messages: WireMessage[] };
        for (const message of request.messages)
          messages.set(message.id, { ...messages.get(message.id), ...message });
        return json({
          messages: request.messages.map((message) => messages.get(message.id)),
        });
      }),
      memoryMessageDelete: vi.fn(async (payload: { messageIds: string[] }) => {
        for (const id of payload.messageIds) messages.delete(id);
        return json({ deleted: payload.messageIds.length });
      }),
      memoryResourceRead: vi.fn(async () => json(null)),
      memoryResourceWrite: vi.fn(async () => json(null)),
    };
    const native = new NativeMemoryStorage(
      backend as unknown as NapiMemoryBackendLike,
      "p1",
    );
    const memory = new InMemoryMemory({
      db: {
        threads: new Map(),
        messages: new Map(),
        resources: new Map(),
      } as never,
    });
    const thread = {
      id: "t1",
      resourceId: "r1",
      title: "title",
      createdAt: new Date("2026-11-27T00:00:00.000Z"),
      updatedAt: new Date("2026-11-27T00:00:00.000Z"),
      metadata: {},
    };
    const message = {
      id: "m1",
      threadId: "t1",
      resourceId: "r1",
      role: "user" as const,
      createdAt: new Date("2026-11-27T00:00:00.000Z"),
      content: { text: "hello" } as never,
    };

    await Promise.all([
      native.saveThread({ thread }),
      memory.saveThread({ thread }),
    ]);
    await Promise.all([
      native.saveMessages({ messages: [message] }),
      memory.saveMessages({ messages: [message] }),
    ]);
    const listed = await Promise.all([
      native.listMessages({ threadId: "t1" }),
      memory.listMessages({ threadId: "t1" }),
    ]);
    expect(
      listed.map(({ messages: rows }) => rows.map(({ id }) => id)),
    ).toEqual([["m1"], ["m1"]]);
    const byId = await Promise.all([
      native.listMessagesById({ messageIds: ["m1"] }),
      memory.listMessagesById({ messageIds: ["m1"] }),
    ]);
    expect(byId.map(({ messages: rows }) => rows.map(({ id }) => id))).toEqual([
      ["m1"],
      ["m1"],
    ]);
    await Promise.all([
      native.deleteMessages(["m1"]),
      memory.deleteMessages(["m1"]),
    ]);
    const afterDelete = await Promise.all([
      native.listMessages({ threadId: "t1" }),
      memory.listMessages({ threadId: "t1" }),
    ]);
    expect(afterDelete.map(({ messages: rows }) => rows.length)).toEqual([
      0, 0,
    ]);
    await Promise.all([
      native.deleteThread({ threadId: "t1" }),
      memory.deleteThread({ threadId: "t1" }),
    ]);
    expect(
      await Promise.all([
        native.getThreadById({ threadId: "t1" }),
        memory.getThreadById({ threadId: "t1" }),
      ]),
    ).toEqual([null, null]);
  });
});
