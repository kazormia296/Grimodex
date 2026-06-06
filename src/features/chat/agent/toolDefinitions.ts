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

/** ツール名→定義のマップ */
export const TOOL_MAP = new Map(
  getDeterministicAgentTools().map((t) => [t.name, t]),
);
