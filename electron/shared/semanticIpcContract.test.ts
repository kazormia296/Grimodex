import { describe, expect, it, vi } from "vitest";

import {
  dispatchInvoke,
  IPC_BACKEND_UNAVAILABLE_MARKER,
} from "./ipcContract.js";
import type { NapiBackendLike } from "./ipcContract.js";

const noShell = {};

const cases = [
  {
    cmd: "semantic_download_model",
    method: "semanticDownloadModel",
    args: { language: "ja" },
    nativeArgs: ["ja"],
  },
  {
    cmd: "semantic_cancel_background",
    method: "semanticCancelBackground",
    args: {},
    nativeArgs: [],
  },
  {
    cmd: "semantic_index_scene",
    method: "semanticIndexScene",
    args: { sceneId: "scene-1" },
    nativeArgs: ["scene-1"],
  },
  {
    cmd: "semantic_search",
    method: "semanticSearch",
    args: {
      projectId: "project-1",
      query: "雨の夜",
      limit: 12,
      sceneScope: "scene-1",
      descriptionMode: true,
    },
    nativeArgs: ["project-1", "雨の夜", 12, "scene-1", true],
  },
  {
    cmd: "codex_index_entry",
    method: "codexIndexEntry",
    args: { entryId: "entry-1" },
    nativeArgs: ["entry-1"],
  },
  {
    cmd: "codex_semantic_search",
    method: "codexSemanticSearch",
    args: { projectId: "project-1", query: "主人公", limit: 7 },
    nativeArgs: ["project-1", "主人公", 7],
  },
  {
    cmd: "codex_index_status",
    method: "codexIndexStatus",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "codex_reindex_all",
    method: "codexReindexAll",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "events_index_entry",
    method: "eventsIndexEntry",
    args: { eventId: "event-1" },
    nativeArgs: ["event-1"],
  },
  {
    cmd: "events_semantic_search",
    method: "eventsSemanticSearch",
    args: { projectId: "project-1", query: "決戦", limit: 6 },
    nativeArgs: ["project-1", "決戦", 6],
  },
  {
    cmd: "events_index_status",
    method: "eventsIndexStatus",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "events_reindex_all",
    method: "eventsReindexAll",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "chat_index_message",
    method: "chatIndexMessage",
    args: { messageId: "message-1" },
    nativeArgs: ["message-1"],
  },
  {
    cmd: "chat_message_search",
    method: "chatMessageSearch",
    args: { projectId: "project-1", query: "伏線", limit: 5 },
    nativeArgs: ["project-1", "伏線", 5],
  },
  {
    cmd: "chat_index_status",
    method: "chatIndexStatus",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "chat_reindex_all",
    method: "chatReindexAll",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "semantic_index_status",
    method: "semanticIndexStatus",
    args: { projectId: "project-1" },
    nativeArgs: ["project-1"],
  },
  {
    cmd: "semantic_reindex_all",
    method: "semanticReindexAll",
    args: { projectId: "project-1", runId: "run-1" },
    nativeArgs: ["project-1", "run-1"],
  },
  {
    cmd: "semantic_chunk_context",
    method: "semanticChunkContext",
    args: { sceneId: "scene-1", charStart: 10, charEnd: 24, padding: 80 },
    nativeArgs: ["scene-1", 10, 24, 80],
  },
  {
    cmd: "semantic_debug_dump",
    method: "semanticDebugDump",
    args: { projectId: "project-1", sceneId: "scene-1", limit: 50 },
    nativeArgs: ["project-1", "scene-1", 50],
  },
] as const;

function backendWith(method: string, implementation: unknown): NapiBackendLike {
  return { [method]: implementation } as unknown as NapiBackendLike;
}

