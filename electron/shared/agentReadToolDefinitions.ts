/**
 * agent の read tool のうち、main の Mastra read（MP-4）が扱う 21 本（M4）の「定義」
 * （name・description・input_schema）と、定義の決定的な並べ方。
 *
 * MP-4b PR-3（DR-MP4-30）。renderer の `src/features/chat/agent/toolDefinitions.ts`（legacy）が
 * 44 本の宣言の中でこの 21 本をここから取り、IR の部分（search_events の IR 版の説明）だけを足す。
 * main は `toolDefinitions.ts` を import せず、この module だけから定義を取る。
 * AI に渡る bytes は、移す前の `toolDefinitions.ts` と 1 byte も変えない
 * （`toolDefinitions.legacyGolden.test.ts` と `agentReadToolDefinitions.drift.test.ts` が固定する）。
 *
 * 守ること：
 * - chat IR の module・定数・wire・読み方の説明を import も参照もしない。
 *   search_events の説明は IR の読み方を含まない版だけを持つ（IR 版は renderer が足す）。
 *   静的試験 `agentReadToolDefinitions.static.test.ts` が固定する。
 * - 相対 import だけ（NodeNext の `.js` 拡張子）。この module は import を持たない。
 * - Node／Electron／DOM に依存しない純粋 module。
 */

/** LLM に送る tool パラメータの schema（JSON Schema のサブセット）。renderer の `ToolParameterSchema` と同形。 */
export interface AgentReadToolParameterSchema {
  type: string;
  description?: string;
  minimum?: number;
  items?: AgentReadToolParameterSchema;
  enum?: string[];
  properties?: Record<string, AgentReadToolParameterSchema>;
  required?: string[];
}

/** LLM に送る tool 定義。renderer の `AgentToolDefinition` と同形（相互代入は drift 試験が型で固定する）。 */
export interface AgentReadToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, AgentReadToolParameterSchema>;
    required: string[];
  };
}

/**
 * M4 の 21 本の name。並びは renderer の `AGENT_TOOLS` の宣言順（部分集合）と同じ。
 * Q4 で tools の wire が名前だけになった場合に、main は wire の名前をこの集合と照合する（DR-MP4-21 の 3）。
 */
