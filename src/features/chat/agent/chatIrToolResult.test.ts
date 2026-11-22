import { describe, expect, it, vi } from "vitest";
import type { ChatAgentIrItem } from "@/../electron/shared/chatAgentIrWire";
import {
  CHAT_IR_CAP_EXCEEDED_NOTE,
  chatIrStatusNote,
} from "./chatIrStatusText";
import {
  buildChatIrContent,
  capExceededResult,
  fitChatIrContent,
  precheckChatIrContent,
} from "./chatIrToolResult";

// One character is one token: deterministic, and the cap arithmetic is exact.
const countTokens = (text: string) => text.length;

function item(index: number, summaryLength = 40): ChatAgentIrItem {
  return {
    $grimodexIr: 1,
    origin: "manuscript",
    revisionId: `rev-${index}`,
    sceneId: `scene-${index}`,
    sceneTitle: `Scene ${index}`,
    summary: "s".repeat(summaryLength),
    review: "human-approved",
    quotes: [`quote ${index}`],
    score: 0.5,
  };
}

const events = [
  { eventId: "e1", title: "Event 1", kind: "event", score: 1 },
  { eventId: "e2", title: "Event 2", kind: "event", score: 0.9 },
];

function size(
  status: Parameters<typeof buildChatIrContent>[0],
  items: readonly ChatAgentIrItem[],
  note?: string | null,
) {
  return countTokens(
    JSON.stringify(buildChatIrContent(status, items, events, note)),
  );
}

describe("buildChatIrContent", () => {
  it("puts chronicleIr before events and omits an absent note", () => {
    const content = buildChatIrContent("available", [item(1)], events);
    expect(Object.keys(content)).toEqual(["chronicleIr", "events"]);
    expect(Object.keys(content.chronicleIr)).toEqual(["status", "items"]);
    const withNote = buildChatIrContent("busy", [], events, "n");
    expect(Object.keys(withNote.chronicleIr)).toEqual([
      "status",
      "items",
      "note",
    ]);
    expect(JSON.stringify(withNote).indexOf("chronicleIr")).toBeLessThan(
      JSON.stringify(withNote).indexOf("events"),
    );
  });
});

