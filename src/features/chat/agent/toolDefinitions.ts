import type { AgentToolDefinition } from "./agentTypes";

/** エージェントが使用できる全ツール定義 */
export const AGENT_TOOLS: AgentToolDefinition[] = [
  // ── Codex系 ──────────────────────────────────────────────────────────────
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
    description:
      "Semantic search of the chronicle (in-world fabula timeline) events by *meaning*, not keywords. Embeds the query and matches it against each event's title, note, primary character, location, and participant names. Use for natural-language questions like 'when does the protagonist first betray someone', 'events at the shrine', 'the battle where the king dies'. Returns eventId, title, kind, and score (cosine similarity), best matches first. Follow up with get_event_detail for full detail. Complements list_events (which lists in chronicle order without ranking).",
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

  // ── Codex write (knowledgeWrite policy) ───────────────────────────────────
  {
    name: "create_codex_entry",
    description:
      "Create a new Codex entry in the current project. Requires knowledgeWrite policy. Returns the new entry id, name, and type.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Entry type slug (e.g. 'character', 'location', 'item', 'lore')",
        },
        name: { type: "string", description: "Display name" },
        summary: {
          type: "string",
          description: "Optional short summary (plain text)",
        },
        content: {
          type: "string",
          description: "Optional ProseMirror JSON body string",
        },
        aliases: {
          type: "string",
          description: "Optional JSON string array of aliases",
        },
        parentId: {
          type: "string",
          description: "Optional parent entry UUID",
        },
      },
      required: ["type", "name"],
    },
  },
  {
    name: "update_codex_entry",
    description:
      "Update fields of an existing Codex entry. Requires knowledgeWrite policy. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry UUID" },
        name: { type: "string" },
        summary: { type: "string" },
        content: { type: "string", description: "ProseMirror JSON body" },
        aliases: { type: "string", description: "JSON string array" },
      },
      required: ["id"],
    },
  },

  // ── Foreshadow write (knowledgeWrite policy) ──────────────────────────────
  {
    name: "create_foreshadow",
    description:
      "Create a new foreshadowing (plant/payoff) item. Requires knowledgeWrite policy. secret defaults to true — secret items are hidden from list_open_foreshadows and AI context until the author reveals them; pass secret=false if you need to read it back later in this conversation.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title of the plant" },
        intent: {
          type: "string",
          description: "What this plant sets up and how it should pay off",
        },
        notes: { type: "string", description: "Optional working notes" },
        loadBearing: {
          type: "string",
          enum: ["critical", "supporting", "optional"],
          description: "How load-bearing the plant is for the plot",
        },
        secret: {
          type: "boolean",
          description: "Hide from AI context (default true)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_foreshadow",
    description:
      "Update an existing foreshadowing item (rename, refine intent/notes, set loadBearing, mark payoffConfirmed when the payoff landed, or abandoned). Requires knowledgeWrite policy. Only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Foreshadow UUID" },
        title: { type: "string" },
        intent: { type: "string" },
        notes: { type: "string" },
        loadBearing: {
          type: "string",
          enum: ["critical", "supporting", "optional"],
        },
        payoffConfirmed: {
          type: "boolean",
          description: "Mark the payoff as landed",
        },
        abandoned: {
          type: "boolean",
          description: "Mark the plant as abandoned",
        },
        secret: { type: "boolean" },
      },
      required: ["id"],
    },
  },

  {
    name: "create_snippet",
    description:
      "Create a new Snippet in the current project. Requires knowledgeWrite policy. Returns id and title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Snippet title" },
        content: {
          type: "string",
          description: "Optional ProseMirror JSON body",
        },
        sceneId: {
          type: "string",
          description: "Optional scene UUID to associate",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "apply_ai_tree_plan",
    description:
      "Apply a tree scaffold/reorganize plan (create/move/rename ops). Requires structureWrite policy; synopsis fields also require bodyWrite. Max 200 ops. Use temp IDs prefixed with 'tmp:' for new nodes.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["scaffold", "reorganize"],
          description: "Plan kind",
        },
        ops: {
          type: "array",
          description: "Array of create/move/rename operations",
          items: { type: "object" },
        },
      },
      required: ["kind", "ops"],
    },
  },

  {
    name: "propose_scene_body",
    description:
      "Propose plain-text body prose for a scene (staged accept/reject — does not apply until the user accepts in the editor). Requires bodyWrite policy. File-backed scenes are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string", description: "Target scene UUID" },
        text: { type: "string", description: "Plain-text prose to propose" },
        mode: {
          type: "string",
          enum: ["append", "insert"],
          description:
            "append = end of scene; insert = current caret when scene is open",
        },
      },
      required: ["sceneId", "text"],
    },
  },

  // ── Scenes系 ──────────────────────────────────────────────────────────────
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

  // ── Plot threads系 ────────────────────────────────────────────────────────
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

  // ── Snippets系 ────────────────────────────────────────────────────────────
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

  // ── Summary系 ─────────────────────────────────────────────────────────────
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

  // ── Foreshadow / Timeline 系 ─────────────────────────────────────────────
  {
    name: "list_open_foreshadows",
    description:
      "List all unresolved foreshadowing items in the project (payoff not yet confirmed and not abandoned). Returns id, title, intent, loadBearing (critical/supporting/optional/null), setupCount (non-orphan), and derived lifecycle labels (e.g. critical_weak, needs_strengthening). Sorted by loadBearing priority then most recently updated. Note: a priority-sorted slice with derived labels is already injected into the system prompt under '### 未回収の伏線' and scene-specific labels under '### このシーンの伏線' — use this tool when you need the full list or id-based follow-up via get_foreshadow_detail.",
    inputSchema: {
      type: "object",
      properties: {},
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

  // ── 作中年表 (Chronicle) — fabula timeline of in-world events ──────────────
  {
    name: "list_events",
    description:
      "List the story-chronicle events (the in-world fabula timeline, distinct from reading order) of the current project, in chronicle order. Optionally filter by kind ('birth' | 'death' | 'generic'). Each event returns id, title, kind, ordinal, startTime (days from the in-world epoch; may be null when only the order is known), and the primary character's name. Use to answer 'when did X happen' or to survey the timeline.",
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
      "Given a chronicle event id, return its full detail: title, note, kind, ordinal, startTime/endTime, primary character, location, participant characters (names + roles), the scenes the event is stamped to (id + title), and its causal relations (cause→effect titles). Use after list_events to inspect one event.",
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
      "Given a character's Codex id, return the chronicle events that character takes part in (as primary or participant), in chronicle order, each with title, kind, startTime, and the character's age at that event when derivable (requires a birth event and a calendar). Use to answer 'how old is X now' or 'what has happened to X'.",
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
      "Return the world-state snapshot at a scene's story time: which of the relevant characters are alive/dead/unborn and their ages, the current season, the most recent events, unresolved cause→effect pairs (cause has happened, effect has not yet), and off-page background events. If sceneId is omitted, the current scene is used. Use to check temporal/seasonal/age consistency before writing. Returns structured JSON.",
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

  // ── 作中年表 (Chronicle) 書き込み — tracked-write (undo 可) ────────────────
  {
    name: "create_event",
    description:
      "Create a new chronicle event (an in-world fabula event). Requires knowledgeWrite policy. kind is 'birth', 'death', or 'generic' (default). startTime is days from the in-world epoch (optional). primaryCodexId is the home-lane character; participantCodexIds are other involved characters; sceneIds stamps the event onto scenes. Returns the new event id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        note: { type: "string", description: "Optional note" },
        kind: { type: "string", description: "'birth' | 'death' | 'generic'" },
        primaryCodexId: {
          type: "string",
          description: "Home-lane character Codex id",
        },
        locationCodexId: { type: "string", description: "Location Codex id" },
        startTime: {
          type: "number",
          description: "Days from the in-world epoch",
        },
        endTime: { type: "number", description: "Interval end (days)" },
        participantCodexIds: {
          type: "array",
          items: { type: "string" },
          description: "Participating character Codex ids",
        },
        sceneIds: {
          type: "array",
          items: { type: "string" },
          description: "Scene ids to stamp the event onto",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_event",
    description:
      "Update a chronicle event. Only the fields you pass are changed; omitted fields are left as-is (there is no way to clear a field back to null). Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Event id to update" },
        title: { type: "string" },
        note: { type: "string" },
        kind: { type: "string", description: "'birth' | 'death' | 'generic'" },
        primaryCodexId: { type: "string" },
        locationCodexId: { type: "string" },
        startTime: { type: "number" },
        endTime: { type: "number" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "delete_event",
    description:
      "Delete a chronicle event (its participants, scene stamps, and causal relations are removed too; the deletion is undoable). Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Event id to delete" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "stamp_scene_event",
    description:
      "Stamp a chronicle event onto a scene (record that the scene depicts the event). Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string", description: "Scene id" },
        eventId: { type: "string", description: "Event id" },
      },
      required: ["sceneId", "eventId"],
    },
  },
  {
    name: "unstamp_scene_event",
    description:
      "Remove the link between a scene and a chronicle event. Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string", description: "Scene id" },
        eventId: { type: "string", description: "Event id" },
      },
      required: ["sceneId", "eventId"],
    },
  },
  {
    name: "set_event_participants",
    description:
      "Replace the full set of participant characters of a chronicle event with the given Codex ids. Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Event id" },
        codexEntryIds: {
          type: "array",
          items: { type: "string" },
          description: "Participant character Codex ids (replaces the set)",
        },
      },
      required: ["eventId", "codexEntryIds"],
    },
  },
  {
    name: "add_event_relation",
    description:
      "Add a causal relation between two chronicle events (cause → effect). Self-loops are rejected. Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        causeEventId: { type: "string", description: "Cause event id" },
        effectEventId: { type: "string", description: "Effect event id" },
      },
      required: ["causeEventId", "effectEventId"],
    },
  },
  {
    name: "remove_event_relation",
    description:
      "Remove a causal relation (cause → effect) between two chronicle events. Requires knowledgeWrite policy.",
    inputSchema: {
      type: "object",
      properties: {
        causeEventId: { type: "string", description: "Cause event id" },
        effectEventId: { type: "string", description: "Effect event id" },
      },
      required: ["causeEventId", "effectEventId"],
    },
  },

  // ── サブエージェント委譲 ──────────────────────────────────────────────────
  {
    name: "run_research",
    description:
      "Delegate a focused, read-only research sub-task to a sub-agent that has its OWN fresh tool-call budget and context. The sub-agent investigates on its own and returns a concise written summary of its findings (not raw data), so a deep investigation costs you only ONE tool call instead of many. Use this for self-contained read-only investigations that would otherwise burn through your own budget — e.g. 'gather every appearance, trait, and relationship of character X across all scenes', 'survey all open foreshadowing and summarize what is still unresolved and where'. The sub-agent can ONLY read (search/list/get over Codex, scenes, foreshadowing, snippets); it CANNOT write, propose body text, ask the user, or spawn further sub-agents. Give it a clear, self-contained task and the entry/scene ids it should start from. Prefer this over making many read calls yourself for a single investigation; do NOT use it for trivial one-shot lookups.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A clear, self-contained research instruction for the sub-agent, including any starting entry/scene ids and exactly what to find and summarize.",
        },
      },
      required: ["task"],
    },
  },

  // ── ユーザーへの質問 ──────────────────────────────────────────────────────
  {
    name: "ask_user",
    description:
      "Ask the user one or more questions and WAIT for their answer before continuing. The conversation pauses; the user replies inline, and their answer is returned to you as the tool result. Use this only to resolve a genuine fork you cannot settle yourself: an ambiguous instruction, a branching creative choice (e.g. which of two plot directions), or a confirmation before a consequential action. Do NOT ask when a sensible default exists, when the answer is inferable from context, or just to seem collaborative — unnecessary questions interrupt the writer's flow. Bundle related questions into a single call (the `questions` array) rather than asking one at a time. Prefer `single`/`multi` with concrete options over open `text` when the choices are knowable.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "One or more questions to ask the user.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The question text shown to the user.",
              },
              header: {
                type: "string",
                description:
                  "Optional short label (a few words) used as the question's heading in the UI.",
              },
              kind: {
                type: "string",
                enum: ["single", "multi", "text"],
                description:
                  "Answer format: 'single' = pick one option, 'multi' = pick any number of options, 'text' = free-form text.",
              },
              options: {
                type: "array",
                items: { type: "string" },
                description:
                  "Choices for 'single'/'multi'. Required for those kinds; omit for 'text'.",
              },
              allowFreeText: {
                type: "boolean",
                description:
                  "For 'single'/'multi', also offer an 'Other' field so the user can type an answer not in the options.",
              },
            },
            required: ["question", "kind"],
          },
        },
      },
      required: ["questions"],
    },
  },
];

