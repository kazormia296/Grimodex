import { describe, it, expect, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  begin: vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace",
    operationId: input.operationId as string,
    executionId: crypto.randomUUID(),
    parentExecutionId: null,
    startedAt: 1,
  })),
  cacheHit: vi.fn(async (_handle: unknown, _terminal: unknown) => undefined),
}));

vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecutionInWorkspace: auditMocks.begin,
  cacheHitAiAuditExecution: auditMocks.cacheHit,
}));

import {
  applyPromptVariant,
  buildAbReuseIdentity,
  runAbComparison,
  type AbDispatcher,
  type AbMessage,
} from "./abHarness";

const BASE: AbMessage[] = [
  { role: "system", content: "you are a writer" },
  { role: "user", content: "continue the scene" },
];
const AUDIT = {
  audit: {
    projectId: "project-test",
    pathId: "ab_chat" as const,
    expectedWorkspacePath: "/workspace",
    settingsAuthority: "settings:v1",
  },
};

function reuseEntry(
  request: { messages: AbMessage[] },
  config: Parameters<typeof buildAbReuseIdentity>[0]["config"],
  result: { ok: true; text: string } | { ok: false; error: string },
  audit: {
    projectId: string | null;
    expectedWorkspacePath: string;
    pathId: "ab_chat" | "ab_inline";
    settingsAuthority: string;
  } = AUDIT.audit,
) {
  const messages = applyPromptVariant(request.messages, config.promptVariant);
  return {
    result,
    identity: buildAbReuseIdentity({
      projectId: audit.projectId,
      expectedWorkspacePath: audit.expectedWorkspacePath,
      pathId: audit.pathId,
      settingsAuthority: audit.settingsAuthority,
      messages,
      config,
    }),
  };
}

describe("applyPromptVariant", () => {
  it("returns a copy unchanged when variant is empty", () => {
    const out = applyPromptVariant(BASE, "");
    expect(out).toEqual(BASE);
    expect(out).not.toBe(BASE); // copy, not same ref
  });

  it("returns a copy unchanged when variant is whitespace only", () => {
    expect(applyPromptVariant(BASE, "   ")).toEqual(BASE);
  });

  it("returns a copy unchanged when variant is null/undefined", () => {
    expect(applyPromptVariant(BASE, null)).toEqual(BASE);
    expect(applyPromptVariant(BASE, undefined)).toEqual(BASE);
  });

  it("appends a trimmed user message when variant is provided", () => {
    const out = applyPromptVariant(BASE, "  be more concise  ");
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "user", content: "be more concise" });
    // base untouched
    expect(BASE).toHaveLength(2);
  });
});

