import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_AGENT_IR_CHRONICLE_ID_UTF16_MAX,
  CHAT_AGENT_IR_CHRONICLE_IDS_MAX,
  CHAT_AGENT_IR_ITEM_KEYS,
  CHAT_AGENT_IR_ITEM_MARK,
  CHAT_AGENT_IR_MAX_ITEMS,
  CHAT_AGENT_IR_QUERY_UTF16_MAX,
  CHAT_AGENT_IR_STATUSES,
  isChronicleEventIdList,
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

// S1-A2 added two top-level fields to the answer (`eventIds`,
// `excludedEventIds`) and one key to the request (`chronicleEventIds`).
// Native, `parseChatAgentIrResponse` and this drift test changed in the same
// PR (design r4 delta 2-3; DR-CHATIR-S1-31). This test goes red on purpose when
// only Native changes.
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
    // `to_wire` computes the two object values first, then builds one `json!`.
    const block =
      /fn to_wire\(&self\)[^{]*\{[\s\S]*?json!\(\{([\s\S]*?)\}\)/u.exec(source);
    expect(block, "to_wire not found in flow.rs").not.toBeNull();
    const keys = [...block![1]!.matchAll(/"([A-Za-z]+)":/gu)]
      .map((match) => match[1])
      .sort();
    expect(keys).toEqual([
      "eventIds",
      "excludedEventIds",
      "items",
      "status",
      "success",
    ]);
  });

  it("holds the request's 5 keys against `Request` of request.rs", () => {
    const source = readFileSync(path.join(nativeDir, "request.rs"), "utf8");
    const block = /pub\(crate\) struct Request \{([\s\S]*?)\n\}/u.exec(source);
    expect(block, "Request not found in request.rs").not.toBeNull();
    const camel = (snake: string) =>
      snake.replace(/_([a-z])/gu, (_m, letter: string) => letter.toUpperCase());
    const keys = [...block![1]!.matchAll(/^\s*pub\(crate\) ([a-z_]+):/gmu)]
      .map((match) => camel(match[1]!))
      .sort();
    // Main allows exactly these (`requireExactKeys`) and the wrapper sends them.
    const contract = read("electron/shared/ipcContract.ts");
    const allowed =
      /function requireChatAgentIrSelectRequest[\s\S]*?requireExactKeys\(\s*args,\s*\[([\s\S]*?)\]/u.exec(
        contract,
      );
    expect(allowed, "requireExactKeys of the request not found").not.toBeNull();
    const main = [...allowed![1]!.matchAll(/"([A-Za-z]+)"/gu)]
      .map((match) => match[1])
      .sort();
    expect(keys).toEqual([
      "chronicleEventIds",
      "currentSceneId",
      "expectedWorkspacePath",
      "projectId",
      "query",
    ]);
    expect(main).toEqual(keys);
    const wrapper = read("src/lib/chatIr.ts");
    for (const key of keys) expect(wrapper).toContain(`${key}:`);
    expect(wrapper).toContain("Exactly the five keys");
  });

  it("holds the candidate bounds (30 IDs, 200 units) against request.rs and ipcContract.ts", () => {
    const rust = readFileSync(path.join(nativeDir, "request.rs"), "utf8");
    const count =
      /pub\(crate\) const CHRONICLE_EVENT_IDS_MAX: usize = (\d+);/u.exec(rust);
    const length =
      /pub\(crate\) const CHRONICLE_EVENT_ID_MAX_UTF16: usize = (\d+);/u.exec(
        rust,
      );
    expect(Number(count?.[1])).toBe(CHAT_AGENT_IR_CHRONICLE_IDS_MAX);
    expect(Number(length?.[1])).toBe(CHAT_AGENT_IR_CHRONICLE_ID_UTF16_MAX);
    const contract = read("electron/shared/ipcContract.ts");
    expect(
      Number(
        /export const CHAT_AGENT_IR_CHRONICLE_IDS_MAX = (\d+);/u.exec(
          contract,
        )?.[1],
      ),
    ).toBe(CHAT_AGENT_IR_CHRONICLE_IDS_MAX);
    expect(
      Number(
        /export const CHAT_AGENT_IR_CHRONICLE_ID_UTF16_MAX = (\d+);/u.exec(
          contract,
        )?.[1],
      ),
    ).toBe(CHAT_AGENT_IR_CHRONICLE_ID_UTF16_MAX);
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

/**
 * An answer with the five keys. `excludedEventIds` follows the status (an
 * array on a success, `null` otherwise) unless the test sets it.
 */
function answer(overrides: Record<string, unknown> = {}) {
  const base = {
    status: "available",
    success: true,
    items: [item()],
    eventIds: {},
    ...overrides,
  };
  const judged =
    base.status === "available" || base.status === "none-above-threshold";
  return { excludedEventIds: judged ? [] : null, ...base };
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
    expect(parseChatAgentIrResponse({ ...answer(), other: [] })).toBeNull();
    const { items: _items, ...noItems } = answer();
    expect(parseChatAgentIrResponse(noItems)).toBeNull();
    const { success: _success, ...noSuccess } = answer();
    expect(parseChatAgentIrResponse(noSuccess)).toBeNull();
    // The two keys of S1-A2 are required, not optional.
    const { eventIds: _eventIds, ...noEventIds } = answer();
    expect(parseChatAgentIrResponse(noEventIds)).toBeNull();
    const { excludedEventIds: _excluded, ...noExcluded } = answer();
    expect(parseChatAgentIrResponse(noExcluded)).toBeNull();
  });

  // W1 (S1-A2): `eventIds` and `excludedEventIds`.
  it("accepts eventIds whose keys are revisionIds of the items", () => {
    const value = answer({
      items: [item(), item({ revisionId: "rev-2", sceneId: "scene-2" })],
      eventIds: { "rev-1": "event-1", "rev-2": "event-2" },
      excludedEventIds: ["event-9"],
    });
    expect(parseChatAgentIrResponse(value)).toBe(value);
    // A subset is fine: a revision whose event no longer exists has no entry.
    const partial = answer({ eventIds: { "rev-1": "event-1" } });
    expect(parseChatAgentIrResponse(partial)).toBe(partial);
  });

  it("rejects eventIds that are not an object of revisionId to string", () => {
    const bad: unknown[] = [
      null,
      [],
      ["event-1"],
      "x",
      { "rev-9": "event-1" }, // not a revision of the items
      { "rev-1": 1 },
      { "rev-1": null },
      { "rev-1": "" },
    ];
    for (const eventIds of bad) {
      expect(
        parseChatAgentIrResponse(answer({ eventIds })),
        JSON.stringify(eventIds),
      ).toBeNull();
    }
    // Outside `available` there is no item, so any key is not a revision of one.
    expect(
      parseChatAgentIrResponse(
        answer({
          status: "none-above-threshold",
          items: [],
          eventIds: { "rev-1": "event-1" },
        }),
      ),
    ).toBeNull();
    expect(
      parseChatAgentIrResponse(
        answer({
          status: "busy",
          success: false,
          items: [],
          eventIds: { a: "b" },
        }),
      ),
    ).toBeNull();
  });

  it("holds excludedEventIds to an array on a success and null otherwise", () => {
    for (const status of ["available", "none-above-threshold"]) {
      const items = status === "available" ? [item()] : [];
      const ok = answer({ status, items, excludedEventIds: ["e-1", "e-2"] });
      expect(parseChatAgentIrResponse(ok), status).toBe(ok);
      for (const excludedEventIds of [
        null, // a success always judges
        "e-1",
        {},
        [1],
        [null],
        [""],
        ["e-1", "e-1"], // a duplicate
        Array.from({ length: 31 }, (_, index) => `e-${index}`),
      ]) {
        expect(
          parseChatAgentIrResponse(answer({ status, items, excludedEventIds })),
          `${status} ${JSON.stringify(excludedEventIds)}`,
        ).toBeNull();
      }
    }
    for (const status of CHAT_AGENT_IR_STATUSES) {
      if (status === "available" || status === "none-above-threshold") continue;
      for (const excludedEventIds of [[], ["e-1"]]) {
        expect(
          parseChatAgentIrResponse(
            answer({ status, success: false, items: [], excludedEventIds }),
          ),
          `${status} ${JSON.stringify(excludedEventIds)}`,
        ).toBeNull();
      }
    }
    // 30 is allowed.
    const thirty = answer({
      excludedEventIds: Array.from({ length: 30 }, (_, index) => `e-${index}`),
    });
    expect(parseChatAgentIrResponse(thirty)).toBe(thirty);
  });

  it("checks the helper that the wrapper and Main share the bounds of", () => {
    expect(isChronicleEventIdList([])).toBe(true);
    expect(isChronicleEventIdList(["a".repeat(200)])).toBe(true);
    expect(isChronicleEventIdList(["a".repeat(201)])).toBe(false);
    expect(isChronicleEventIdList(["a", "a"])).toBe(false);
    expect(isChronicleEventIdList([" "])).toBe(false);
    expect(isChronicleEventIdList("a")).toBe(false);
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
