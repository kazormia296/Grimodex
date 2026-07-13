import { describe, it, expect } from "vitest";
import {
  resolveToolProtocol,
  isHermesProtocol,
  parseHermesToolCalls,
  formatHermesToolCall,
  formatHermesToolResponse,
  buildHermesToolsPreamble,
  hermesAllowedToolNames,
  MUTATING_TOOL_NAMES,
} from "./toolProtocolParse";
import { DEFAULT_AI_SETTINGS, type AiSettings } from "./types";

describe("resolveToolProtocol", () => {
  it("gates non-HTTP providers to native regardless of mode", () => {
    expect(resolveToolProtocol("anthropic", "nous-hermes", "hermes")).toBe(
      "native",
    );
    expect(resolveToolProtocol("cli", "hermes", "auto")).toBe("native");
  });

  it("honors explicit native/hermes on HTTP providers", () => {
    expect(resolveToolProtocol("openrouter", "gpt-4", "hermes")).toBe("hermes");
    expect(
      resolveToolProtocol("openrouter", "nousresearch/hermes-3", "native"),
    ).toBe("native");
  });

  it("keeps Sakana in sync with the Rust OpenAI-compatible Hermes gate", () => {
    expect(resolveToolProtocol("sakana", "fugu-hermes", "hermes")).toBe(
      "hermes",
    );
  });

  it("auto detects only model names containing 'hermes'", () => {
    expect(
      resolveToolProtocol("openrouter", "nousresearch/Hermes-3-Llama", "auto"),
    ).toBe("hermes");
    expect(resolveToolProtocol("openrouter", "qwen/qwen-2.5-72b", "auto")).toBe(
      "native",
    );
    // mode 省略時は auto 扱い。
    expect(resolveToolProtocol("ollama", "hermes-pro")).toBe("hermes");
  });
});

describe("isHermesProtocol", () => {
  it("returns false for null/undefined and default settings", () => {
    expect(isHermesProtocol(null)).toBe(false);
    expect(isHermesProtocol(DEFAULT_AI_SETTINGS)).toBe(false); // model="" auto
  });

  it("reflects resolveToolProtocol for a hermes model", () => {
    const s: AiSettings = {
      ...DEFAULT_AI_SETTINGS,
      provider: "openrouter",
      model: "nousresearch/hermes-3",
    };
    expect(isHermesProtocol(s)).toBe(true);
    expect(isHermesProtocol({ ...s, toolProtocolMode: "native" })).toBe(false);
  });
});

describe("hermesAllowedToolNames", () => {
  it("drops mutating tools so body <tool_call> can't trigger writes", () => {
    const declared = [
      "search_codex",
      "create_codex_entry",
      "get_scene",
      "propose_scene_body",
      "apply_ai_tree_plan",
    ];
    const allowed = hermesAllowedToolNames(declared);
    expect(allowed).toContain("search_codex");
    expect(allowed).toContain("get_scene");
    for (const m of MUTATING_TOOL_NAMES) expect(allowed).not.toContain(m);
  });

  it("drops undeclared manifest-unknown tools by default", () => {
    expect(
      hermesAllowedToolNames(["search_codex", "future_unknown_tool"]),
    ).toEqual(["search_codex"]);
  });

  it("a mutating body tool_call is not parsed into a call", () => {
    const body =
      '<tool_call>{"name":"create_codex_entry","arguments":{"name":"x"}}</tool_call>';
    const allowed = hermesAllowedToolNames(["create_codex_entry"]);
    const { calls } = parseHermesToolCalls(body, allowed);
    expect(calls).toHaveLength(0);
  });
});

describe("parseHermesToolCalls", () => {
  it("parses a single <tool_call> and strips it from text", () => {
    const body =
      '検索します。\n<tool_call>{"name":"search_codex","arguments":{"query":"朱音"}}</tool_call>';
    const { strippedText, calls } = parseHermesToolCalls(body, [
      "search_codex",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: "hermes-0",
      name: "search_codex",
      input: { query: "朱音" },
    });
    expect(strippedText).toContain("検索します");
    expect(strippedText).not.toContain("<tool_call>");
  });

  it("parses multiple calls, newline JSON, and the `input` key", () => {
    const body =
      '<tool_call>\n{"name": "search_codex", "arguments": {"query": "a"}}\n</tool_call>\n' +
      '<tool_call>{"name":"get_codex_entry","input":{"id":"x1"}}</tool_call>';
    const { calls } = parseHermesToolCalls(body, [
      "search_codex",
      "get_codex_entry",
    ]);
    expect(calls.map((c) => c.name)).toEqual([
      "search_codex",
      "get_codex_entry",
    ]);
    expect(calls[1].input).toEqual({ id: "x1" });
  });

  it("accepts stringified `arguments`", () => {
    const body =
      '<tool_call>{"name":"search_codex","arguments":"{\\"q\\":1}"}</tool_call>';
    const { calls } = parseHermesToolCalls(body, ["search_codex"]);
    expect(calls[0].input).toEqual({ q: 1 });
  });

  it("ignores unknown tools and broken JSON but still strips tags", () => {
    const body =
      '前文\n<tool_call>{"name":"unknown_tool","arguments":{}}</tool_call>\n' +
      "<tool_call>{壊れた</tool_call>\n後文";
    const { strippedText, calls } = parseHermesToolCalls(body, [
      "search_codex",
    ]);
    expect(calls).toHaveLength(0);
    expect(strippedText).toContain("前文");
    expect(strippedText).toContain("後文");
    expect(strippedText).not.toContain("<tool_call>");
  });

  it("produces no calls when allowed is empty (non-tools path) but still strips", () => {
    const body =
      '<tool_call>{"name":"search_codex","arguments":{}}</tool_call>tail';
    const { strippedText, calls } = parseHermesToolCalls(body, []);
    expect(calls).toHaveLength(0);
    expect(strippedText).toBe("tail");
  });
});

describe("format round-trip", () => {
  it("formatHermesToolCall is re-parseable by parseHermesToolCalls", () => {
    const encoded = formatHermesToolCall("search_codex", { query: "x" });
    const { calls } = parseHermesToolCalls(encoded, ["search_codex"]);
    expect(calls[0]).toEqual({
      id: "hermes-0",
      name: "search_codex",
      input: { query: "x" },
    });
  });

  it("formatHermesToolResponse wraps content in a <tool_response> block", () => {
    const out = formatHermesToolResponse("search_codex", '{"ok":true}', false);
    expect(out).toContain("<tool_response>");
    expect(out).toContain("</tool_response>");
    expect(out).toContain("search_codex");
  });

  it("buildHermesToolsPreamble lists each tool schema inside <tools>", () => {
    const out = buildHermesToolsPreamble([
      {
        name: "search_codex",
        description: "search the codex",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
    expect(out).toContain("<tools>");
    expect(out).toContain("</tools>");
    expect(out).toContain("search_codex");
    expect(out).toContain('"parameters"');
    // 呼び出し形式の指示が含まれる。
    expect(out).toContain("<tool_call>");
  });
});
