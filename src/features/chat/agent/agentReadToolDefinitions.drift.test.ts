import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  AGENT_TOOLS,
  getDeterministicAgentTools,
  getResearchSubagentTools,
} from "./toolDefinitions";

/**
 * MP-4b PR-3（DR-MP4-30）：main が組む M4 の 21 本の定義（IR を含まない共有 module）と、
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
const goldenTool = (name: string) =>
  golden("definitions.agent-tools.bytes")
    .trimEnd()
    .split("\n")
    .find((line) => (JSON.parse(line) as { name: string }).name === name);

/** 1 tool 1 行。PR-0 の golden（`definitions.*.bytes.txt`）と同じ形。 */
function linesOf(tools: readonly unknown[]): string {
  return `${tools.map((t) => JSON.stringify(t)).join("\n")}\n`;
}

/**
 * main と renderer の M4 の部分を比べる。IR が閉なら全体の bytes が一致する。
 * IR が開なら search_events の説明だけが「main の説明＋ IR の説明」で、残りの 19 本と
 * search_events の name・schema は bytes が一致する。
 */
function expectSameExceptIrSuffix(
  main: readonly AgentReadToolDefinition[],
  renderer: readonly AgentToolDefinition[],
  irOpen: boolean,
): void {
  expect(renderer).toHaveLength(main.length);
  if (!irOpen) {
    expect(JSON.stringify(renderer)).toBe(JSON.stringify(main));
    return;
  }
  for (const [index, tool] of main.entries()) {
    const other = renderer[index]!;
    if (tool.name === "search_events") {
      expect(other.description.startsWith(tool.description)).toBe(true);
      expect(other.description.length).toBeGreaterThan(tool.description.length);
      expect(JSON.stringify({ ...other, description: "" })).toBe(
        JSON.stringify({ ...tool, description: "" }),
      );
    } else {
      expect(JSON.stringify(other)).toBe(JSON.stringify(tool));
    }
  }
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
  it("M4 の名前は 21 本で重複せず、AGENT_TOOLS の宣言順の部分集合と同じ並び", () => {
    expect(M4_READ_TOOL_NAMES).toHaveLength(21);
    expect(M4.size).toBe(21);
    expect(
      AGENT_TOOLS.filter((t) => M4.has(t.name)).map((t) => t.name),
    ).toEqual([...M4_READ_TOOL_NAMES]);
    expect(createM4ReadToolDefinitions().map((t) => t.name)).toEqual([
      ...M4_READ_TOOL_NAMES,
    ]);
  });

  it("main の定義は、従来20本の golden と get_codex_entry の legacy golden に bytes で一致する", () => {
    const definitions = createM4ReadToolDefinitions();
    const codexEntry = definitions.find(
      (tool) => tool.name === "get_codex_entry",
    );
    const legacyCodexEntry = JSON.parse(
      goldenTool("get_codex_entry")!,
    ) as AgentReadToolDefinition;
    expect(
      linesOf(definitions.filter((tool) => tool.name !== "get_codex_entry")),
    ).toBe(golden("definitions.m4.bytes"));
    expect(JSON.stringify(codexEntry)).toBe(JSON.stringify(legacyCodexEntry));
    const deterministic = getDeterministicM4ReadTools();
    expect(
      linesOf(deterministic.filter((tool) => tool.name !== "get_codex_entry")),
    ).toBe(golden("definitions.m4-deterministic.bytes"));
    expect(
      JSON.stringify(
        deterministic.find((tool) => tool.name === "get_codex_entry"),
      ),
    ).toBe(
      JSON.stringify(sortToolDefinitionsDeterministic([legacyCodexEntry])[0]),
    );
  });

  it("session の snapshot の並び：M4 の名前順（localeCompare）は main の並びと同じ（同じ process の既定 locale の下でだけ。main と renderer の locale が違えば並びは変わりうる。K-4）、既定 locale の Node では code unit の sort とも一致する", () => {
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

  it("renderer の決定的な一覧は、shared の sort 関数の結果と同じ（renderer は同じ関数を使う。locale は同じ process の既定）", () => {
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

  afterEach(() => {
    vi.doUnmock("./chatAgentIrAvailability");
    vi.resetModules();
  });

  describe.each([
    { irOpen: false, label: "IR が閉（製品の現状）" },
    { irOpen: true, label: "IR が開（search_events の説明だけ IR 版）" },
  ])("renderer の定義と main の drift：$label", ({ irOpen }) => {
    async function loadRenderer() {
      vi.resetModules();
      vi.doMock("./chatAgentIrAvailability", () => ({
        CHAT_AGENT_IR_ENABLED: irOpen,
      }));
      return import("./toolDefinitions");
    }

    it("宣言順：AGENT_TOOLS の M4 の部分は main の 21 本と一致する（IR が開なら search_events の説明だけ後ろに足される）", async () => {
      expect.hasAssertions();
      const renderer = await loadRenderer();
      const main = createM4ReadToolDefinitions();
      const rendererM4 = renderer.AGENT_TOOLS.filter((t) => M4.has(t.name));
      expect(rendererM4.map((t) => t.name)).toEqual(main.map((t) => t.name));
      expectSameExceptIrSuffix(main, rendererM4, irOpen);
    });

    it("session の snapshot の M4 の部分は、main の決定的な定義と bytes・並びが一致する（IR が開なら search_events の説明だけ後ろに足される）", async () => {
      expect.hasAssertions();
      const renderer = await loadRenderer();
      const main = getDeterministicM4ReadTools();
      const snapshotM4 = renderer
        .snapshotAgentTools()
        .filter((t) => M4.has(t.name));
      expect(main).toHaveLength(21);
      expect(snapshotM4.map((t) => t.name)).toEqual(main.map((t) => t.name));
      expectSameExceptIrSuffix(main, snapshotM4, irOpen);
    });

    it("research sub-agent の M4 の部分は、IR の開閉に依らず main の定義と bytes で一致する", async () => {
      expect.hasAssertions();
      const renderer = await loadRenderer();
      const research = renderer
        .getResearchSubagentTools()
        .filter((t) => M4.has(t.name));
      const main = getDeterministicM4ReadTools().filter((t) =>
        research.some((r) => r.name === t.name),
      );
      expect(JSON.stringify(research)).toBe(JSON.stringify(main));
    });
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
