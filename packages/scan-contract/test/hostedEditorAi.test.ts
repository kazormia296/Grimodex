import { describe, expect, it } from "vitest";
import {
  HOSTED_EDITOR_AI_LIMITS,
  parseHostedEditorAiAgentRequest,
  parseHostedEditorAiResponse,
} from "../src/index.js";

const tool = {
  name: "search_codex",
  description: "Search the project codex",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("hosted Editor AI contract", () => {
  it("accepts bounded declared tools with paired tool history", () => {
    const parsed = parseHostedEditorAiAgentRequest(
      {
        messages: [
          { role: "user", content: "前回を確認して" },
          {
            role: "assistant",
            content: "",
            toolUses: [
              {
                id: "call-previous",
                name: "search_codex",
                input: { query: "前回" },
              },
            ],
          },
          {
            role: "tool_result",
            toolUseId: "call-previous",
            content: "前回の結果",
          },
          { role: "user", content: "次も確認して" },
        ],
        tools: [tool],
      },
      "次も確認して",
    );

    expect(parsed.ok).toBe(true);
  });

  it("rejects hidden reasoning, undeclared tools, and oversized requests", () => {
    expect(
      parseHostedEditorAiAgentRequest(
        {
          messages: [
            {
              role: "assistant",
              content: "visible",
              thinkingBlocks: [{ thinking: "hidden", signature: "sig" }],
            },
            { role: "user", content: "help" },
          ],
          tools: [tool],
        },
        "help",
      ).ok,
    ).toBe(false);

    expect(
      parseHostedEditorAiAgentRequest(
        {
          messages: [
            {
              role: "assistant",
              content: "",
              toolUses: [{ id: "call-1", name: "delete_workspace", input: {} }],
            },
            {
              role: "tool_result",
              toolUseId: "call-1",
              content: "no",
            },
            { role: "user", content: "help" },
          ],
          tools: [tool],
        },
        "help",
      ).ok,
    ).toBe(false);

    const oversizedTools = Array.from(
      { length: HOSTED_EDITOR_AI_LIMITS.maxTools + 1 },
      (_, index) => ({ ...tool, name: `tool_${index}` }),
    );
    expect(
      parseHostedEditorAiAgentRequest(
        {
          messages: [{ role: "user", content: "help" }],
          tools: oversizedTools,
        },
        "help",
      ).ok,
    ).toBe(false);
  });

  it("requires every tool result immediately after its assistant tool-use batch", () => {
    expect(
      parseHostedEditorAiAgentRequest(
        {
          messages: [
            {
              role: "assistant",
              content: "",
              toolUses: [
                {
                  id: "call-1",
                  name: "search_codex",
                  input: { query: "星" },
                },
              ],
            },
            { role: "user", content: "割り込み" },
            {
              role: "tool_result",
              toolUseId: "call-1",
              content: "結果",
            },
            { role: "user", content: "help" },
          ],
          tools: [tool],
        },
        "help",
      ).ok,
    ).toBe(false);
  });

  it("validates response tool calls against the declared allowlist", () => {
    expect(
      parseHostedEditorAiResponse(
        {
          response: "",
          costWeight: 3,
          toolCalls: [
            {
              id: "call-1",
              name: "search_codex",
              input: { query: "星" },
            },
          ],
        },
        new Set(["search_codex"]),
      ),
    ).toMatchObject({ ok: true });

    expect(
      parseHostedEditorAiResponse(
        {
          response: "",
          costWeight: 3,
          toolCalls: [{ id: "call-1", name: "delete_workspace", input: {} }],
        },
        new Set(["search_codex"]),
      ).ok,
    ).toBe(false);

    expect(
      parseHostedEditorAiResponse({
        response: "x".repeat(HOSTED_EDITOR_AI_LIMITS.maxResponseTextChars + 1),
        costWeight: 1,
      }).ok,
    ).toBe(false);
  });
});
