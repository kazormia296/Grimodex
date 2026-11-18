import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_AGENT_IR_ITEM_KEYS,
  CHAT_AGENT_IR_ITEM_MARK,
  CHAT_AGENT_IR_MAX_ITEMS,
  CHAT_AGENT_IR_QUERY_UTF16_MAX,
  CHAT_AGENT_IR_STATUSES,
  parseChatAgentIrResponse,
} from "./chatAgentIrWire.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const nativeDir = path.join(
  repoRoot,
  "electron/native/grimodex-node/src/chat_ir",
);
function read(...parts: string[]): string {
  return readFileSync(path.join(repoRoot, ...parts), "utf8");
}

// When S1-A2 adds a field to the answer (for example the event IDs to leave
// out) or an item key (`eventId`), Native, `parseChatAgentIrResponse` and this
// drift test change in the same PR (design r4 delta 2-3; DR-CHATIR-S1-31).
// This test goes red on purpose when only Native changes.
describe("wire drift (B-T1): the TS side equals what Native sends", () => {
  it("holds the 17 statuses against `ChatIrStatus::as_str` of status.rs", () => {
    const source = readFileSync(path.join(nativeDir, "status.rs"), "utf8");
    const body =
      /const fn as_str\(self\)[^{]*\{\s*match self \{([\s\S]*?)\n {8}\}/u.exec(
        source,
      );
    expect(body, "as_str match not found in status.rs").not.toBeNull();
    const rust = [...body![1]!.matchAll(/=>\s*"([a-z-]+)"/gu)].map(
      (match) => match[1],
    );
    // A pattern that matches nothing must not pass as "equal".
    expect(rust).toHaveLength(17);
    expect([...CHAT_AGENT_IR_STATUSES]).toEqual(rust);
  });

  it("holds the 9 item keys against the item `build_item` of item.rs", () => {
    const source = readFileSync(path.join(nativeDir, "item.rs"), "utf8");
    const mark = /const IR_MARK: &str = "([^"]+)";/u.exec(source);
    expect(mark?.[1]).toBe(CHAT_AGENT_IR_ITEM_MARK);
    const block = /let value = json!\(\{([\s\S]*?)\n\s*\}\);/u.exec(source);
    expect(block, "json! of build_item not found in item.rs").not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s*(?:"([A-Za-z]+)"|(IR_MARK)):/gmu)]
      .map((match) => match[1] ?? mark![1]!)
      .sort();
    expect(keys).toHaveLength(9);
    expect([...CHAT_AGENT_IR_ITEM_KEYS]).toEqual(keys);
    // The fixed values the parser checks.
    expect(source).toMatch(/const ORIGIN: &str = "manuscript";/u);
    expect(source).toMatch(/"review": "human-approved"/u);
    // The keys that must never be items: they belong to the audit or the ledger.
    for (const never of ["eventId", "generation", "quote"]) {
      expect(keys).not.toContain(never);
      expect(CHAT_AGENT_IR_ITEM_KEYS as readonly string[]).not.toContain(never);
    }
  });

  it("holds the answer's top-level keys against `to_wire` of flow.rs", () => {
    const source = readFileSync(path.join(nativeDir, "flow.rs"), "utf8");
    const block = /fn to_wire\(&self\)[^{]*\{\s*json!\(\{([\s\S]*?)\}\)/u.exec(
      source,
    );
    expect(block, "to_wire not found in flow.rs").not.toBeNull();
    const keys = [...block![1]!.matchAll(/"([a-z]+)":/gu)]
      .map((match) => match[1])
      .sort();
    expect(keys).toEqual(["items", "status", "success"]);
  });

  it("holds the query bound against request.rs and ipcContract.ts", () => {
    const rust = /pub\(crate\) const QUERY_MAX_UTF16: usize = (\d+);/u.exec(
      readFileSync(path.join(nativeDir, "request.rs"), "utf8"),
    );
    // The Rust name is `QUERY_MAX_UTF16`, not the TS name.
    expect(Number(rust?.[1])).toBe(CHAT_AGENT_IR_QUERY_UTF16_MAX);
    const contract =
      /export const CHAT_AGENT_IR_QUERY_UTF16_MAX = (\d+);/u.exec(
        read("electron/shared/ipcContract.ts"),
      );
    expect(Number(contract?.[1])).toBe(CHAT_AGENT_IR_QUERY_UTF16_MAX);
  });

  it("holds the item cap against the ranking policy's irMaxScenes and the Rust check", () => {
    const policy = JSON.parse(
      read("policies/narrative/nir1-related-scenes-ranking.json"),
    ) as { irMaxScenes: number };
    expect(policy.irMaxScenes).toBe(CHAT_AGENT_IR_MAX_ITEMS);
    // Rust refuses to start with another value, so a policy change needs a Rust change.
    expect(
      read(
        "electron/native/grimodex-node/src/related_scenes/ranking_policy.rs",
      ),
    ).toContain(`policy.ir_max_scenes == ${CHAT_AGENT_IR_MAX_ITEMS}`);
  });
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    $grimodexIr: 1,
    origin: "manuscript",
    revisionId: "rev-1",
    sceneId: "scene-1",
    sceneTitle: "第一章",
    summary: "要約",
    review: "human-approved",
    quotes: ["引用"],
    score: 0.8123,
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}) {
  return { status: "available", success: true, items: [item()], ...overrides };
}

