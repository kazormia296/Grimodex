import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  M4_READ_TOOL_NAMES,
  SEARCH_EVENTS_DESCRIPTION,
  createM4ReadToolDefinitions,
  getDeterministicM4ReadTools,
  sortSchemaKeys,
  sortToolDefinitionsDeterministic,
  type AgentReadToolDefinition,
  type AgentReadToolParameterSchema,
} from "../../../../electron/shared/agentReadToolDefinitions";
import type { AgentToolDefinition, ToolParameterSchema } from "./agentTypes";
import { CHAT_AGENT_IR_ENABLED } from "./chatAgentIrAvailability";
import {
  AGENT_TOOLS,
  getDeterministicAgentTools,
  getResearchSubagentTools,
  snapshotAgentTools,
} from "./toolDefinitions";

/**
 * MP-4b PR-3（DR-MP4-30）：main が組む M4 の 20 本の定義（IR を含まない共有 module）と、
 * renderer の session の snapshot（`chatTurnPreflight.ts` が `snapshotAgentTools()` で作る）の
 * M4 の部分が、`JSON.stringify` の bytes と並びで一致することの drift 試験。
 *
 * 置き場：renderer の module（`./toolDefinitions`）を import するので src に置く
 * （electron の vitest には `@` alias が無く、electron/shared の試験は相対 import だけにする）。
 */

const M4 = new Set<string>(M4_READ_TOOL_NAMES);
const golden = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/legacyReadGolden/${name}.txt`, import.meta.url),
    "utf8",
  );

/** 1 tool 1 行。PR-0 の golden（`definitions.*.bytes.txt`）と同じ形。 */
function linesOf(tools: readonly unknown[]): string {
  return `${tools.map((t) => JSON.stringify(t)).join("\n")}\n`;
}

// 型の相互代入：shared の定義型と renderer の型は同形でなければならない（片方だけ変えると tsc が落ちる）。
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _toolDefinitionTypesAreMutuallyAssignable: Equal<
  AgentReadToolDefinition,
  AgentToolDefinition
> = true;
const _parameterSchemaTypesAreMutuallyAssignable: Equal<
  AgentReadToolParameterSchema,
  ToolParameterSchema
> = true;
void _toolDefinitionTypesAreMutuallyAssignable;
void _parameterSchemaTypesAreMutuallyAssignable;

describe("M4 の定義 module と renderer の snapshot の drift（DR-MP4-30）", () => {
  it("M4 の名前は 20 本で重複せず、AGENT_TOOLS の宣言順の部分集合と同じ並び", () => {
    expect(M4_READ_TOOL_NAMES).toHaveLength(20);
    expect(M4.size).toBe(20);
    expect(
      AGENT_TOOLS.filter((t) => M4.has(t.name)).map((t) => t.name),
    ).toEqual([...M4_READ_TOOL_NAMES]);
    expect(createM4ReadToolDefinitions().map((t) => t.name)).toEqual([
      ...M4_READ_TOOL_NAMES,
    ]);
  });

  it("宣言順：main の module の 20 本は、AGENT_TOOLS の M4 の部分と bytes で一致し、PR-0 の golden とも一致する", () => {
    const main = createM4ReadToolDefinitions();
    const renderer = AGENT_TOOLS.filter((t) => M4.has(t.name));
    // IR が閉の間、renderer の search_events の説明は shared の版と同じ。
    if (!CHAT_AGENT_IR_ENABLED) {
      expect(JSON.stringify(main)).toBe(JSON.stringify(renderer));
    }
    if (!CHAT_AGENT_IR_ENABLED) {
      expect(linesOf(main)).toBe(golden("definitions.m4.bytes"));
    }
  });

  it("session の snapshot（snapshotAgentTools。chatTurnPreflight が固定する）の M4 の部分は、main の決定的な定義と bytes・並びが一致する", () => {
    const main = getDeterministicM4ReadTools();
    const snapshotM4 = snapshotAgentTools().filter((t) => M4.has(t.name));
    expect(main).toHaveLength(20);
    expect(main.map((t) => t.name)).toEqual(snapshotM4.map((t) => t.name));
    if (!CHAT_AGENT_IR_ENABLED) {
      expect(JSON.stringify(main)).toBe(JSON.stringify(snapshotM4));
      expect(linesOf(main)).toBe(golden("definitions.m4-deterministic.bytes"));
    } else {
      // IR を開ける lane：search_events の説明は IR の説明を後ろに足した版で、それ以外は bytes が一致する。
      for (const [index, tool] of main.entries()) {
        const other = snapshotM4[index]!;
        if (tool.name === "search_events") {
          expect(other.description.startsWith(tool.description)).toBe(true);
          expect({ ...other, description: "" }).toEqual({
            ...tool,
            description: "",
          });
        } else {
          expect(JSON.stringify(other)).toBe(JSON.stringify(tool));
        }
      }
    }
  });

  it("session の snapshot の並び：M4 の名前順（localeCompare）は main の並びと同じで、Node の code unit の sort とも一致する", () => {
    const names = getDeterministicM4ReadTools().map((t) => t.name);
    expect(names).toEqual(
      [...M4_READ_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
    expect(names).toEqual([...names].sort());
    expect(
      getDeterministicAgentTools()
        .filter((t) => M4.has(t.name))
        .map((t) => t.name),
    ).toEqual(names);
  });

  it("renderer の決定的な一覧は、44 本のどの順でも shared の sort 関数の結果と同じ（renderer は同じ関数を使う）", () => {
    expect(JSON.stringify(getDeterministicAgentTools())).toBe(
      JSON.stringify(sortToolDefinitionsDeterministic(AGENT_TOOLS)),
    );
    const shuffled = [...getDeterministicM4ReadTools()].reverse();
    expect(
      sortToolDefinitionsDeterministic(shuffled).map((t) => t.name),
    ).toEqual(getDeterministicM4ReadTools().map((t) => t.name));
  });

  it("research sub-agent の search_events の説明は、IR を含まない版（shared）と同じで、M4 の部分は main の定義と bytes で一致する", () => {
    expect(
      getResearchSubagentTools().find((t) => t.name === "search_events")
        ?.description,
    ).toBe(SEARCH_EVENTS_DESCRIPTION);
    const research = getResearchSubagentTools().filter((t) => M4.has(t.name));
    expect(JSON.stringify(research)).toBe(
      JSON.stringify(
        getDeterministicM4ReadTools().filter((t) =>
          research.some((r) => r.name === t.name),
        ),
      ),
    );
  });

  it("sortSchemaKeys：key を再帰的に昇順に並べ、配列と prototype を持たない値はそのまま、入力は変えない", () => {
    const input = { b: { z: 1, a: [{ y: 1, x: 2 }] }, a: null, c: "s" };
    const before = JSON.stringify(input);
    expect(JSON.stringify(sortSchemaKeys(input))).toBe(
      '{"a":null,"b":{"a":[{"y":1,"x":2}],"z":1},"c":"s"}',
    );
    expect(JSON.stringify(input)).toBe(before);
    expect(sortSchemaKeys(3)).toBe(3);
    expect(sortSchemaKeys(null)).toBeNull();
  });

  it("createM4ReadToolDefinitions は呼ぶたびに別の object を返す（書き換えても他に影響しない）", () => {
    const first = createM4ReadToolDefinitions();
    const bytes = JSON.stringify(first);
    first[0]!.name = "mutated";
    first[0]!.inputSchema.required.push("x");
    expect(JSON.stringify(createM4ReadToolDefinitions())).toBe(bytes);
    expect(AGENT_TOOLS[0]!.name).toBe("search_codex");
  });
});
