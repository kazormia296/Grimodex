import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI 操作ツールの 1 応答 10 回の上限（withUiOperationLimit）は、送信ターンの runAgentLoop に渡す
// executeTool を包んで初めて効く。ハンドラ単体の試験は配線が外れても通るので、配線そのものを
// source で固定する（AiAuditLazyImport.test.ts と同じ流儀）。
const source = readFileSync(
  resolve(__dirname, "chatTurnStoreActions.ts"),
  "utf8",
);

describe("UI 操作の上限の配線（chatTurnStoreActions）", () => {
  it("runAgentLoop へ渡す executeTool を、ターンの中で withUiOperationLimit に包む", () => {
    expect(source).toMatch(
      /executeTool: withUiOperationLimit\(guardedExecuteTool\),/u,
    );
    // 包むのは 1 箇所だけ。module 直下で作ると全ターンで数が共有されるので、ターン内で呼ぶ。
    expect(source.match(/withUiOperationLimit\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/^const \w+ = withUiOperationLimit/mu);
    // 上限なしの guardedExecuteTool を直接渡す経路が残っていない。
    expect(source).not.toMatch(/executeTool: guardedExecuteTool,/u);
  });
});
