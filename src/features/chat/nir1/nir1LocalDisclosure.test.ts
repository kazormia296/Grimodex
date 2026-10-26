import { describe, expect, it } from "vitest";
import { NIR1_LOCAL_REFUSAL_REASONS } from "../../../../electron/shared/ipcContract";
import {
  NIR1_LOCAL_DISCLOSURE_ITEMS,
  NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS,
  NIR1_LOCAL_PLACEMENT_LINKS_ALL,
  NIR1_LOCAL_PLACEMENT_SHOWS_ROUTE,
  NIR1_LOCAL_SUMMARY_ITEMS,
} from "./nir1LocalDisclosureItems";
import { NIR1_LOCAL_GENERATION_TRANSLATIONS } from "./nir1LocalGenerationTranslations";

// DD-1c (DR-DD1C-9): the disclosure's items 1 to 9 as a structured list, the
// items each placement needs, and the Japanese and English drafts of every
// item and closed code (K5/3 開示の試験 (1), (3), (4), (6)).

const LANGUAGES = ["ja", "en"] as const;
type Strings = (typeof NIR1_LOCAL_GENERATION_TRANSLATIONS)["ja" | "en"];

function itemText(
  strings: Strings,
  item: number,
  part: "title" | "body" | "summary",
): string {
  const entry = (
    strings.disclosure.items as Record<string, Record<string, string>>
  )[String(item)];
  return entry?.[part] ?? "";
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(allStrings);
  }
  return [];
}

/** What placement 1 (every item) shows. */
function placementOneText(strings: Strings): string {
  return [
    strings.disclosure.placementLead["1"],
    ...NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[1].flatMap((item) => [
      itemText(strings, item, "title"),
      itemText(strings, item, "body"),
    ]),
  ].join("\n");
}

/** What placement 5 (the restricted summary) shows before "show all". */
function placementFiveText(strings: Strings): string {
  return [
    strings.disclosure.placementLead["5"],
    ...NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[5].map((item) =>
      itemText(strings, item, "summary"),
    ),
  ].join("\n");
}