describe("fitChatIrContent", () => {
  it("B-T4: keeps each kept item as the same object and as a substring", () => {
    const items = [item(1), item(2), item(3)];
    const result = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap: 100_000,
      countTokens,
    });
    expect(result.called).toBe(true);
    expect(result.status).toBe("available");
    expect(result.items).toHaveLength(3);
    const text = JSON.stringify(result.content);
    result.content.chronicleIr.items.forEach((kept, index) => {
      expect(kept).toBe(items[index]);
      expect(text).toContain(JSON.stringify(items[index]));
    });
    expect(result.content.chronicleIr.note).toBeUndefined();
  });

  it("cuts to min(limit, 8) items", () => {
    // 10 items: the cap of 8 is what stops run(30) and run(NaN).
    const items = Array.from({ length: 10 }, (_, i) => item(i + 1, 5));
    const run = (limit: number) =>
      fitChatIrContent({
        outcome: { status: "available", items },
        events: [],
        limit,
        tokenCap: 100_000,
        countTokens,
      }).items.length;
    expect(run(3)).toBe(3);
    expect(run(30)).toBe(8);
    expect(run(Number.NaN)).toBe(8);
  });

  it("drops items from the tail one at a time while over the cap", () => {
    const items = [item(1), item(2), item(3), item(4)];
    const two = size("available", items.slice(0, 2));
    const three = size("available", items.slice(0, 3));
    const result = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap: two + Math.floor((three - two) / 2),
      countTokens,
    });
    expect(result.status).toBe("available");
    expect(result.items).toEqual(items.slice(0, 2));
    expect(result.items[0]).toBe(items[0]);
    expect(result.items[1]).toBe(items[1]);
    expect(countTokens(JSON.stringify(result.content))).toBeLessThanOrEqual(
      two + 1,
    );
  });

  it("keeps exactly the content that is at the cap (the loop truncates only above it)", () => {
    const items = [item(1), item(2)];
    const result = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap: size("available", items),
      countTokens,
    });
    expect(result.items).toHaveLength(2);
  });

  it("answers cap-exceeded (called) when no item fits", () => {
    const items = [item(1), item(2)];
    const only = size("available", items.slice(0, 1));
    const result = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap: only - 1,
      countTokens,
    });
    expect(result.called).toBe(true);
    expect(result.status).toBe("cap-exceeded");
    expect(result.items).toEqual([]);
    expect(result.content.chronicleIr.status).toBe("cap-exceeded");
    expect(result.content.chronicleIr.items).toEqual([]);
  });

  it("leaves the note on a failure when it fits", () => {
    const result = fitChatIrContent({
      outcome: { status: "busy" },
      events,
      limit: 10,
      tokenCap: 100_000,
      countTokens,
    });
    expect(result.status).toBe("busy");
    expect(result.content.chronicleIr.note).toBe(chatIrStatusNote("busy"));
    expect(result.called).toBe(true);
  });

  it("leaves the note out when it would push the content over the cap", () => {
    const bare = size("busy", []);
    const withNote = size("busy", [], chatIrStatusNote("busy"));
    expect(withNote).toBeGreaterThan(bare);
    const result = fitChatIrContent({
      outcome: { status: "busy" },
      events,
      limit: 10,
      tokenCap: bare,
      countTokens,
    });
    expect(result.content.chronicleIr.note).toBeUndefined();
    expect(result.content.chronicleIr.status).toBe("busy");
  });

  it("leaves the cap-exceeded note out when it does not fit either", () => {
    const items = [item(1)];
    const result = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap: size("cap-exceeded", []),
      countTokens,
    });
    expect(result.status).toBe("cap-exceeded");
    expect(result.content.chronicleIr.note).toBeUndefined();
  });

  it("adds the cap-exceeded note when there is room", () => {
    const items = [item(1, 2000)];
    const result = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap: size("cap-exceeded", [], CHAT_IR_CAP_EXCEEDED_NOTE),
      countTokens,
    });
    expect(result.status).toBe("cap-exceeded");
    expect(result.content.chronicleIr.note).toBe(CHAT_IR_CAP_EXCEEDED_NOTE);
  });

  it("does not turn an empty answer into cap-exceeded", () => {
    const result = fitChatIrContent({
      outcome: { status: "none-above-threshold", items: [] },
      events,
      limit: 10,
      tokenCap: 1,
      countTokens,
    });
    expect(result.status).toBe("none-above-threshold");
    expect(result.items).toEqual([]);
  });
});

describe("precheckChatIrContent", () => {
  it("is null while the status-only wrapper stays under the cap", () => {
    const bare = size("cap-exceeded", []);
    expect(
      precheckChatIrContent({ events, tokenCap: bare + 1, countTokens }),
    ).toBeNull();
  });

  it("answers cap-exceeded, not called, when the wrapper reaches the cap", () => {
    const bare = size("cap-exceeded", []);
    for (const tokenCap of [bare, bare - 10]) {
      const result = precheckChatIrContent({ events, tokenCap, countTokens });
      expect(result).not.toBeNull();
      expect(result!.called).toBe(false);
      expect(result!.status).toBe("cap-exceeded");
      expect(result!.items).toEqual([]);
      expect(Object.keys(result!.content)).toEqual(["chronicleIr", "events"]);
      expect(result!.content.events).toBe(events);
    }
  });

  it("tells not-called from called-and-did-not-fit", () => {
    const items = [item(1)];
    const tokenCap = size("available", items) - 1;
    expect(precheckChatIrContent({ events, tokenCap, countTokens })).toBeNull();
    const fitted = fitChatIrContent({
      outcome: { status: "available", items },
      events,
      limit: 10,
      tokenCap,
      countTokens,
    });
    expect(fitted.status).toBe("cap-exceeded");
    expect(fitted.called).toBe(true);
  });

  it("measures with the injected countTokens", () => {
    const spy = vi.fn((text: string) => text.length);
    precheckChatIrContent({ events, tokenCap: 1_000_000, countTokens: spy });
    expect(spy).toHaveBeenCalled();
    expect(typeof spy.mock.calls[0]![0]).toBe("string");
  });
});

