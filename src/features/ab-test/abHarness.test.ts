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
  it("dispatches every config and returns results in order", async () => {
    const dispatch: AbDispatcher = vi.fn(async (_messages, config) => ({
      ok: true as const,
      text: `model=${config.model ?? "default"}`,
    }));

    const out = await runAbComparison(
      { messages: BASE },
      [{}, { model: "gpt-b" }, { model: "gpt-c" }],
      dispatch,
    );

    expect(out.map((s) => s.result)).toEqual([
      { ok: true, text: "model=default" },
      { ok: true, text: "model=gpt-b" },
      { ok: true, text: "model=gpt-c" },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(3);
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
      { parallel: false },
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

  it("isolates a thrown error on one slot without failing the others", async () => {
    const dispatch: AbDispatcher = async (_messages, config) => {
      if (config.model === "boom") throw new Error("kaboom");
      return { ok: true as const, text: "ok" };
    };

    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "boom" }, { model: "fine" }],
      dispatch,
    );

    expect(out[0].result).toEqual({ ok: false, error: "kaboom" });
    expect(out[1].result).toEqual({ ok: true, text: "ok" });
  });

  it("applies promptVariant per slot and exposes composed messages", async () => {
    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "m", promptVariant: "variant A" }, { model: "m" }],
      async () => ({ ok: true as const, text: "ok" }),
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

    const out = await runAbComparison(
      { messages: BASE },
      [{}, { model: "gpt-b" }, { model: "gpt-c" }],
      dispatch,
      {
        reuse: [
          { ok: true, text: "REUSED_0" },
          null,
          { ok: true, text: "REUSED_2" },
        ],
      },
    );

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

    const out = await runAbComparison(
      { messages: BASE },
      [{ model: "a" }, { model: "b" }],
      dispatch,
      { reuse: [{ ok: false, error: "boom" }, null] },
    );

    // failed reuse is not honored → both slots run.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(out[0].result).toEqual({ ok: true, text: "a" });
    expect(out[1].result).toEqual({ ok: true, text: "b" });
  });
});