describe("the disclosure items and placements", () => {
  it("are items 1 to 9", () => {
    expect([...NIR1_LOCAL_DISCLOSURE_ITEMS]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("put the items each placement needs (K5/3:437-441)", () => {
    expect([...NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[1]]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect([...NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[2]]).toEqual([3, 4, 9]);
    // Placement 3: the destination, the model and the start without a prompt,
    // with the route shown and a step to every item.
    expect(NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[3]).toEqual(
      expect.arrayContaining([2, 3]),
    );
    expect(NIR1_LOCAL_PLACEMENT_SHOWS_ROUTE[3]).toBe(true);
    expect(NIR1_LOCAL_PLACEMENT_LINKS_ALL[3]).toBe(true);
    expect(NIR1_LOCAL_PLACEMENT_SHOWS_ROUTE[1]).toBe(true);
    expect([...NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[5]]).toEqual([3, 4, 6]);
    expect([...NIR1_LOCAL_SUMMARY_ITEMS]).toEqual([3, 4, 6]);
  });
});

describe.each(LANGUAGES)("the %s wording drafts", (language) => {
  const strings = NIR1_LOCAL_GENERATION_TRANSLATIONS[language];

  it("has a title and a body for every item, and a summary for 3, 4 and 6", () => {
    for (const item of NIR1_LOCAL_DISCLOSURE_ITEMS) {
      expect(itemText(strings, item, "title"), `item ${item}`).not.toBe("");
      expect(itemText(strings, item, "body"), `item ${item}`).not.toBe("");
    }
    for (const item of NIR1_LOCAL_SUMMARY_ITEMS) {
      expect(itemText(strings, item, "summary"), `item ${item}`).not.toBe("");
    }
    expect(Object.keys(strings.disclosure.items).sort()).toEqual(
      NIR1_LOCAL_DISCLOSURE_ITEMS.map(String),
    );
    expect(Object.keys(strings.disclosure.placementLead).sort()).toEqual([
      "1",
      "2",
      "3",
      "5",
    ]);
  });

  it("has a text for every closed reason and for unknown", () => {
    expect(Object.keys(strings.reason).sort()).toEqual(
      [...NIR1_LOCAL_REFUSAL_REASONS, "unknown"].sort(),
    );
    for (const text of Object.values(strings.reason)) {
      expect(text).not.toBe("");
    }
  });

  it("has a text for every phase, IPC failure and unusable route", () => {
    expect(Object.keys(strings.panel.phase).sort()).toEqual(
      [
        "idle",
        "starting",
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "refused",
        "lost",
        "unknown",
      ].sort(),
    );
    expect(Object.keys(strings.panel.ipc).sort()).toEqual(
      [
        "egress-denied",
        "failed",
        "held",
        "invalid-request",
        "invalid-result",
      ].sort(),
    );
    expect(Object.keys(strings.route.unusable).sort()).toEqual(
      ["model-invalid", "no-endpoint", "not-loopback", "provider"].sort(),
    );
  });

  // 開示の試験 (3): nothing reads as "confirmed" or "agreed".
  it("never says that something was confirmed or agreed", () => {
    const forbidden =
      language === "ja"
        ? /確認済|同意|承諾|了承/u
        : /\bconfirmed\b|consent|\bagreed?\b|acknowledged/iu;
    for (const text of allStrings(strings)) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it("names no internal plan word", () => {
    for (const text of allStrings(strings)) {
      expect(text).not.toMatch(/PUB-L|Session C|DR-DD|K5\/3|precheck/u);
    }
  });
});

// 開示の試験 (4): the full disclosure states the start without a prompt, the
// default-on policy, that settings can be rewritten (including a newly set
// endpoint, any loopback listener and port forwarding, the user's own data,
// outside delivery and charges), the earlier endpoint and the past turns.
describe("what the full disclosure (placement 1) states", () => {
  it.each([
    [
      "ja",
      [
        "確認の画面は出ません",
        "既定は有効",
        "以前から設定していた接続先",
        "過去の turn",
        "未設定でも新しく設定",
        "OpenAI 互換の server である必要はなく",
        "port 転送",
        "原稿の全文",
        "外部に届き",
        "課金",
        "loopback",
        // K5/3:448 and :452 (review fix 4).
        "port を変えて繰り返し試せます",
        "応答を読む前に request の全体を書きます",
        "検証の結果の表示",
      ],
    ],
    [
      "en",
      [
        "No prompt appears",
        "on by default",
        "endpoint you set earlier",
        "past turns",
        "newly set even when none is set",
        "does not have to be an OpenAI-compatible server",
        "port forwarding",
        "full manuscript",
        "reaches the outside",
        "charge",
        "loopback",
        "try other ports repeatedly",
        "writes the whole request before reading any response",
        "verification results",
      ],
    ],
  ] as const)("%s", (language, phrases) => {
    const text = placementOneText(NIR1_LOCAL_GENERATION_TRANSLATIONS[language]);
    for (const phrase of phrases) expect(text).toContain(phrase);
  });
});

// 開示の試験 (6): the restricted summary covers items 3, 4 and 6 and the range
// of K3/2's (d): the full manuscript, conversation history, AI audit records,
// past text of versions, and the foreshadowing and plot records.
describe("what the restricted summary (placement 5) states", () => {
  it.each([
    [
      "ja",
      [
        "確認なしに始まりえます",
        "未設定でも新しく設定",
        "port 転送",
        "原稿の全文",
        "会話の履歴",
        "AI audit の記録",
        "版の過去の本文",
        "伏線とプロットの記録",
        "外部に届き",
        "課金",
      ],
    ],
    [
      "en",
      [
        "without a prompt",
        "newly set even when none is set",
        "port forwarding",
        "full manuscript",
        "conversation history",
        "AI audit records",
        "past text of versions",
        "foreshadowing and plot records",
        "reaches the outside",
        "charges",
      ],
    ],
  ] as const)("%s", (language, phrases) => {
    const text = placementFiveText(
      NIR1_LOCAL_GENERATION_TRANSLATIONS[language],
    );
    for (const phrase of phrases) expect(text).toContain(phrase);
  });
});