export const M4_READ_TOOL_NAMES = [
  "search_codex",
  "search_events",
  "list_codex_by_type",
  "get_codex_entry",
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

export type M4ReadToolName = (typeof M4_READ_TOOL_NAMES)[number];

const REVEAL_SCENE_GUIDANCE =
  " Events may include revealScene {id, title, revealedToReader}: the scene where the author reveals the event to readers. When revealedToReader is false, readers do not know it yet at the current scene, so do not write it as something readers already know; when revealedToReader is absent, it was not judged.";

/**
 * search_events の説明（chat IR の読み方を含まない版）。
 * renderer の IR 版は、これの後ろに IR の説明を足す。research sub-agent はこれをそのまま使う。
 */
export const SEARCH_EVENTS_DESCRIPTION =
  "Semantic search of the chronicle (in-world fabula timeline) events by *meaning*, not keywords. Embeds the query and matches it against each event's title, note, primary character, location, and participant names. Use for natural-language questions like 'when does the protagonist first betray someone', 'events at the shrine', 'the battle where the king dies'. Returns eventId, title, kind, and score (cosine similarity), best matches first. Follow up with get_event_detail for full detail. Complements list_events (which lists in chronicle order without ranking)." +
  REVEAL_SCENE_GUIDANCE;

/**
 * M4 の 21 本の定義を、宣言順で新しく組んで返す。
 * 呼ぶたびに別の object を返す（呼び手が書き換えても他に影響しない）。
 */
export function createM4ReadToolDefinitions(): AgentReadToolDefinition[] {
  return [
    {
      name: "search_codex",
      description:
        "Search Codex entries and Notes by keyword across name, aliases, summary, and tags. Note: entries mentioned in the current scene (including Notes) and entries spotlighted by the user are already injected into the system prompt with their summaries (and their UUIDs as `id: ...` lines, plus aliases) — use this tool to discover entries that are NOT already injected. Returns id, name, type, and summary (no full content). Whitespace-separated tokens are treated as OR (any match), so a multi-word query is fine.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword or short phrase",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "search_events",
      description: SEARCH_EVENTS_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language description of the event(s) to find",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "list_codex_by_type",
      description:
        "List all Codex entries of a specific type. Returns id, name, summary, and tags. Useful for cross-cutting queries (e.g. 'list every character', 'find all lore entries'). Common types: character, location, item, lore. Custom types are also supported.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Entry type slug (e.g. 'character', 'location', 'item', 'lore')",
          },
        },
        required: ["type"],
      },
    },
    {
      name: "get_codex_entry",
      description:
        "Get the full content body, custom detail fields, and child entry summaries for a specific Codex entry. Note: summaries for scene-mentioned and spotlighted entries are already injected — use this tool only when the injected summary is insufficient and you need the full body or custom details.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The entry's UUID — NOT its name. For an entry that already appears in the injected Codex section, the UUID is shown on the `id: ...` line directly under the entry's name. For an entry not yet injected, call search_codex / list_codex_by_type first to obtain the UUID.",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "list_codex_tags",
      description:
        "List all available Codex tags with usage counts. Optionally filter by entry type.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Optional: filter tags by compatible entry type",
          },
        },
        required: [],
      },
    },
    {
      name: "search_codex_by_tags",
      description:
        "Find Codex entries that have specific tags. Uses OR logic — entries matching any of the given tags are returned.",
      inputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tag names to filter by (OR logic)",
          },
        },
        required: ["tags"],
      },
    },
    {
      name: "find_related_entries",
      description:
        "Find Codex entries that *reference* a given source entry by name or alias. The source entry's name and all its aliases are searched as substrings across other entries' name, summary, aliases, and tags. Use this for natural-language questions like 'what items does Akane carry?', 'what locations relate to the shrine?', 'what lore mentions this character?' — pass the source entry's UUID and optionally a type filter to narrow results. Returns id, name, type, summary (max 20). Much more reliable than search_codex for relationship discovery.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "UUID of the source entry whose relationships you want to discover. The UUID can be taken from the `id: ...` line of an injected entry, or from a previous search_codex / list_codex_by_type result.",
          },
          type: {
            type: "string",
            description:
              "Optional: filter results to entries of this type only (e.g., 'item', 'location', 'character', 'lore'). Omit to return all types.",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "list_chapters",
      description:
        "Get the project's full chapter and scene structure with titles, statuses, and node types. Does not include scene text content.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_scene",
      description:
        "Get the full Markdown text content of a specific scene. Use the scene id from list_chapters.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Scene node ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "search_scenes",
      description:
        "Search across all scene texts for a keyword or phrase. Returns scene id, title, and a snippet of matching text. Whitespace-separated tokens are treated as OR (any match).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword or short phrase",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "list_plot_threads",
      description:
        "List the author's plot threads (sub-plots / through-lines). Returns each thread's id, name, description, scene count, and which narrative phases (introduce→resolve) it has reached. Use get_thread_scenes to read the scenes on a specific thread.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_thread_scenes",
      description:
        "Get the scenes the author explicitly linked to a plot thread, in narrative-phase order (introduce→resolve), each with a text excerpt, plus any branch/merge edges. Use the thread id from list_plot_threads. This is the author's hand-drawn sub-plot structure, not a semantic search.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Plot thread ID" },
        },
        required: ["threadId"],
      },
    },
    {
      name: "search_snippets",
      description:
        "Search snippets by keyword across title, content, and tags. Returns id, title, tags, and a preview of the content. Whitespace-separated tokens are treated as OR (any match).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword or short phrase",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_chapter_summaries",
      description:
        "Get auto-generated synopsis summaries for all chapters and their scenes. Useful for understanding the story so far.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "list_open_foreshadows",
      description:
        "List all unresolved foreshadowing items in the project (payoff not yet confirmed and not abandoned). Returns id, title, intent, loadBearing (critical/supporting/optional/null), setupCount (non-orphan), and derived lifecycle labels (e.g. critical_weak, needs_strengthening). Sorted by loadBearing priority then most recently updated. Set includeSettled=true to also include paid-off items: unresolved items come first (same order), then paid-off items, each of which has settled: true. In this mode each item has id, title, intent, loadBearing and setupCount. Abandoned items are never included. Omit it or pass false to list only unresolved items. Note: a priority-sorted slice with derived labels is already injected into the system prompt under '### 未回収の伏線' and scene-specific labels under '### このシーンの伏線' — use this tool when you need the full list or id-based follow-up via get_foreshadow_detail.",
      inputSchema: {
        type: "object",
        properties: {
          includeSettled: {
            type: "boolean",
            description: "Include paid-off items with settled: true",
          },
        },
        required: [],
      },
    },
    {
      name: "get_foreshadow_detail",
      description:
        "Get the full detail for a single foreshadowing item: title, intent, notes, loadBearing, payoffConfirmed, abandoned, payoff scene reference, and the list of setups (each with sceneId, sceneTitle, kind, strength, attribution, aiRationale, isOrphan). Use the id from list_open_foreshadows or the injected '### 未回収の伏線' / '### このシーンの伏線' sections.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The foreshadow's UUID",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "get_scene_timeline_neighbors",
      description:
        "Given a scene id, return up to 3 preceding and 3 following scenes in story-time order (not reading order). Each neighbor includes id, title, storyTimeLabel (e.g. '3年前'), and synopsis. Returns empty arrays if the target scene has no storyTimeOrder set. Useful for verifying chronological consistency or recalling story-time-adjacent events that read out of order.",
      inputSchema: {
        type: "object",
        properties: {
          sceneId: {
            type: "string",
            description: "Scene node id whose story-time neighbors to retrieve",
          },
        },
        required: ["sceneId"],
      },
    },
    {
      name: "list_events",
      description:
        "List the story-chronicle events (the in-world fabula timeline, distinct from reading order) of the current project, in chronicle order. Optionally filter by kind ('birth' | 'death' | 'generic'). Each event returns id, title, kind, ordinal, startTime (days from the in-world epoch; may be null when only the order is known), startDate (the calendar-formatted date string, e.g. 'Year 1267, 4月3日'; null when there is no calendar or the date granularity is unset), and the primary character's name. Use to answer 'when did X happen' or to survey the timeline." +
        REVEAL_SCENE_GUIDANCE,
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "Optional filter: 'birth', 'death', or 'generic'. Omit for all events.",
          },
        },
        required: [],
      },
    },
    {
      name: "get_event_detail",
      description:
        "Given a chronicle event id, return its full detail: title, note, kind, ordinal, startTime/endTime, startDate/endDate (calendar-formatted date strings for the start and end; null when there is no calendar or the granularity is unset), primary character, location, participant characters (names + roles), the scenes the event is stamped to (id + title), and its causal relations (cause→effect titles). Use after list_events to inspect one event." +
        REVEAL_SCENE_GUIDANCE,
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Chronicle event id" },
        },
        required: ["eventId"],
      },
    },
    {
      name: "get_character_timeline",
      description:
        "Given a character's Codex id, return the chronicle events that character takes part in (as primary or participant), in chronicle order, each with title, kind, startTime, and the character's age at that event when derivable (requires a birth event and a calendar). Use to answer 'how old is X now' or 'what has happened to X'." +
        REVEAL_SCENE_GUIDANCE,
      inputSchema: {
        type: "object",
        properties: {
          codexId: { type: "string", description: "Character Codex entry id" },
        },
        required: ["codexId"],
      },
    },
    {
      name: "get_chronicle_state",
      description:
        "Return the world-state snapshot at a scene's story time: which of the relevant characters are alive/dead/unborn and their ages, the current season, the most recent events, unresolved cause→effect pairs (cause has happened, effect has not yet), and off-page background events. Recent and off-page events each carry a relTime label (the time distance from the scene's anchor, e.g. '約2年前' / 'about 2 years earlier' / '同日'; null when there is no calendar). If sceneId is omitted, the current scene is used. Use to check temporal/seasonal/age consistency before writing. Returns structured JSON." +
        REVEAL_SCENE_GUIDANCE,
      inputSchema: {
        type: "object",
        properties: {
          sceneId: {
            type: "string",
            description:
              "Scene node id to anchor on. Omit to use the current scene.",
          },
        },
        required: [],
      },
    },
  ];
}

