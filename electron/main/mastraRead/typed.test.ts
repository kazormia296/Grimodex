import { afterEach, describe, expect, it, vi } from "vitest";

import { NAPI_COMMANDS } from "../../shared/ipcContract.js";
import type { NapiBackendLike } from "../../shared/ipcContract.js";
import type { FtsScope } from "../../shared/mastraRead/ports.js";
import type { MainIssuedCallerIdentity } from "../profileEgress.js";
import { MainReadError } from "./errors.js";
import { createMainTypedReads } from "./typed.js";

const IDENTITY: MainIssuedCallerIdentity = {
  profileId: "profile-1",
  callerId: "caller-1",
  callerEpoch: 3,
  senderId: 7,
  workspaceId: "/ws/one",
  sessionId: "session-1",
};

const wire = (value: unknown) => JSON.stringify(value);

function backendWith(overrides: Record<string, unknown> = {}) {
  const methods = {
    ftsSearch: vi.fn(async () => wire({ hits: [] })),
    codexSemanticSearch: vi.fn(async () => wire({ hits: ["c"] })),
    eventsSemanticSearch: vi.fn(async () => wire({ hits: ["e"] })),
    foreshadowListOpenForContext: vi.fn(async () => wire([])),
    ...overrides,
  };
  return { methods, backend: methods as unknown as NapiBackendLike };
}

afterEach(() => vi.useRealTimers());

describe("the four typed reads call their own Native method", () => {
  it("fts_search: project, query, scope and limit in Native's order", async () => {
    const { methods, backend } = backendWith();
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    await expect(
      reads.fts({ projectId: "p", query: "灯", scope: "scenes", limit: 5 }),
    ).resolves.toEqual({ hits: [] });
    expect(methods.ftsSearch).toHaveBeenCalledWith("p", "灯", "scenes", 5);
  });

  it("the semantic reads take the workspace path from the identity", async () => {
    const { methods, backend } = backendWith();
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    await reads.codexSemantic({ projectId: "p", query: "q", limit: 3 });
    await reads.eventsSemantic({ projectId: "p", query: "q", limit: 4 });
    expect(methods.codexSemanticSearch).toHaveBeenCalledWith(
      "/ws/one",
      "p",
      "q",
      3,
    );
    expect(methods.eventsSemanticSearch).toHaveBeenCalledWith(
      "/ws/one",
      "p",
      "q",
      4,
    );
  });

  it("foreshadow_list_open_for_context takes the project only", async () => {
    const { methods, backend } = backendWith();
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    await reads.foreshadowOpen({ projectId: "p" });
    expect(methods.foreshadowListOpenForContext).toHaveBeenCalledWith("p");
  });
});

