import { describe, it, expect, vi } from "vitest";
import {
  applyPromptVariant,
  runAbComparison,
  type AbDispatcher,
  type AbMessage,
} from "./abHarness";

const BASE: AbMessage[] = [
  { role: "system", content: "you are a writer" },
  { role: "user", content: "continue the scene" },
];

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
  it("dispatches both configs in parallel and returns both results", async () => {
    const dispatch: AbDispatcher = vi.fn(async (_messages, config) => ({
      ok: true as const,
      text: `model=${config.model ?? "default"}`,
    }));

    const result = await runAbComparison(
      { messages: BASE },
      { model: "gpt-a" },
      { model: "gpt-b" },
      dispatch,
    );

    expect(result.a).toEqual({ ok: true, text: "model=gpt-a" });
    expect(result.b).toEqual({ ok: true, text: "model=gpt-b" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("runs both sides concurrently (not sequentially)", async () => {
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
      // b can finish while a is still blocked → proves parallelism
      order.push("b-end");
      releaseA();
      return { ok: true as const, text: "B" };
    };

    const result = await runAbComparison(
      { messages: BASE },
      { model: "a" },
      { model: "b" },
      dispatch,
    );

    expect(result.a).toEqual({ ok: true, text: "A" });
    expect(result.b).toEqual({ ok: true, text: "B" });
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
      { model: "a" },
      { model: "b" },
      dispatch,
      { parallel: false },
    );

    // A fully completes before B starts.
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("isolates a thrown error on one side without failing the other", async () => {
    const dispatch: AbDispatcher = async (_messages, config) => {
      if (config.model === "boom") throw new Error("kaboom");
      return { ok: true as const, text: "ok" };
    };

    const result = await runAbComparison(
      { messages: BASE },
      { model: "boom" },
      { model: "fine" },
      dispatch,
    );

    expect(result.a).toEqual({ ok: false, error: "kaboom" });
    expect(result.b).toEqual({ ok: true, text: "ok" });
  });

  it("applies promptVariant per side and passes composed messages to dispatch", async () => {
    const seen: { messages: AbMessage[]; model?: string | null }[] = [];
    const dispatch: AbDispatcher = async (messages, config) => {
      seen.push({ messages, model: config.model });
      return { ok: true as const, text: "ok" };
    };

    const result = await runAbComparison(
      { messages: BASE },
      { model: "m", promptVariant: "variant A" },
      { model: "m", promptVariant: "" },
      dispatch,
    );

    // side A got the appended variant, side B did not
    expect(result.messagesA).toHaveLength(3);
    expect(result.messagesA[2]).toEqual({ role: "user", content: "variant A" });
    expect(result.messagesB).toHaveLength(2);

    const aRun = seen.find((s) => s.messages.length === 3);
    const bRun = seen.find((s) => s.messages.length === 2);
    expect(aRun).toBeDefined();
    expect(bRun).toBeDefined();
  });

  it("propagates dispatcher { ok:false } results verbatim", async () => {
    const dispatch: AbDispatcher = async () => ({
      ok: false as const,
      error: "rate limited",
    });
    const result = await runAbComparison({ messages: BASE }, {}, {}, dispatch);
    expect(result.a).toEqual({ ok: false, error: "rate limited" });
    expect(result.b).toEqual({ ok: false, error: "rate limited" });
  });

  it("reuses an ok A result and only dispatches B", async () => {
    const seen: (string | null | undefined)[] = [];
    const dispatch: AbDispatcher = async (_messages, config) => {
      seen.push(config.model);
      return { ok: true as const, text: `model=${config.model ?? "default"}` };
    };

    const result = await runAbComparison(
      { messages: BASE },
      {},
      { model: "gpt-b" },
      dispatch,
      { reuseA: { ok: true, text: "REUSED_A" } },
    );

    expect(result.a).toEqual({ ok: true, text: "REUSED_A" });
    expect(result.b).toEqual({ ok: true, text: "model=gpt-b" });
    // A は dispatch されず B だけが走る。
    expect(seen).toEqual(["gpt-b"]);
  });

  it("ignores a failed reuseA and dispatches both sides", async () => {
    const dispatch: AbDispatcher = vi.fn(async (_messages, config) => ({
      ok: true as const,
      text: `${config.model}`,
    }));

    const result = await runAbComparison(
      { messages: BASE },
      { model: "a" },
      { model: "b" },
      dispatch,
      { reuseA: { ok: false, error: "boom" } },
    );

    // 失敗結果は流用しない → A も含め両側を実行。
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.a).toEqual({ ok: true, text: "a" });
    expect(result.b).toEqual({ ok: true, text: "b" });
  });
});
