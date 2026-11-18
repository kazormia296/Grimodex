import { describe, expect, it } from "vitest";

import {
  MODEL_CAPABILITY_ORIGINS,
  MODEL_CAPABILITY_SNAPSHOT_COMMAND,
  parseModelCapabilitySnapshotView,
} from "./modelCapabilitySnapshotWire.js";
import { SHELL_COMMAND_NAMES } from "./ipcContract.js";

const GOOD = {
  origin: "bundled",
  source: "grimodex",
  generatedAt: "2026-11-18T15:28:51Z",
  models: {
    "openai/gpt-a": {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      toolCall: true,
      reasoning: false,
    },
    "anthropic/claude-a": { contextWindow: 200_000 },
  },
};

describe("モデル能力の写しの IPC 契約", () => {
  it("command は読み取り専用の 1 本で、SHELL_COMMAND_NAMES に載る", () => {
    expect(MODEL_CAPABILITY_SNAPSHOT_COMMAND).toBe(
      "get_model_capability_snapshot",
    );
    expect(
      SHELL_COMMAND_NAMES.filter((name) => name.includes("model_capability")),
    ).toEqual([MODEL_CAPABILITY_SNAPSHOT_COMMAND]);
    expect(MODEL_CAPABILITY_ORIGINS).toEqual(["cache", "bundled"]);
  });

  it("正しい値は検証を通り、同じ内容を返す", () => {
    expect(parseModelCapabilitySnapshotView(GOOD)).toEqual(GOOD);
    expect(
      parseModelCapabilitySnapshotView({
        ...GOOD,
        origin: "cache",
        source: "models.dev",
      }),
    ).toMatchObject({ origin: "cache", source: "models.dev" });
  });

  it.each([
    ["null", null],
    ["配列", []],
    ["文字列", "x"],
    ["余分な key", { ...GOOD, extra: 1 }],
    ["key の欠落", { origin: "cache", source: "grimodex", models: {} }],
    ["未知の origin", { ...GOOD, origin: "network" }],
    ["未知の source", { ...GOOD, source: "other" }],
    ["generatedAt が文字列でない", { ...GOOD, generatedAt: 1 }],
    ["models が配列", { ...GOOD, models: [] }],
    ["entry が配列", { ...GOOD, models: { "openai/a": [] } }],
    ["未知の field", { ...GOOD, models: { "openai/a": { name: "x" } } }],
    ["数値が 0", { ...GOOD, models: { "openai/a": { contextWindow: 0 } } }],
    [
      "数値が小数",
      { ...GOOD, models: { "openai/a": { maxOutputTokens: 1.5 } } },
    ],
    [
      "真偽値が文字列",
      { ...GOOD, models: { "openai/a": { toolCall: "true" } } },
    ],
  ])("%s は拒否する", (_label, value) => {
    expect(parseModelCapabilitySnapshotView(value)).toBeNull();
  });

  it("特殊な key（__proto__）が入っていても prototype を汚さない", () => {
    const raw = JSON.parse(
      '{"origin":"cache","source":"grimodex","generatedAt":"x","models":{"__proto__":{"contextWindow":5}}}',
    ) as unknown;
    const parsed = parseModelCapabilitySnapshotView(raw);
    expect(parsed).not.toBeNull();
    expect(({} as Record<string, unknown>).contextWindow).toBeUndefined();
  });
});