describe("a read that cannot be made safely is not sent (fail closed)", () => {
  it.each(["all", "", "Codex", "events", undefined, 1])(
    "fts scope %j is not read",
    async (scope) => {
      const { methods, backend } = backendWith();
      const reads = createMainTypedReads({ backend, identity: IDENTITY });
      await expect(
        reads.fts({
          projectId: "p",
          query: "q",
          scope: scope as FtsScope,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "scope" });
      expect(methods.ftsSearch).not.toHaveBeenCalled();
    },
  );

  it("an empty project id is refused for all four", async () => {
    const { methods, backend } = backendWith();
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    for (const call of [
      () => reads.fts({ projectId: "", query: "q", scope: "codex", limit: 1 }),
      () => reads.codexSemantic({ projectId: " ", query: "q", limit: 1 }),
      () => reads.eventsSemantic({ projectId: "", query: "q", limit: 1 }),
      () => reads.foreshadowOpen({ projectId: "" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "argument" });
    }
    for (const method of Object.values(methods))
      expect(method).not.toHaveBeenCalled();
  });

  it.each([null, ""])(
    "a turn identity whose workspace is %j: the semantic reads are refused before Native",
    async (workspaceId) => {
      const { methods, backend } = backendWith();
      const reads = createMainTypedReads({
        backend,
        identity: { ...IDENTITY, workspaceId },
      });
      await expect(
        reads.codexSemantic({ projectId: "p", query: "q", limit: 1 }),
      ).rejects.toMatchObject({ code: "workspace" });
      await expect(
        reads.eventsSemantic({ projectId: "p", query: "q", limit: 1 }),
      ).rejects.toMatchObject({ code: "workspace" });
      expect(methods.codexSemanticSearch).not.toHaveBeenCalled();
      expect(methods.eventsSemanticSearch).not.toHaveBeenCalled();
    },
  );

  it("a backend without a semantic method is refused, not skipped", async () => {
    const { backend } = backendWith({
      codexSemanticSearch: undefined,
      eventsSemanticSearch: undefined,
    });
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    await expect(
      reads.codexSemantic({ projectId: "p", query: "q", limit: 1 }),
    ).rejects.toMatchObject({ code: "backend-method", beforeSend: true });
    await expect(
      reads.eventsSemantic({ projectId: "p", query: "q", limit: 1 }),
    ).rejects.toMatchObject({ code: "backend-method" });
  });

  it("a read the command's own argument check refuses is not sent either", async () => {
    const { methods, backend } = backendWith();
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    await expect(
      reads.fts({
        projectId: "p",
        query: "q",
        scope: "codex",
        limit: "5" as unknown as number,
      }),
    ).rejects.toThrow();
    expect(methods.ftsSearch).not.toHaveBeenCalled();
  });
});

describe("the caller timeouts", () => {
  const never = () => new Promise<string>(() => undefined);

  it.each([
    [
      "fts",
      10_000,
      { ftsSearch: never },
      (r: ReturnType<typeof createMainTypedReads>) =>
        r.fts({ projectId: "p", query: "q", scope: "codex", limit: 1 }),
    ],
    [
      "codexSemantic",
      300_000,
      { codexSemanticSearch: never },
      (r: ReturnType<typeof createMainTypedReads>) =>
        r.codexSemantic({ projectId: "p", query: "q", limit: 1 }),
    ],
    [
      "eventsSemantic",
      300_000,
      { eventsSemanticSearch: never },
      (r: ReturnType<typeof createMainTypedReads>) =>
        r.eventsSemantic({ projectId: "p", query: "q", limit: 1 }),
    ],
  ])("%s gives up after %i ms", async (_name, ms, overrides, call) => {
    vi.useFakeTimers();
    const { backend } = backendWith(overrides);
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    const outcome = call(reads).catch((e: MainReadError) => e.code);
    await vi.advanceTimersByTimeAsync(ms - 1);
    let done = false;
    void outcome.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("timeout");
  });

  it("foreshadow_list_open_for_context has no caller timeout (the renderer has none)", async () => {
    vi.useFakeTimers();
    const { backend } = backendWith({ foreshadowListOpenForContext: never });
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    let settled = false;
    void reads.foreshadowOpen({ projectId: "p" }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the lifecycle hooks run around each read (assertLive before and after)", async () => {
    const calls: string[] = [];
    const { backend } = backendWith();
    const reads = createMainTypedReads({
      backend,
      identity: IDENTITY,
      assertLive: () => calls.push("live"),
      trackInFlight: () => calls.push("track"),
    });
    await reads.foreshadowOpen({ projectId: "p" });
    expect(calls).toEqual(["live", "track", "live"]);
  });
});

describe("the four commands do not use `deps` (DR-MP4-6)", () => {
  it.each([
    "fts_search",
    "codex_semantic_search",
    "events_semantic_search",
    "foreshadow_list_open_for_context",
  ] as const)("%s declares (backend, args) only", (key) => {
    // A function's `length` counts its declared parameters: a third one
    // (`deps`) would make this fail the day one of them starts to use it.
    expect(NAPI_COMMANDS[key]!.run.length).toBeLessThanOrEqual(2);
  });
});
