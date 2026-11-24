import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  M4_READ_TOOL_NAMES,
  SEARCH_EVENTS_DESCRIPTION,
  createM4ReadToolDefinitions,
} from "./agentReadToolDefinitions.js";

/**
 * MP-4b PR-3（DR-MP4-21 の 2 と 6、DR-MP4-30）：IR を含まない tool 定義 module の静的試験。
 *
 * - この module は `toolDefinitions.ts`（chat IR の定数と wire を import する）も IR の module も import しない。
 * - 相対 import だけ（`@/` の alias も bare specifier も使わない）。実体は import を 1 つも持たない。
 * - IR の symbol・command 名・wire の名前・IR の読み方の説明（chronicleIr）が source にも定義にも無い。
 *
 * 置き場：electron/shared。相対 import だけ（electron の vitest には `@` alias が無い）。
 * 走査する module の一覧は `DEFINITION_MODULES`。IR の閉包の静的試験（`irClosure.static.test.ts`）が
 * 入ったら、そちらの走査 root にこの一覧を足して統合できる。
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const DEFINITION_MODULES = ["electron/shared/agentReadToolDefinitions.ts"];

/** 静的 import／export from／動的 import／require の specifier を取り出す。 */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^;'"]*?\sfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const FORBIDDEN_TEXT: readonly string[] = [
  "chatAgentIr",
  "chat_agent_ir",
  ["chat", "agent", "ir"].join("-"),
  "chatIr",
  "chat-ir",
  "CHAT_AGENT_IR",
  "searchEventsWithIr",
  "selectChatAgentIr",
  "chronicleIr",
  "SEARCH_EVENTS_IR_DESCRIPTION",
];

describe("IR を含まない tool 定義 module の静的試験", () => {
  for (const relative of DEFINITION_MODULES) {
    const source = readFileSync(path.join(repoRoot, relative), "utf8");

    it(`${relative} は import を持たず、toolDefinitions.ts・IR の module・alias・bare specifier を参照しない`, () => {
      const specifiers = specifiersOf(source);
      expect(specifiers).toEqual([]);
      expect(source).not.toMatch(/\bimport\.meta\b|\bprocess\.env\b/u);
    });

    it(`${relative} は IR の symbol・command 名・wire の名前・IR の説明を含まない`, () => {
      for (const word of FORBIDDEN_TEXT) {
        expect(source.includes(word), `${relative}: ${word}`).toBe(false);
      }
    });
  }

  it("走査が空振りしない：検出器は IR の import を実際に検出する", () => {
    // 試験の source 自身が import に見える文字列を持たないよう、例は部品から組み立てる。
    const kw = ["fr", "om"].join("");
    const q = (...parts: string[]) => `"${parts.join("")}"`;
    const sample = [
      `import { A } ${kw} ${q("./chat", "AgentIrAvailability")};`,
      `export { B } ${kw} ${q("../x/tool", "Definitions")};`,
      `const m = await ${["imp", "ort"].join("")}(${q("@/lib/chat", "Ir")});`,
      `${["imp", "ort"].join("")} ${q("side-effect")};`,
    ].join("\n");
    expect(specifiersOf(sample)).toEqual([
      "./chatAgentIrAvailability",
      "../x/toolDefinitions",
      "side-effect",
      "@/lib/chatIr",
    ]);
  });

  it("M4 の定義は 21 本で、search_events の説明は IR の読み方を含まない版（無条件）", () => {
    const definitions = createM4ReadToolDefinitions();
    expect(definitions).toHaveLength(21);
    expect(definitions.map((t) => t.name)).toEqual([...M4_READ_TOOL_NAMES]);
    const searchEvents = definitions.find((t) => t.name === "search_events");
    expect(searchEvents?.description).toBe(SEARCH_EVENTS_DESCRIPTION);
    for (const tool of definitions) {
      const text = JSON.stringify(tool);
      for (const word of [
        "chronicleIr",
        "chronicleIr.items",
        "chat_agent_ir",
      ]) {
        expect(text.includes(word), `${tool.name}: ${word}`).toBe(false);
      }
    }
    // M4 は read 専用：write・ask_user・run_research・ui の tool を含まない。
    for (const forbidden of [
      "run_research",
      "ask_user",
      "get_ui_state",
      "run_app_command",
      "propose_setting_change",
    ]) {
      expect(M4_READ_TOOL_NAMES as readonly string[]).not.toContain(forbidden);
    }
    expect(
      definitions.every(
        (t) => !/^(create|update|apply|propose|add|remove|set)_/u.test(t.name),
      ),
    ).toBe(true);
  });
});
