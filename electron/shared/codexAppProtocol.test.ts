import { describe, expect, it } from "vitest";

import {
  buildCodexTurnInput,
  isJsonRpcMessage,
  parseJsonRpcLine,
  serializeJsonRpcMessage,
} from "./codexAppProtocol.js";

describe("codex app-server protocol guards", () => {
  it("accepts JSON-RPC requests, notifications, and responses", () => {
    expect(
      isJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    ).toBe(true);
    expect(
      isJsonRpcMessage({
        jsonrpc: "2.0",
        method: "initialized",
      }),
    ).toBe(true);
    expect(
      isJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      }),
    ).toBe(true);
  });

  it("rejects malformed or ambiguous JSON-RPC messages", () => {
    expect(isJsonRpcMessage(null)).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: "1.0", id: 1, result: {} })).toBe(false);
    expect(
      isJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "x", result: {} }),
    ).toBe(false);
    expect(
      isJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "x", params: [] }),
    ).toBe(true);
  });

  it("parses and serializes one UTF-8 JSONL message without changing newlines", () => {
    const message = parseJsonRpcLine(
      '{"jsonrpc":"2.0","id":7,"method":"turn/start","params":{"text":"日本語\\n二行目"}}',
    );
    expect(message).toMatchObject({ id: 7, method: "turn/start" });
    expect(serializeJsonRpcMessage(message)).toBe(
      '{"jsonrpc":"2.0","id":7,"method":"turn/start","params":{"text":"日本語\\n二行目"}}\n',
    );
  });

  it("builds a context packet with the newest revision authoritative", () => {
    expect(
      buildCodexTurnInput({
        contextPacket: "project=demo",
        historyRevision: "rev-1",
        userMessage: "続きを書いて",
        bootstrapHistory: "old history",
      }),
    ).toContain('<grimodex-context revision="rev-1">');
    expect(
      buildCodexTurnInput({
        contextPacket: "project=demo",
        historyRevision: "rev-1",
        userMessage: "続きを書いて",
      }),
    ).toContain("The newest grimodex-context block is authoritative.");
    expect(
      buildCodexTurnInput({
        contextPacket: "project=demo",
        historyRevision: "rev-1",
        userMessage: "続きを書いて",
        bootstrapHistory: "old history",
      }),
    ).toContain("<grimodex-imported-history>");
  });
});
