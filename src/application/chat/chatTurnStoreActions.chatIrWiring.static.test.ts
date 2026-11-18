import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// chat IR S1-B（B-T15、B-T8）。定数が false の間は挙動が同じなので、store の配線が外れても
// 既存の試験は通る。定数を開けたときに初めて壊れる 3 点を source で固定する
// （chatTurnStoreActions.uiOperationLimit.static.test.ts と同じ流儀）。
const source = readFileSync(
  resolve(__dirname, "chatTurnStoreActions.ts"),
  "utf8",
);

function count(pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("chat IR の配線（chatTurnStoreActions）", () => {
  it("束縛した executeTool／executeReadOnlyTool だけを guarded と sub-agent へ渡す", () => {
    expect(count(/executeTool: toolContext\.executeTool,/gu)).toBe(1);
    expect(
      count(/executeReadOnlyTool: toolContext\.executeReadOnlyTool,/gu),
    ).toBe(1);
    // 生の executeTool／executeReadOnlyTool は createChatTurnToolContext にだけ渡す。
    const start = source.indexOf("createChatTurnToolContext({");
    const end = source.indexOf("});", start);
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, end);
    expect(block).toMatch(/^\s+executeTool,$/mu);
    expect(block).toMatch(/^\s+executeReadOnlyTool,$/mu);
    // context の後、turn の runAgentLoop まで（sub-agent と guarded の組み立て）に生の名前が無い。
    const outside = source.slice(
      end,
      source.indexOf("onToolComplete: (record) => {", end),
    );
    expect(outside).not.toMatch(/^\s+executeTool,$/mu);
    expect(outside).not.toMatch(/^\s+executeReadOnlyTool,$/mu);
    expect(outside).not.toMatch(/executeTool: executeTool,/u);
    expect(outside).not.toMatch(/executeReadOnlyTool: executeReadOnlyTool,/u);
  });

  it("onToolComplete は、早期 return の前に usedIds を record へ写す", () => {
    expect(count(/toolContext\.attachUsedIds\(/gu)).toBe(1);
    const handler = source.indexOf("onToolComplete: (record) => {");
    expect(handler).toBeGreaterThan(-1);
    const attach = source.indexOf(
      "toolContext.attachUsedIds(record);",
      handler,
    );
    const earlyReturn = source.indexOf("if (!isCurrentTurn()", handler);
    expect(attach).toBeGreaterThan(handler);
    expect(earlyReturn).toBeGreaterThan(handler);
    expect(attach).toBeLessThan(earlyReturn);
  });

  it("guarded の実行の前に assistant 行の確保（#940）を渡す", () => {
    const start = source.indexOf("createGuardedExecuteTool({");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("});", start));
    expect(block).toMatch(
      /beforeExecute: \(name, toolCallId, authorized\) =>/u,
    );
    expect(block).toMatch(
      /assistantRow\.before\(name, toolCallId, authorized\)/u,
    );
  });
});