/** Sort object keys recursively for deterministic JSON schema. */
export function sortSchemaKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }
  const record = obj as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortSchemaKeys(record[key]);
  }
  return sorted;
}

/**
 * 決定的な tool 一覧：name を `localeCompare` で並べ、schema の key を再帰的に sort する。
 * 入力は変えない。renderer の session の snapshot（`getDeterministicAgentTools`）と main は同じ関数で並べる。
 * `localeCompare` は locale に依存する。並びが一致するのは、同じ process の既定 locale の下でだけで、
 * main と renderer の locale が違えば並びが変わりうる（例：Node の cs・sk では "ch" が "h" の後ろ。
 * 名前は ASCII の snake_case だが、この 44 本の中にも影響が出る。K-4、DR-MP4-30）。
 * この PR は既存の挙動（renderer の今の並びと同じ comparator）を変えない。
 */
export function sortToolDefinitionsDeterministic<
  T extends AgentReadToolDefinition,
>(tools: readonly T[]): T[] {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      ...tool,
      inputSchema: sortSchemaKeys(tool.inputSchema) as T["inputSchema"],
    }));
}

/** main が組む M4 の定義（name 順＋ schema の key を sort）。renderer の snapshot の M4 の部分と、同じ既定 locale の下では bytes で一致する。 */
export function getDeterministicM4ReadTools(): AgentReadToolDefinition[] {
  return sortToolDefinitionsDeterministic(createM4ReadToolDefinitions());
}
