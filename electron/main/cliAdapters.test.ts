import { describe, expect, it } from "vitest";

import { createCliLineAdapter } from "./cliAdapters.js";

describe("CLI NDJSON adapters", () => {
  it("Claudeは累積textのUnicode suffixだけを出し、tool blockを無視する", () => {
    const adapter = createCliLineAdapter("claude");
    expect(
      adapter.parseLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "猫🐈" },
              { type: "tool_use", name: "bash", input: {} },
            ],
          },
        }),
      ),
    ).toEqual([{ type: "text", delta: "猫🐈" }]);
    expect(
      adapter.parseLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "猫🐈です" }] },
        }),
      ),
    ).toEqual([{ type: "text", delta: "です" }]);
  });

  it("Claude resultからusage/stop reasonをDoneへ変換する", () => {
    const adapter = createCliLineAdapter("claude");
    expect(
      adapter.parseLine(
        JSON.stringify({
          type: "result",
          usage: { input_tokens: 42, output_tokens: 17 },
          stop_reason: "end_turn",
        }),
      ),
    ).toEqual([
      {
        type: "done",
        inputTokens: 42,
        outputTokens: 17,
        stopReason: "end_turn",
      },
    ]);
  });

  it("Codexはmessage差分とreasoningを分離しusageを集約する", () => {
    const adapter = createCliLineAdapter("codex");
    expect(
      adapter.parseLine(
        '{"type":"item.updated","item":{"id":"m1","item_type":"assistant_message","text":"Hello"}}',
      ),
    ).toEqual([{ type: "text", delta: "Hello" }]);
    expect(
      adapter.parseLine(
        '{"type":"item.completed","item":{"id":"m1","item_type":"assistant_message","text":"Hello!"}}',
      ),
    ).toEqual([{ type: "text", delta: "!" }]);
    expect(
      adapter.parseLine(
        '{"type":"item.completed","item":{"id":"r1","item_type":"reasoning","text":"think"}}',
      ),
    ).toEqual([{ type: "thinking", delta: "think" }]);
    expect(
      adapter.parseLine(
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}',
      ),
    ).toEqual([
      {
        type: "done",
        inputTokens: 10,
        outputTokens: 20,
        stopReason: "end_turn",
      },
    ]);
  });

  it("Codexの構造化errorはtext + Done(error)へ変換する", () => {
    const adapter = createCliLineAdapter("codex");
    expect(
      adapter.parseLine(
        '{"type":"error","error":{"message":"quota exceeded"}}',
      ),
    ).toEqual([
      { type: "text", delta: "[error] quota exceeded\n" },
      {
        type: "done",
        inputTokens: null,
        outputTokens: null,
        stopReason: "error",
      },
    ]);
  });

  it("OpenCodeはtextを差分化し、tool-calls途中Doneを無視する", () => {
    const adapter = createCliLineAdapter("opencode");
    expect(
      adapter.parseLine('{"type":"text","part":{"id":"p1","text":"Hi"}}'),
    ).toEqual([{ type: "text", delta: "Hi" }]);
    expect(
      adapter.parseLine('{"type":"text","part":{"id":"p1","text":"Hi!"}}'),
    ).toEqual([{ type: "text", delta: "!" }]);
    expect(
      adapter.parseLine(
        '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":1,"output":2}}}',
      ),
    ).toEqual([]);
    expect(
      adapter.parseLine(
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":100,"output":5}}}',
      ),
    ).toEqual([
      {
        type: "done",
        inputTokens: 100,
        outputTokens: 5,
        stopReason: "stop",
      },
    ]);
  });

  it("壊れたJSONと未知eventはfail-softで無視する", () => {
    for (const kind of ["claude", "codex", "opencode"] as const) {
      const adapter = createCliLineAdapter(kind);
      expect(adapter.parseLine("not-json")).toEqual([]);
      expect(adapter.parseLine('{"type":"unknown"}')).toEqual([]);
    }
  });

  it("未知CliKindを拒否する", () => {
    expect(() => createCliLineAdapter("node" as never)).toThrow(
      "invalid CLI kind: node",
    );
  });
});