describe("Semantic Phase 3 Batch 4 N-API commands", () => {
  it.each(cases)(
    "$cmd はcamelCase引数を $method の位置引数へ写像しJSON wireをparseする",
    async ({ cmd, method, args, nativeArgs }) => {
      const native = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ command: cmd }));
      const env = await dispatchInvoke(cmd, args, {
        backend: backendWith(method, native),
        shell: noShell,
      });

      expect(native).toHaveBeenCalledExactlyOnceWith(...nativeArgs);
      expect(env).toEqual({ ok: true, value: { command: cmd } });
    },
  );

  it.each(cases)(
    "$cmd は旧native bindingに $method が無ければ明示エラーにする",
    async ({ cmd, method, args }) => {
      const env = await dispatchInvoke(cmd, args, {
        backend: {} as NapiBackendLike,
        shell: noShell,
      });

      expect(env).toEqual({
        ok: false,
        error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method ${method}`,
        errorInfo: {
          code: "IPC_BACKEND_UNAVAILABLE",
          message: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method ${method}`,
          retryable: false,
          outcome: "failed",
        },
      });
    },
  );

  const requiredUnsignedCases = [
    {
      cmd: "semantic_search",
      key: "limit",
      args: { projectId: "p1", query: "q", limit: 5 },
      method: "semanticSearch",
    },
    {
      cmd: "codex_semantic_search",
      key: "limit",
      args: { projectId: "p1", query: "q", limit: 5 },
      method: "codexSemanticSearch",
    },
    {
      cmd: "events_semantic_search",
      key: "limit",
      args: { projectId: "p1", query: "q", limit: 5 },
      method: "eventsSemanticSearch",
    },
    {
      cmd: "chat_message_search",
      key: "limit",
      args: { projectId: "p1", query: "q", limit: 5 },
      method: "chatMessageSearch",
    },
    {
      cmd: "semantic_chunk_context",
      key: "charStart",
      args: { sceneId: "s1", charStart: 1, charEnd: 2, padding: 3 },
      method: "semanticChunkContext",
    },
    {
      cmd: "semantic_chunk_context",
      key: "charEnd",
      args: { sceneId: "s1", charStart: 1, charEnd: 2, padding: 3 },
      method: "semanticChunkContext",
    },
    {
      cmd: "semantic_chunk_context",
      key: "padding",
      args: { sceneId: "s1", charStart: 1, charEnd: 2, padding: 3 },
      method: "semanticChunkContext",
    },
  ] as const;

  it.each(requiredUnsignedCases)(
    "$cmd.$key はusize相当を0..u32だけ許可する",
    async ({ cmd, key, args, method }) => {
      for (const invalid of [
        undefined,
        null,
        "5",
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        0x1_0000_0000,
      ]) {
        const native = vi.fn().mockResolvedValue("null");
        const env = await dispatchInvoke(
          cmd,
          { ...args, [key]: invalid },
          { backend: backendWith(method, native), shell: noShell },
        );

        expect(env.ok, `${cmd}.${key}=${String(invalid)}`).toBe(false);
        if (!env.ok) {
          expect(env.error).toContain(`invalid args \`${key}\``);
        }
        expect(native).not.toHaveBeenCalled();
      }
    },
  );

  it("semantic_debug_dump のoptional引数はnull/undefinedをNoneへ写像し、不正usizeを拒否する", async () => {
    const native = vi.fn().mockResolvedValue("null");
    const backend = backendWith("semanticDebugDump", native);

    await dispatchInvoke(
      "semantic_debug_dump",
      { projectId: "p1", sceneId: null, limit: null },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "semantic_debug_dump",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    expect(native.mock.calls).toEqual([
      ["p1", undefined, undefined],
      ["p1", undefined, undefined],
    ]);

    for (const invalid of ["5", -1, 1.5, 0x1_0000_0000]) {
      const env = await dispatchInvoke(
        "semantic_debug_dump",
        { projectId: "p1", limit: invalid },
        { backend, shell: noShell },
      );
      expect(env.ok).toBe(false);
    }
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("semantic_search のoptional引数はnull/undefinedをNoneへ写像し型不正を拒否する", async () => {
    const native = vi.fn().mockResolvedValue("[]");
    const backend = backendWith("semanticSearch", native);

    await dispatchInvoke(
      "semantic_search",
      {
        projectId: "p1",
        query: "q",
        limit: 3,
        sceneScope: null,
        descriptionMode: null,
      },
      { backend, shell: noShell },
    );
    expect(native).toHaveBeenCalledExactlyOnceWith(
      "p1",
      "q",
      3,
      undefined,
      undefined,
    );

    for (const args of [{ sceneScope: 42 }, { descriptionMode: "true" }]) {
      const env = await dispatchInvoke(
        "semantic_search",
        { projectId: "p1", query: "q", limit: 3, ...args },
        { backend, shell: noShell },
      );
      expect(env.ok).toBe(false);
    }
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("semantic_reindex_all.runId はoptional stringを厳格検証する", async () => {
    const native = vi.fn().mockResolvedValue("0");
    const backend = backendWith("semanticReindexAll", native);

    await dispatchInvoke(
      "semantic_reindex_all",
      { projectId: "p1", runId: null },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "semantic_reindex_all",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    const maxAstralRunId = "😀".repeat(256);
    await dispatchInvoke(
      "semantic_reindex_all",
      { projectId: "p1", runId: maxAstralRunId },
      { backend, shell: noShell },
    );
    expect(native.mock.calls).toEqual([
      ["p1", undefined],
      ["p1", undefined],
      ["p1", maxAstralRunId],
    ]);

    for (const invalid of [
      "",
      "x".repeat(257),
      "😀".repeat(257),
      42,
      false,
      {},
      [],
    ]) {
      const env = await dispatchInvoke(
        "semantic_reindex_all",
        { projectId: "p1", runId: invalid },
        { backend, shell: noShell },
      );
      expect(env.ok).toBe(false);
    }
    expect(native).toHaveBeenCalledTimes(3);
  });
});
