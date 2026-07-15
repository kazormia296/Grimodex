import { describe, it, expect } from "vitest";
import { computeLensDotState } from "./LensDot";
import type { SceneLensRecord } from "@/features/post-effect/types";

function lens(p: Partial<SceneLensRecord>): SceneLensRecord {
  return {
    id: "l",
    projectId: "p",
    runId: "r",
    targetId: "s1",
    lensType: "plot_structure",
    metrics: {},
    finding: null,
    severity: "info",
    createdAt: "2026-01-01T00:00:00.000Z",
    runCompletedAt: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}

describe("computeLensDotState", () => {
  it("worst は SEVERITY_ORDER 上で最も重い severity を選ぶ", () => {
    const { worst } = computeLensDotState(
      [
        lens({ severity: "info" }),
        lens({ severity: "warning" }),
        lens({ severity: "suggestion" }),
      ],
      undefined,
    );
    expect(worst).toBe("warning");
  });

  it("該当 severity が無ければ info にフォールバック", () => {
    // 空配列は実コンポーネントでは早期 return されるが、純関数としては info。
    expect(computeLensDotState([], undefined).worst).toBe("info");
  });

  it("updatedAt が最新 runCompletedAt より後なら stale", () => {
    const { stale } = computeLensDotState(
      [lens({ runCompletedAt: "2026-01-01T00:00:00.000Z" })],
      "2026-01-02T00:00:00.000Z",
    );
    expect(stale).toBe(true);
  });

  it("複数 run のうち最新 runCompletedAt と比較する (最古 run で誤判定しない)", () => {
    // lenses[0] は最古 (2026-01-01) だが、編集 (01-02) は最新診断 (01-03) より前。
    // 最古と比較する旧実装なら stale=true になるが、最新比較では stale=false。
    const { stale } = computeLensDotState(
      [
        lens({ runCompletedAt: "2026-01-01T00:00:00.000Z" }),
        lens({ runCompletedAt: "2026-01-03T00:00:00.000Z" }),
      ],
      "2026-01-02T00:00:00.000Z",
    );
    expect(stale).toBe(false);
  });

  it("updatedAt == runCompletedAt は stale ではない (厳密に後のみ)", () => {
    const { stale } = computeLensDotState(
      [lens({ runCompletedAt: "2026-01-01T00:00:00.000Z" })],
      "2026-01-01T00:00:00.000Z",
    );
    expect(stale).toBe(false);
  });

  it("updatedAt 未指定なら stale ではない", () => {
    expect(computeLensDotState([lens({})], undefined).stale).toBe(false);
  });

  it("runCompletedAt が全て null なら stale ではない", () => {
    const { stale } = computeLensDotState(
      [lens({ runCompletedAt: null })],
      "2026-01-02T00:00:00.000Z",
    );
    expect(stale).toBe(false);
  });

  it("不正な runCompletedAt を無視して最新の有効な診断時刻と比較する", () => {
    const { stale } = computeLensDotState(
      [
        lens({ runCompletedAt: "2026-01-01T00:00:00.000Z" }),
        lens({ runCompletedAt: "not-a-date" }),
      ],
      "2026-01-02T00:00:00.000Z",
    );

    expect(stale).toBe(true);
  });
});
