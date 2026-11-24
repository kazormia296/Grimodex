import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAPI_COMMANDS } from "../../shared/ipcContract.js";
import type {
  DispatchDeps,
  NapiBackendLike,
} from "../../shared/ipcContract.js";
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
    foreshadowListWithLabels: vi.fn(async () =>
      wire({ foreshadows: [], setups: [] }),
    ),
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

  it.each(["codex", "scenes", "scenes_live", "snippets"] as const)(
    "fts_search passes the scope %s to Native as it is",
    async (scope) => {
      const { methods, backend } = backendWith();
      const reads = createMainTypedReads({ backend, identity: IDENTITY });
      await reads.fts({ projectId: "p", query: "灯", scope, limit: 10 });
      expect(methods.ftsSearch).toHaveBeenCalledWith("p", "灯", scope, 10);
    },
  );

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
    await reads.foreshadowOpen({ projectId: "p", includeSettled: false });
    expect(methods.foreshadowListOpenForContext).toHaveBeenCalledWith("p");
    expect(methods.foreshadowListOpenForContext).toHaveBeenCalledTimes(2);
    expect(methods.foreshadowListWithLabels).not.toHaveBeenCalled();
  });

  it("includeSettled selects the existing foreshadow_list_with_labels read", async () => {
    const { methods, backend } = backendWith();
    const reads = createMainTypedReads({ backend, identity: IDENTITY });
    await reads.foreshadowOpen({ projectId: "p", includeSettled: true });
    expect(methods.foreshadowListWithLabels).toHaveBeenCalledWith("p");
    expect(methods.foreshadowListOpenForContext).not.toHaveBeenCalled();
  });
});

describe("a read that cannot be made safely is not sent (fail closed)", () => {
  it.each([
    "all",
    "",
    "Codex",
    "events",
    "scenes_live2",
    "scenes_liv",
    "Scenes_Live",
    "scenes-live",
    undefined,
    1,
  ])("fts scope %j is not read", async (scope) => {
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
  });

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
  const KEYS = [
    "fts_search",
    "codex_semantic_search",
    "events_semantic_search",
    "foreshadow_list_with_labels",
    "foreshadow_list_open_for_context",
  ] as const;
  const ARGS: Record<(typeof KEYS)[number], Record<string, unknown>> = {
    fts_search: { projectId: "p", query: "q", scope: "codex", limit: 1 },
    codex_semantic_search: {
      expectedWorkspacePath: "/ws/one",
      projectId: "p",
      query: "q",
      limit: 1,
    },
    events_semantic_search: {
      expectedWorkspacePath: "/ws/one",
      projectId: "p",
      query: "q",
      limit: 1,
    },
    foreshadow_list_with_labels: { projectId: "p" },
    foreshadow_list_open_for_context: { projectId: "p" },
  };

  /** The function node of `run`'s source, parsed. */
  function runNode(source: string): ts.FunctionLikeDeclaration {
    const file = ts.createSourceFile(
      "run.ts",
      // A function expression or an arrow, or else a method (`run(b, a) {}`).
      /^(?:async\s+)?(?:function\b|\(|[\w$]+\s*=>)/u.test(source)
        ? `const f = ${source};`
        : `const o = { ${source} };`,
      ts.ScriptTarget.Latest,
      true,
    );
    let found: ts.FunctionLikeDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (
        found === undefined &&
        (ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isMethodDeclaration(node))
      ) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (found === undefined) throw new Error(`no function in: ${source}`);
    return found;
  }

  it.each(KEYS)(
    "%s declares at most (backend, args): no third, no rest, no `arguments`",
    (key) => {
      const run = NAPI_COMMANDS[key]!.run;
      // `length` counts declared parameters before a default or a rest.
      expect(run.length).toBeLessThanOrEqual(2);
      const node = runNode(run.toString());
      expect(node.parameters.length).toBeLessThanOrEqual(2);
      expect(node.parameters.some((p) => p.dotDotDotToken)).toBe(false);
      let usesArguments = false;
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n.text === "arguments") usesArguments = true;
        ts.forEachChild(n, visit);
      };
      visit(node);
      expect(usesArguments).toBe(false);
    },
  );

  it("the check itself sees a rest parameter and `arguments`", () => {
    const rest = runNode("async (...a) => a[2]");
    expect(rest.parameters.some((p) => p.dotDotDotToken)).toBe(true);
    let sees = false;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === "arguments") sees = true;
      ts.forEachChild(n, visit);
    };
    visit(runNode("function () { return arguments[2]; }"));
    expect(sees).toBe(true);
    expect(runNode("async (b, a, d) => d").parameters.length).toBe(3);
  });

  it.each(KEYS)("%s runs with a `deps` that throws on any use", async (key) => {
    const touched: string[] = [];
    const trap = new Proxy(
      {},
      {
        get: (_t, prop) => {
          touched.push(String(prop));
          throw new Error(`deps.${String(prop)} was read`);
        },
        has: (_t, prop) => {
          touched.push(String(prop));
          throw new Error(`deps has ${String(prop)}`);
        },
        ownKeys: () => {
          touched.push("ownKeys");
          throw new Error("deps keys were read");
        },
      },
    ) as unknown as DispatchDeps;
    const { backend } = backendWith();
    await expect(
      NAPI_COMMANDS[key]!.run(backend, ARGS[key]!, trap),
    ).resolves.not.toThrow();
    expect(touched).toEqual([]);
  });
});

describe("the backend the typed reads keep", () => {
  it("is narrowed at run time to the four methods: the run sees no other method", async () => {
    const seen: string[][] = [];
    const original = NAPI_COMMANDS.fts_search.run;
    const backend = {
      ftsSearch: async () => "[]",
      chatAgentIrSelect: async () => "must-not-be-reachable",
      dbExecute: async () => "must-not-be-reachable",
    };
    const spy = vi
      .spyOn(NAPI_COMMANDS.fts_search, "run")
      .mockImplementation(async (b: unknown, a: unknown, d: unknown) => {
        seen.push(Object.keys(b as object).sort());
        return original(b as never, a as never, d as never);
      });
    try {
      const reads = createMainTypedReads({
        backend: backend as never,
        identity: { workspaceId: "/w" } as never,
      });
      await reads
        .fts({ projectId: "p", query: "q", scope: "codex", limit: 1 } as never)
        .catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const keys of seen) expect(keys).toEqual(["ftsSearch"]);
  });
});