/** Sort object keys recursively for deterministic JSON schema. */
function sortSchemaKeys(obj: unknown): unknown {
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

/** Deterministic tool list: name order + sorted schema keys. */
export function getDeterministicAgentTools(): AgentToolDefinition[] {
  return [...AGENT_TOOLS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      ...tool,
      inputSchema: sortSchemaKeys(
        tool.inputSchema,
      ) as AgentToolDefinition["inputSchema"],
    }));
}

/** Deep-cloned session snapshot — immutable for the session lifetime. */
export function snapshotAgentTools(): AgentToolDefinition[] {
  return structuredClone(getDeterministicAgentTools());
}

/** リサーチ・サブエージェント委譲ツールの名前。chatStore が intercept する。 */
export const RESEARCH_SUBAGENT_TOOL = "run_research";

/**
 * リサーチ・サブエージェントに渡せる読み取り専用ツールの名前。
 * READ_ONLY_EXECUTORS（toolExecutors.ts）と一致していなければならず、
 * toolDefinitions.test.ts でドリフトを gate する。ここを正本にすることで
 * toolDefinitions → toolExecutors の重い import 依存（DB コード）を避ける。
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "search_codex",
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
  "search_events",
];

/**
 * リサーチ・サブエージェントに渡すツール定義（読み取り専用サブセット）。
 * run_research 自身を含まないため、子はさらにサブエージェントを起動できず、
 * 再帰深さは構造的に 1 に固定される（depth=1）。
 */
export function getResearchSubagentTools(): AgentToolDefinition[] {
  const allow = new Set(READ_ONLY_TOOL_NAMES);
  return structuredClone(
    getDeterministicAgentTools().filter((t) => allow.has(t.name)),
  );
}

/** ツール名→定義のマップ */
export const TOOL_MAP = new Map(
  getDeterministicAgentTools().map((t) => [t.name, t]),
);
