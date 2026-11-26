import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_TOOLS,
  getDeterministicAgentTools,
  getResearchSubagentTools,
  snapshotAgentTools,
} from "./toolDefinitions";
import {
  createMastraUiToolDefinitions,
  MASTRA_UI_TOOL_NAMES,
} from "@/../electron/shared/mastraUiToolDefinitions";
import {
  createMastraWriteToolDefinitions,
  MASTRA_WRITE_TOOL_NAMES,
} from "@/../electron/shared/mastraWriteToolDefinitions";

/**
 * MP-4b PR-0：tool の「定義」（name・description・schema）の bytes の golden。
 *
 * 後続の PR-3 が M4 の 20 本の定義を IR を含まない共有 module へ移すとき、renderer の
 * `toolDefinitions.ts`（legacy）が model に渡す bytes が 1 byte も変わらないことの oracle にする。
 * golden は未変更の legacy から生成した。1 tool 1 行（`JSON.stringify(tool)`）で置き、
 * `JSON.stringify(配列)` との一致は試験で別に確かめる（diff を読めるようにするため）。
 *
 * 試験の置き場：renderer の module（`./toolDefinitions`）を import するので src に置く。
 */

const M4_TOOL_NAMES = [
  "search_codex",
  "search_events",
  "list_codex_by_type",
  "list_codex_tags",
  "search_codex_by_tags",
  "find_related_entries",
  "list_chapters",
  "get_scene",
  "search_scenes",
  "list_plot_threads",
  "get_thread_scenes",
  "search_snippets",
  "get_chapter_summaries",
  "list_open_foreshadows",
  "get_foreshadow_detail",
  "get_scene_timeline_neighbors",
  "list_events",
  "get_event_detail",
  "get_character_timeline",
  "get_chronicle_state",
] as const;

const M4 = new Set<string>(M4_TOOL_NAMES);

/** 1 tool 1 行。配列の bytes は `[` ＋ 行を `,` で結ぶ ＋ `]` と一致する。 */
function linesOf(tools: readonly unknown[]): string {
  return `${tools.map((t) => JSON.stringify(t)).join("\n")}\n`;
}

function expectArrayBytesMatchLines(tools: readonly unknown[]): void {
  const lines = linesOf(tools).trimEnd().split("\n");
  expect(JSON.stringify(tools)).toBe(`[${lines.join(",")}]`);
}

const golden = (name: string) => `./__fixtures__/legacyReadGolden/${name}.txt`;

