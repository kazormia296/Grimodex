import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_MANIFEST,
  validateAgentToolManifest,
} from "./toolManifest";

const golden = {
  read: [
    "search_codex", "search_events", "list_codex_by_type", "get_codex_entry",
    "list_codex_tags", "search_codex_by_tags", "find_related_entries",
    "list_chapters", "get_scene", "search_scenes", "list_plot_threads",
    "get_thread_scenes", "search_snippets", "get_chapter_summaries",
    "list_open_foreshadows", "get_foreshadow_detail", "get_scene_timeline_neighbors",
    "list_events", "get_event_detail", "get_character_timeline",
    "get_chronicle_state", "get_app_help_index", "get_app_help", "get_ui_state",
    "run_research", "ask_user",
  ],
  mutate: [
    "create_codex_entry", "update_codex_entry", "create_foreshadow",
    "update_foreshadow", "create_snippet", "apply_ai_tree_plan",
    "create_event", "update_event", "stamp_scene_event",
    "unstamp_scene_event", "set_event_participants", "add_event_relation",
  ],
  stage: ["propose_scene_body"],
  destructive: ["delete_event", "remove_event_relation"],
  ui: ["run_app_command", "apply_layout_preset", "propose_setting_change"],
} as const;

describe("agent tool manifest safety metadata", () => {
  it("keeps the 44 tool classifications and approval modes at the reviewed golden", () => {
    expect(AGENT_TOOL_MANIFEST).toHaveLength(44);
    for (const [effect, names] of Object.entries(golden)) {
      expect(
        AGENT_TOOL_MANIFEST.filter((tool) => tool.effect === effect)
          .map(({ name }) => name)
          .sort(),
      ).toEqual([...names].sort());
    }
    expect(
      AGENT_TOOL_MANIFEST.filter((tool) =>
        ["read", "stage", "ui"].includes(tool.effect),
      ).every((tool) => tool.approvalMode === "none"),
    ).toBe(true);
    expect(
      AGENT_TOOL_MANIFEST.filter((tool) => tool.effect === "mutate")
        .every((tool) => tool.approvalMode === "task-scope"),
    ).toBe(true);
    expect(
      AGENT_TOOL_MANIFEST.filter((tool) => tool.effect === "destructive")
        .every((tool) => tool.approvalMode === "always"),
    ).toBe(true);
  });

  it("rejects unknown values and incompatible classification metadata", () => {
    const entry = (values: Record<string, unknown>) => ({
      name: "custom_tool",
      capability: "write",
      effect: "mutate",
      approvalMode: "task-scope",
      requiredPolicy: "chat",
      allowedChannels: ["agent"],
      requiresUserConfirmation: false,
      ...values,
    }) as unknown as Parameters<typeof validateAgentToolManifest>[0][number];

    expect(() =>
      validateAgentToolManifest([
        { name: "missing", capability: "write", effect: "mutate" } as unknown as Parameters<
          typeof validateAgentToolManifest
        >[0][number],
      ]),
    ).toThrow(/classification/);
    for (const invalid of [
      entry({ effect: "unknown" }),
      entry({ approvalMode: "each" }),
      entry({ approvalMode: "none" }),
      entry({ effect: "stage", approvalMode: "always" }),
      entry({ effect: "read", capability: "write", approvalMode: "none" }),
    ]) {
      expect(() => validateAgentToolManifest([invalid])).toThrow();
    }
    expect(() =>
      validateAgentToolManifest([entry({ effect: "ui", approvalMode: "none" })]),
    ).toThrow(/ui effect is not allowed/);
    expect(() =>
      validateAgentToolManifest([
        entry({ effect: "ui", approvalMode: "none", name: "run_app_command" }),
      ]),
    ).not.toThrow();
  });
});
