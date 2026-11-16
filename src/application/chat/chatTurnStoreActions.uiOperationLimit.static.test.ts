import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI 操作ツールの 1 応答 10 回の上限（createUiOperationLimitHandler）は、送信ターンの中の
// guardedExecuteTool に配線されて初めて効く。ハンドラ単体の試験は配線が外れても通るので、
// 配線そのものを source で固定する（AiAuditLazyImport.test.ts と同じ流儀）。
const source = readFileSync(
  resolve(__dirname, "chatTurnStoreActions.ts"),
  "utf8",
);

describe("UI 操作の上限の配線（chatTurnStoreActions）", () => {
  it("ターンごとにカウンタを作り、guardedExecuteTool が実行の前に通し、runAgentLoop へ渡す", () => {
    const created = source.indexOf("= createUiOperationLimitHandler()");
    const guardedStart = source.indexOf("const guardedExecuteTool");
    expect(created).toBeGreaterThan(-1);
    expect(guardedStart).toBeGreaterThan(created);

    const guardedEnd = source.indexOf("\n          };", guardedStart);
    const guarded = source.slice(guardedStart, guardedEnd);
    const limitCall = guarded.indexOf("limitUiOperation(name, toolCallId)");
    const firstExecute = guarded.indexOf("executeTool(");
    expect(limitCall).toBeGreaterThan(-1);
    // 上限の結果を返す分岐が、実際のツール実行より前にある。
    expect(guarded).toMatch(
      /if \(uiOperationLimitResult\) return uiOperationLimitResult;/u,
    );
    expect(limitCall).toBeLessThan(firstExecute);

    expect(source).toMatch(/executeTool: guardedExecuteTool,/u);
    // ターンの外（module 直下）で作ると全ターンで数が共有されるので、1 箇所だけ・インデント付きの
    // ターン内で作る。
    expect(source.match(/createUiOperationLimitHandler\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/^const \w+ = createUiOperationLimitHandler/mu);
  });
});
