/**
 * Single source of truth for system-prompt trust boundaries.
 *
 * Reference-data tags are consumed by both the localized base policy and the
 * renderer hardening layer. Adding a data source here therefore makes the
 * declaration, reserved-tag escaping, and coverage tests move together.
 */
export const DATA_LAYER_REGISTRY = {
  project: { tag: "project_info" },
  story: { tag: "story_so_far" },
  scene: { tag: "current_scene" },
  focus: { tag: "focus_subject" },
  codex: { tag: "codex_entries" },
  thread: { tag: "plot_thread_scenes" },
  chronicle: { tag: "chronicle_snapshot" },
  recall: { tag: "related_scenes" },
  episodic: { tag: "chat_history" },
  summary: { tag: "conversation_summary" },
} as const;

/** Author-controlled instructions are deliberately outside reference data. */
export const AUTHOR_POLICY_TAG = "author_instructions" as const;

export const PROMPT_DATA_TAG_NAMES = Object.freeze(
  Object.values(DATA_LAYER_REGISTRY).map(({ tag }) => tag),
);

/**
 * Every boundary tag is reserved inside prompt payloads. This prevents a scene,
 * Codex entry, or author-policy body from closing its wrapper and changing the
 * trust level of the text that follows.
 */
export const PROMPT_RESERVED_TAG_NAMES = Object.freeze([
  AUTHOR_POLICY_TAG,
  ...PROMPT_DATA_TAG_NAMES,
]);

/** Legacy layer-key mapping retained while the renderer migrates to typed items. */
export const PROMPT_DATA_TAGS = {
  l1: DATA_LAYER_REGISTRY.project.tag,
  l2: DATA_LAYER_REGISTRY.story.tag,
  l3: DATA_LAYER_REGISTRY.scene.tag,
  focus: DATA_LAYER_REGISTRY.focus.tag,
  l4: DATA_LAYER_REGISTRY.codex.tag,
  plotThreadScenes: DATA_LAYER_REGISTRY.thread.tag,
  chronicle: DATA_LAYER_REGISTRY.chronicle.tag,
  rag: DATA_LAYER_REGISTRY.recall.tag,
  episodic: DATA_LAYER_REGISTRY.episodic.tag,
  l5: DATA_LAYER_REGISTRY.summary.tag,
} as const;

export function formatPromptTagName(tag: string): string {
  return `\`${tag}\``;
}

export function formatPromptDataTagList(): string {
  return PROMPT_DATA_TAG_NAMES.map(formatPromptTagName).join(", ");
}