describe("the merge (S1-A2b, DR-CHATIR-S1-44)", () => {
  const e3 = { eventId: "e3", title: "Event 3", kind: "event", score: 0.8 };
  const all = [...events, e3];
  const merge = (map: Record<string, string>) => ({
    eventIdOfItem: (i: ChatAgentIrItem) => map[i.revisionId],
    eventIdOfEvent: (e: { eventId: string }) => e.eventId,
  });

  it("puts eventIds between items and note, and only when something is merged", () => {
    const plain = buildChatIrContent("busy", [], events, "n");
    expect(Object.keys(plain.chronicleIr)).toEqual(["status", "items", "note"]);
    const none = buildChatIrContent("busy", [], events, "n", {});
    expect(Object.keys(none.chronicleIr)).toEqual(["status", "items", "note"]);
    const some = buildChatIrContent("busy", [], events, "n", { "rev-1": "e1" });
    expect(Object.keys(some.chronicleIr)).toEqual([
      "status",
      "items",
      "eventIds",
      "note",
    ]);
  });

  it("is today's result without `merge`", () => {
    const outcome = { status: "available" as const, items: [item(1)] };
    const input = {
      outcome,
      events: all,
      limit: 8,
      tokenCap: 10_000,
      countTokens,
    };
    const without = fitChatIrContent(input);
    expect(without.eventIds).toEqual({});
    expect(without.content).toEqual(
      buildChatIrContent("available", [item(1)], all, undefined),
    );
  });

  it("drops the year table's entry of a merged item's event and records its eventId", () => {
    const fit = fitChatIrContent({
      outcome: { status: "available", items: [item(1), item(2)] },
      events: all,
      limit: 8,
      tokenCap: 10_000,
      countTokens,
      merge: merge({ "rev-1": "e1", "rev-2": "nope" }),
    });
    expect(fit.content.events.map((e) => e.eventId)).toEqual(["e2", "e3"]);
    expect(fit.content.chronicleIr.eventIds).toEqual({ "rev-1": "e1" });
    expect(fit.eventIds).toEqual({ "rev-1": "e1" });
  });

  it("decides the merge for the item count that is kept: a dropped item's entry stays", () => {
    const items = [item(1, 10), item(2, 400)];
    const one = countTokens(
      JSON.stringify(
        buildChatIrContent("available", [items[0]!], [events[1]!, e3], null, {
          "rev-1": "e1",
        }),
      ),
    );
    const fit = fitChatIrContent({
      outcome: { status: "available", items },
      events: all,
      limit: 8,
      tokenCap: one,
      countTokens,
      merge: merge({ "rev-1": "e1", "rev-2": "e2" }),
    });
    expect(fit.items.map((i) => i.revisionId)).toEqual(["rev-1"]);
    expect(fit.content.events.map((e) => e.eventId)).toEqual(["e2", "e3"]);
    expect(fit.eventIds).toEqual({ "rev-1": "e1" });
  });

  it("merges nothing, and adds no key, when no item fits (cap-exceeded keeps every entry)", () => {
    const fit = fitChatIrContent({
      outcome: { status: "available", items: [item(1, 400)] },
      events: all,
      limit: 8,
      tokenCap: 300,
      countTokens,
      merge: merge({ "rev-1": "e1" }),
    });
    expect(fit.status).toBe("cap-exceeded");
    expect(fit.content.events).toHaveLength(3);
    expect(fit.eventIds).toEqual({});
    expect(fit.content.chronicleIr).not.toHaveProperty("eventIds");
  });

  it("capExceededResult builds the cap-exceeded content for the events it is given", () => {
    const result = capExceededResult([events[0]!], 10_000, countTokens, false);
    expect(result.status).toBe("cap-exceeded");
    expect(result.called).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.eventIds).toEqual({});
    expect(result.content.events).toEqual([events[0]]);
  });
});
