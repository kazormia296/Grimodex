import { describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../../shared/ipcContract.js";
import {
  createRuntimeThreadBindingStore,
  type AdvanceHistoryRevisionRequest,
} from "./threadBindingStore.js";

const request: AdvanceHistoryRevisionRequest = {
  expectedWorkspacePath: "/workspace/current",
  projectId: "project-1",
  sessionId: "session-1",
  runtime: "codex-app-server",
  externalThreadId: "thread-1",
  lastTurnId: "turn-1",
  pendingHistoryRevision: "__grimodex_pending_v1__:turn-local-1",
  nextHistoryRevision: "revision-after",
  updatedAt: "2026-07-14T12:00:00.000Z",
};

describe("RuntimeThreadBindingStore history revision CAS", () => {
  it("threads the expected workspace through every native binding operation", async () => {
    const get = vi.fn().mockResolvedValue("null");
    const upsert = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const store = createRuntimeThreadBindingStore({
      getChatRuntimeThreadBinding: get,
      upsertChatRuntimeThreadBinding: upsert,
      deleteChatRuntimeThreadBinding: remove,
    } as unknown as NapiBackendLike);
    const binding = {
      projectId: "project-1",
      sessionId: "session-1",
      runtime: "codex-app-server",
      externalThreadId: "thread-1",
      historyRevision: "revision-before",
      lastTurnId: "turn-1",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
    };

    await store.get(
      "project-1",
      "session-1",
      "codex-app-server",
      "/workspace/current",
    );
    await store.upsert(binding, "/workspace/current");
    await store.delete(
      "project-1",
      "session-1",
      "codex-app-server",
      "/workspace/current",
    );

    expect(get).toHaveBeenCalledWith(
      "project-1",
      "session-1",
      "codex-app-server",
      "/workspace/current",
    );
    expect(upsert).toHaveBeenCalledWith(binding, "/workspace/current");
    expect(remove).toHaveBeenCalledWith(
      "project-1",
      "session-1",
      "codex-app-server",
      "/workspace/current",
    );
  });

  it("passes every identity field to the main-only N-API bridge in order", async () => {
    const advance = vi.fn().mockResolvedValue(true);
    const store = createRuntimeThreadBindingStore({
      advanceChatRuntimeThreadHistoryRevision: advance,
    } as unknown as NapiBackendLike);

    await expect(store.advanceHistoryRevision(request)).resolves.toBe(true);
    expect(advance).toHaveBeenCalledWith(
      "/workspace/current",
      "project-1",
      "session-1",
      "codex-app-server",
      "thread-1",
      "turn-1",
      "__grimodex_pending_v1__:turn-local-1",
      "revision-after",
      "2026-07-14T12:00:00.000Z",
    );
  });

  it("fails explicitly when the native CAS bridge is unavailable", async () => {
    const store = createRuntimeThreadBindingStore(null);

    await expect(store.advanceHistoryRevision(request)).rejects.toThrow(
      "binding backend is unavailable",
    );
  });

  it("rejects a malformed native response instead of treating it as a CAS miss", async () => {
    const store = createRuntimeThreadBindingStore({
      advanceChatRuntimeThreadHistoryRevision: vi
        .fn()
        .mockResolvedValue("true"),
    } as unknown as NapiBackendLike);

    await expect(store.advanceHistoryRevision(request)).rejects.toThrow(
      "Invalid runtime thread history revision response",
    );
  });
});