describe("parseChatAgentIrResponse (B-T2)", () => {
  it("returns the very same object for a good answer", () => {
    const good = answer();
    expect(parseChatAgentIrResponse(good)).toBe(good);
    const empty = answer({ status: "none-above-threshold", items: [] });
    expect(parseChatAgentIrResponse(empty)).toBe(empty);
    const emptyAvailable = answer({ items: [] });
    expect(parseChatAgentIrResponse(emptyAvailable)).toBe(emptyAvailable);
  });

  it("does not rewrite the object", () => {
    const good = answer({
      items: [item({ score: 0.81234567, summary: "  keep  " })],
    });
    const before = JSON.stringify(good);
    const parsed = parseChatAgentIrResponse(good);
    expect(parsed).toBe(good);
    expect(JSON.stringify(good)).toBe(before);
  });

  it("accepts every status with the matching success", () => {
    for (const status of CHAT_AGENT_IR_STATUSES) {
      const success =
        status === "available" || status === "none-above-threshold";
      const value = answer({ status, success, items: [] });
      expect(parseChatAgentIrResponse(value), status).toBe(value);
    }
  });

  it("rejects what is not an answer of this route", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "available",
      [],
      42,
      answer({ status: "weird" }),
      answer({ status: 1 }),
      answer({ success: false }),
      answer({ status: "busy", success: true, items: [] }),
      answer({ success: "true" }),
      answer({ status: "busy", success: false }), // items outside `available`
      answer({ status: "none-above-threshold", items: [item()] }),
      answer({ items: "x" }),
      answer({ items: item() }),
      answer({ items: new Array(9).fill(item()) }),
    ];
    for (const value of bad) {
      expect(parseChatAgentIrResponse(value), JSON.stringify(value)).toBeNull();
    }
    expect(
      parseChatAgentIrResponse(answer({ items: new Array(8).fill(item()) })),
    ).not.toBeNull();
  });

  it("rejects an unknown or missing top-level key (a drift is not passed silently)", () => {
    expect(
      parseChatAgentIrResponse({ ...answer(), excludedEventIds: [] }),
    ).toBeNull();
    const { items: _items, ...noItems } = answer();
    expect(parseChatAgentIrResponse(noItems)).toBeNull();
    const { success: _success, ...noSuccess } = answer();
    expect(parseChatAgentIrResponse(noSuccess)).toBeNull();
  });

  it("rejects an item with another key set, and one with eventId, generation or quote", () => {
    for (const extra of [
      { generation: 3 },
      { eventId: "e-1" },
      { quote: "x" },
      { other: 1 },
    ]) {
      expect(
        parseChatAgentIrResponse(answer({ items: [item(extra)] })),
        JSON.stringify(extra),
      ).toBeNull();
    }
    const { score: _score, ...noScore } = item();
    expect(parseChatAgentIrResponse(answer({ items: [noScore] }))).toBeNull();
  });

  it("rejects fixed values and types that differ", () => {
    const bad = [
      { origin: "chronicle" },
      { review: "ai" },
      { $grimodexIr: 2 },
      { $grimodexIr: "1" },
      { quotes: [] },
      { quotes: "x" },
      { quotes: [1] },
      { revisionId: 1 },
      { sceneId: null },
      { sceneTitle: undefined },
      { summary: 3 },
      { score: "0.8" },
      { score: Number.NaN },
      { score: Number.POSITIVE_INFINITY },
    ];
    for (const override of bad) {
      expect(
        parseChatAgentIrResponse(answer({ items: [item(override)] })),
        JSON.stringify(override),
      ).toBeNull();
    }
    expect(parseChatAgentIrResponse(answer({ items: [null] }))).toBeNull();
    expect(parseChatAgentIrResponse(answer({ items: [[]] }))).toBeNull();
  });

  it("accepts more than one quote (the check is `at least one`)", () => {
    const value = answer({ items: [item({ quotes: ["a", "b"] })] });
    expect(parseChatAgentIrResponse(value)).toBe(value);
  });
});
