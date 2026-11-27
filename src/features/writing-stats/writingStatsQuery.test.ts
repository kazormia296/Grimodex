import { describe, it, expect, beforeEach, vi } from "vitest";

type MockRow = Record<string, unknown>;
type MockFilter = { matches: (row: MockRow) => boolean };

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: MockFilter[]) => ({
    matches: (row: MockRow) =>
      conditions.every((condition) => condition.matches(row)),
  }),
  eq: (column: { name: string }, value: unknown) => ({
    matches: (row: MockRow) => row[column.name] === value,
  }),
  gte: (column: { name: string }, value: number) => ({
    matches: (row: MockRow) => Number(row[column.name]) >= value,
  }),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => {
      const query: Record<string, unknown> = {};
      query.from = () => query;
      query.where = (filter: MockFilter) =>
        Promise.resolve(h.rows.filter((row) => filter.matches(row)));
      return query;
    },
  },
}));

vi.mock("@/db/schema", () => {
  const column = (name: string) => ({ name });
  return {
    changeEvents: {
      id: column("id"),
      timestamp: column("timestamp"),
      payload: column("payload"),
      projectId: column("projectId"),
      domain: column("domain"),
    },
  };
});

vi.mock("@/features/attribution/projectStats", () => ({
  loadProjectAttributionStats: async () => ({}),
}));

vi.mock("@/features/ai-usage/usageQuery", () => ({
  getProjectUsageSummary: async () => null,
}));

import {
  insertedCharsFromPayload,
  insertedCharsForEvent,
  INSERTED_CHARS_CACHE_MAX,
  _clearInsertedCharsCache,
  loadWritingStatsData,
} from "./writingStatsQuery";

describe("insertedCharsFromPayload", () => {
  it("ReplaceStep の挿入テキスト長を数える", () => {
    const payload = JSON.stringify({
      steps: [
        {
          stepType: "replace",
          from: 5,
          to: 5,
          slice: { content: [{ type: "text", text: "こんにちは" }] },
        },
      ],
    });
    expect(insertedCharsFromPayload(payload)).toBe(5);
  });

  it("複数 step / ネストした content を合算する", () => {
    const payload = JSON.stringify({
      steps: [
        {
          stepType: "replace",
          slice: {
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "abc" }],
              },
              { type: "text", text: "de" },
            ],
          },
        },
        {
          stepType: "replace",
          slice: { content: [{ type: "text", text: "f" }] },
        },
      ],
    });
    expect(insertedCharsFromPayload(payload)).toBe(6);
  });

  it("削除（空 slice）は 0", () => {
    const payload = JSON.stringify({
      steps: [{ stepType: "replace", from: 2, to: 8, slice: { content: [] } }],
    });
    expect(insertedCharsFromPayload(payload)).toBe(0);
  });

  it("壊れた JSON / 想定外の形は 0（フォールバック）", () => {
    expect(insertedCharsFromPayload("not json")).toBe(0);
    expect(insertedCharsFromPayload(JSON.stringify({}))).toBe(0);
    expect(insertedCharsFromPayload(JSON.stringify({ steps: "x" }))).toBe(0);
  });
});

describe("insertedCharsForEvent", () => {
  beforeEach(() => {
    _clearInsertedCharsCache();
  });

  const payloadOf = (text: string) =>
    JSON.stringify({
      steps: [
        { stepType: "replace", slice: { content: [{ type: "text", text }] } },
      ],
    });

  it("同じ id は再パースせずキャッシュを返す（イベントは不変）", () => {
    expect(insertedCharsForEvent(1, payloadOf("abcde"))).toBe(5);
    // 同一 id なら payload を読み直さない = キャッシュ命中
    expect(insertedCharsForEvent(1, payloadOf("xy"))).toBe(5);
    _clearInsertedCharsCache();
    expect(insertedCharsForEvent(1, payloadOf("xy"))).toBe(2);
  });

  it("id が違えば独立に計算する", () => {
    expect(insertedCharsForEvent(1, payloadOf("ab"))).toBe(2);
    expect(insertedCharsForEvent(2, payloadOf("abcd"))).toBe(4);
  });

  it("上限を超えたら最古のエントリから追い出す（FIFO）", () => {
    expect(insertedCharsForEvent(0, payloadOf("abcde"))).toBe(5);
    for (let i = 1; i <= INSERTED_CHARS_CACHE_MAX; i += 1) {
      insertedCharsForEvent(i, payloadOf("a"));
    }
    // id=0 は追い出されているので再計算される
    expect(insertedCharsForEvent(0, payloadOf("xy"))).toBe(2);
    // 直近の id は残っている
    expect(
      insertedCharsForEvent(INSERTED_CHARS_CACHE_MAX, payloadOf("wxyz")),
    ).toBe(1);
  });
});

describe("loadWritingStatsData", () => {
  it("keeps identity-correction rows out of the existing editor statistics", async () => {
    const now = 1_800_000_000_000;
    const timestamp = now - 1_000;
    _clearInsertedCharsCache();
    h.rows = [
      {
        id: 1,
        projectId: "p1",
        domain: "editor",
        timestamp,
        payload: JSON.stringify({
          steps: [
            {
              stepType: "replace",
              slice: { content: [{ type: "text", text: "abc" }] },
            },
          ],
        }),
      },
      {
        id: 2,
        projectId: "p1",
        domain: "identity-correction",
        opType: "rule.revise",
        sceneId: null,
        timestamp,
        payload: JSON.stringify({
          ruleRevisionId: "r1",
          kind: "must-link-surface",
        }),
      },
    ];

    await expect(loadWritingStatsData("p1", [], now)).resolves.toEqual({
      events: [{ timestamp, chars: 3 }],
      attribution: { human: 0, ai: 0, unknown: 0, total: 0 },
      usage: null,
    });
  });
});