describe("runAbComparison", () => {
  it("dispatches every config and returns results in order", async () => {
    const dispatch: AbDispatcher = vi.fn(async (_messages, config) => ({
      ok: true as const,
      text: `model=${config.model ?? "default"}`,
    }));

    const out = await runAbComparison(
      { messages: BASE },
      [{}, { model: "gpt-b" }, { model: "gpt-c" }],
      dispatch,
      AUDIT,
    );

    expect(out.map((s) => s.result)).toEqual([
      { ok: true, text: "model=default" },
      { ok: true, text: "model=gpt-b" },
      { ok: true, text: "model=gpt-c" },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(3);
    for (const [, , context] of vi.mocked(dispatch).mock.calls) {
      expect(context.projectId).toBe("project-test");
      expect(context.expectedWorkspacePath).toBe("/workspace");
    }
  });

  it("passes the provider override through to the dispatcher", async () => {
    const seen: (string | null | undefined)[] = [];
    const dispatch: AbDispatcher = async (_m, config) => {
      seen.push(config.provider);
      return { ok: true as const, text: "ok" };
    };
    await runAbComparison(
      { messages: BASE },
      [{}, { provider: "sakana", model: "fugu" }],
      dispatch,
      AUDIT,
    );
    expect(seen).toEqual([undefined, "sakana"]);
  });

  it("runs slots concurrently by default (not sequentially)", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));

    const dispatch: AbDispatcher = async (_messages, config) => {
      if (config.model === "a") {
        order.push("a-start");
        await aGate; // a blocks until released
        order.push("a-end");
        return { ok: true as const, text: "A" };
      }
      order.push("b-start");
      order.push("b-end");
      releaseA();
      return { ok: true as const, text: "B" };
    };

    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "a" }, { model: "b" }],
      dispatch,
      AUDIT,
    );

    expect(out[0].result).toEqual({ ok: true, text: "A" });
    expect(out[1].result).toEqual({ ok: true, text: "B" });
    // a started before b finished → both were in flight at once
    expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("b-end"));
  });

  it("runs sequentially when parallel:false (no shared-stream cross-talk)", async () => {
    const order: string[] = [];
    const dispatch: AbDispatcher = async (_messages, config) => {
      order.push(`${config.model}-start`);
      await Promise.resolve();
      order.push(`${config.model}-end`);
      return { ok: true as const, text: config.model ?? "" };
    };

    await runAbComparison(
      { messages: BASE },
      [{ model: "a" }, { model: "b" }, { model: "c" }],
      dispatch,
      { ...AUDIT, parallel: false },
    );

    expect(order).toEqual([
      "a-start",
      "a-end",
      "b-start",
      "b-end",
      "c-start",
      "c-end",
    ]);
  });

  it("keeps one workspace authority and fails a later sequential slot before provider dispatch", async () => {
    let activeWorkspacePath = "/workspace";
    const providerDispatch = vi.fn();
    const dispatch: AbDispatcher = async (_messages, config, context) => {
      if (context.expectedWorkspacePath !== activeWorkspacePath) {
        throw new Error("AI_AUDIT_WORKSPACE_CHANGED");
      }
      providerDispatch(config.model);
      activeWorkspacePath = "/workspace/other";
      return { ok: true, text: config.model ?? "" };
    };

    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "first" }, { model: "second" }],
      dispatch,
      { ...AUDIT, parallel: false },
    );

    expect(providerDispatch).toHaveBeenCalledTimes(1);
    expect(providerDispatch).toHaveBeenCalledWith("first");
    expect(out[1].result).toEqual({
      ok: false,
      error: "AI_AUDIT_WORKSPACE_CHANGED",
    });
  });

  it("isolates a thrown error on one slot without failing the others", async () => {
    const dispatch: AbDispatcher = async (_messages, config) => {
      if (config.model === "boom") throw new Error("kaboom");
      return { ok: true as const, text: "ok" };
    };

    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "boom" }, { model: "fine" }],
      dispatch,
      AUDIT,
    );

    expect(out[0].result).toEqual({ ok: false, error: "kaboom" });
    expect(out[1].result).toEqual({ ok: true, text: "ok" });
  });

  it("applies promptVariant per slot and exposes composed messages", async () => {
    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "m", promptVariant: "variant A" }, { model: "m" }],
      async () => ({ ok: true as const, text: "ok" }),
      AUDIT,
    );

    expect(out[0].messages).toHaveLength(3);
    expect(out[0].messages[2]).toEqual({ role: "user", content: "variant A" });
    expect(out[1].messages).toHaveLength(2);
  });

  it("reuses ok results by index and only dispatches the rest", async () => {
    const seen: (string | null | undefined)[] = [];
    const dispatch: AbDispatcher = async (_messages, config) => {
      seen.push(config.model);
      return { ok: true as const, text: `model=${config.model ?? "default"}` };
    };

    const request = { messages: BASE };
    const configs = [{}, { model: "gpt-b" }, { model: "gpt-c" }];
    const out = await runAbComparison(request, configs, dispatch, {
      ...AUDIT,
      reuse: [
        reuseEntry(request, configs[0], { ok: true, text: "REUSED_0" }),
        null,
        reuseEntry(request, configs[2], { ok: true, text: "REUSED_2" }),
      ],
    });

    expect(out[0].result).toEqual({ ok: true, text: "REUSED_0" });
    expect(out[1].result).toEqual({ ok: true, text: "model=gpt-b" });
    expect(out[2].result).toEqual({ ok: true, text: "REUSED_2" });
    // only the non-reused slot (index 1) was dispatched.
    expect(seen).toEqual(["gpt-b"]);
  });

  it("ignores a failed reuse entry and dispatches that slot", async () => {
    const dispatch: AbDispatcher = vi.fn(async (_messages, config) => ({
      ok: true as const,
      text: `${config.model}`,
    }));

    const request = { messages: BASE };
    const configs = [{ model: "a" }, { model: "b" }];
    const out = await runAbComparison(request, configs, dispatch, {
      ...AUDIT,
      reuse: [
        reuseEntry(request, configs[0], { ok: false, error: "boom" }),
        null,
      ],
    });

    // failed reuse is not honored → both slots run.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(out[0].result).toEqual({ ok: true, text: "a" });
    expect(out[1].result).toEqual({ ok: true, text: "b" });
  });

  it.each(["ab_chat", "ab_inline"] as const)(
    "AI audit A/B reuse: %s records cache-hit terminals under one operation without model dispatch",
    async (pathId) => {
      auditMocks.begin.mockClear();
      auditMocks.cacheHit.mockClear();
      const dispatch: AbDispatcher = vi.fn(async () => ({
        ok: true as const,
        text: "provider result",
      }));
      const reused = [
        { ok: true as const, text: "cached A" },
        { ok: true as const, text: "cached B" },
      ];
      const request = { messages: BASE };
      const configs = [
        { model: "model-a" },
        { model: "model-b", promptVariant: "variant B" },
      ];
      const audit = {
        projectId: "project-1",
        pathId,
        expectedWorkspacePath: "/workspace",
        settingsAuthority: "settings:v1",
      };

      const output = await runAbComparison(request, configs, dispatch, {
        reuse: configs.map((config, index) =>
          reuseEntry(request, config, reused[index], audit),
        ),
        audit,
      });

      expect(output.map((slot) => slot.result)).toEqual(reused);
      expect(dispatch).not.toHaveBeenCalled();
      expect(auditMocks.begin).toHaveBeenCalledTimes(2);
      const starts = auditMocks.begin.mock.calls.map(([input]) => input);
      expect(starts.map((input) => input.pathId)).toEqual([pathId, pathId]);
      expect(new Set(starts.map((input) => input.operationId)).size).toBe(1);
      expect(starts[1]).toEqual(
        expect.objectContaining({
          request: expect.objectContaining({
            messages: expect.arrayContaining([
              { role: "user", content: "variant B" },
            ]),
          }),
          metadata: expect.objectContaining({
            reused: true,
            modelDispatched: false,
            sourceExecutionId: null,
          }),
          captureState: "partial",
          limitations: ["cache-source-execution-unavailable"],
        }),
      );
      expect(auditMocks.cacheHit).toHaveBeenCalledTimes(2);
      for (const [, terminal] of auditMocks.cacheHit.mock.calls) {
        expect(terminal).toEqual(
          expect.objectContaining({
            metadata: expect.objectContaining({
              modelDispatched: false,
              sourceExecutionId: null,
            }),
          }),
        );
      }
    },
  );

  it.each([
    {
      name: "base prompt",
      nextRequest: {
        messages: [
          { role: "system", content: "you are a writer" },
          { role: "user", content: "a different scene" },
        ],
      },
      nextAudit: AUDIT.audit,
    },
    {
      name: "project",
      nextRequest: { messages: BASE },
      nextAudit: { ...AUDIT.audit, projectId: "project-other" },
    },
    {
      name: "workspace",
      nextRequest: { messages: BASE },
      nextAudit: {
        ...AUDIT.audit,
        expectedWorkspacePath: "/workspace/other",
      },
    },
    {
      name: "surface path",
      nextRequest: { messages: BASE },
      nextAudit: { ...AUDIT.audit, pathId: "ab_inline" as const },
    },
    {
      name: "AI settings",
      nextRequest: { messages: BASE },
      nextAudit: { ...AUDIT.audit, settingsAuthority: "settings:v2" },
    },
  ])(
    "does not reuse across a changed $name authority",
    async ({ nextRequest, nextAudit }) => {
      const config = { model: "model-a" };
      const cached = reuseEntry(
        { messages: BASE },
        config,
        { ok: true, text: "stale" },
        AUDIT.audit,
      );
      const dispatch: AbDispatcher = vi.fn(async () => ({
        ok: true as const,
        text: "fresh",
      }));

      const output = await runAbComparison(nextRequest, [config], dispatch, {
        reuse: [cached],
        audit: nextAudit,
      });

      expect(dispatch).toHaveBeenCalledOnce();
      expect(output[0].result).toEqual({ ok: true, text: "fresh" });
    },
  );
});