describe("tool 定義の bytes golden（legacy の toolDefinitions.ts）", () => {
  it("Mastra UI の共有定義は 7 本だけで、renderer の golden と同じ bytes", () => {
    const shared = createMastraUiToolDefinitions();
    const uiNames = new Set<string>(MASTRA_UI_TOOL_NAMES);
    const renderer = AGENT_TOOLS.filter((tool) => uiNames.has(tool.name));
    expect(MASTRA_UI_TOOL_NAMES).toEqual([
      "ask_user",
      "run_app_command",
      "apply_layout_preset",
      "propose_setting_change",
      "get_ui_state",
      "get_app_help_index",
      "get_app_help",
    ]);
    expect(shared).toHaveLength(7);
    expect(new Set(shared.map((tool) => tool.name))).toEqual(uiNames);
    expect(linesOf(shared)).toEqual(linesOf(renderer));
  });

  it("Mastra write の共有定義は 15 本で、renderer の golden と同じ bytes", async () => {
    const shared = createMastraWriteToolDefinitions();
    const writeNames = new Set<string>(MASTRA_WRITE_TOOL_NAMES);
    const renderer = AGENT_TOOLS.filter((tool) => writeNames.has(tool.name));
    expect(MASTRA_WRITE_TOOL_NAMES).toEqual([
      "create_codex_entry",
      "update_codex_entry",
      "create_foreshadow",
      "update_foreshadow",
      "create_snippet",
      "apply_ai_tree_plan",
      "propose_scene_body",
      "create_event",
      "update_event",
      "delete_event",
      "stamp_scene_event",
      "unstamp_scene_event",
      "set_event_participants",
      "add_event_relation",
      "remove_event_relation",
    ]);
    expect(shared).toHaveLength(15);
    expect(linesOf(shared)).toEqual(linesOf(renderer));
    await expect(linesOf(shared)).toMatchFileSnapshot(
      golden("definitions.write-tools.bytes"),
    );
  });

  it("AGENT_TOOLS は 44 本で、M4 の 20 本はすべてその中にある（名前は重複しない）", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toHaveLength(44);
    expect(new Set(names).size).toBe(44);
    for (const name of M4_TOOL_NAMES) expect(names, name).toContain(name);
    expect(M4.size).toBe(20);
  });

  it("AGENT_TOOLS（44 本）の JSON.stringify の bytes（宣言順）", async () => {
    expectArrayBytesMatchLines(AGENT_TOOLS);
    await expect(linesOf(AGENT_TOOLS)).toMatchFileSnapshot(
      golden("definitions.agent-tools.bytes"),
    );
  });

  it("M4 の 20 本の定義の bytes（AGENT_TOOLS の宣言順の部分集合）", async () => {
    const m4 = AGENT_TOOLS.filter((t) => M4.has(t.name));
    expect(m4).toHaveLength(20);
    expectArrayBytesMatchLines(m4);
    await expect(linesOf(m4)).toMatchFileSnapshot(
      golden("definitions.m4.bytes"),
    );
  });

  it("session の snapshot（getDeterministicAgentTools：name の localeCompare 順＋ schema の key を sort）の M4 の部分の bytes（DR-MP4-30 の drift 試験の比較元）", async () => {
    const m4 = getDeterministicAgentTools().filter((t) => M4.has(t.name));
    expect(m4).toHaveLength(20);
    expectArrayBytesMatchLines(m4);
    await expect(linesOf(m4)).toMatchFileSnapshot(
      golden("definitions.m4-deterministic.bytes"),
    );
  });

  it("snapshot の並び：44 本の name 順（localeCompare）は、Node の code unit の sort と一致する", () => {
    const names = getDeterministicAgentTools().map((t) => t.name);
    expect(names).toHaveLength(44);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(snapshotAgentTools().map((t) => t.name)).toEqual(names);
  });

  it("snapshot の並び（golden）：44 本の name を localeCompare 順に並べた一覧", async () => {
    await expect(
      `${getDeterministicAgentTools()
        .map((t) => t.name)
        .join("\n")}\n`,
    ).toMatchFileSnapshot(golden("definitions.snapshot-order"));
  });

  it("research sub-agent の定義（getResearchSubagentTools。search_events の説明を上書きした後）の bytes", async () => {
    const tools = getResearchSubagentTools();
    expectArrayBytesMatchLines(tools);
    // 上書きの後の search_events の説明。IR が閉の間は snapshot の説明と同じ（上書きは no-op）。
    // IR を開ける lane で差が出る（その時はこの golden が落ちて、意図した変更か確かめる）。
    const snap = getDeterministicAgentTools().find(
      (t) => t.name === "search_events",
    );
    const research = tools.find((t) => t.name === "search_events");
    expect(research?.description).toBe(snap?.description);
    await expect(linesOf(tools)).toMatchFileSnapshot(
      golden("definitions.research-subset.bytes"),
    );
  });

  it("CREATOR_TOOLS（contextCreatorApi.ts の非公開の定数）の 4 本の相対順：AGENT_TOOLS の宣言順を保つ", () => {
    // contextCreatorApi.ts は CREATOR_TOOLS を export しない。製品コードは変えないので、
    // 述語の写しで同じ部分集合を作り、写しが source と食い違わないことを source の文字列で確かめる。
    const source = readFileSync(
      new URL("../contextCreatorApi.ts", import.meta.url),
      "utf8",
    );
    const block =
      /const CREATOR_TOOLS = AGENT_TOOLS\.filter\(\(t\) =>\s*\[([^\]]*)\]\.includes\(t\.name\)/u.exec(
        source,
      );
    expect(block).not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/gu)].map(
      (m) => m[1],
    );
    expect(declared).toEqual([
      "search_codex",
      "list_codex_by_type",
      "search_codex_by_tags",
      "search_snippets",
    ]);
    const creator = AGENT_TOOLS.filter((t) => declared.includes(t.name));
    expect(creator.map((t) => t.name)).toEqual([
      "search_codex",
      "list_codex_by_type",
      "search_codex_by_tags",
      "search_snippets",
    ]);
    expectArrayBytesMatchLines(creator);
  });

  it("CREATOR_TOOLS の 4 本の bytes", async () => {
    const creator = AGENT_TOOLS.filter((t) =>
      [
        "search_codex",
        "list_codex_by_type",
        "search_codex_by_tags",
        "search_snippets",
      ].includes(t.name),
    );
    await expect(linesOf(creator)).toMatchFileSnapshot(
      golden("definitions.creator-tools.bytes"),
    );
  });
});
