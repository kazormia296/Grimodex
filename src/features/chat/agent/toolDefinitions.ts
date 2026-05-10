import type { AgentToolDefinition } from "./agentTypes";

/** エージェントが使用できる全ツール定義 */
export const AGENT_TOOLS: AgentToolDefinition[] = [
  // ── Codex系 ──────────────────────────────────────────────────────────────
  {
    name: "search_codex",
    description:
      "Search Codex entries by keyword across name, aliases, summary, and tags. Note: entries mentioned in the current scene and entries spotlighted by the user are already injected into the system prompt with their summaries (and their UUIDs as `id: ...` lines, plus aliases) — use this tool to discover entries that are NOT already injected. Returns id, name, type, and summary (no full content). Whitespace-separated tokens are treated as OR (any match), so a multi-word query is fine.",
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
];

/** ツール名→定義のマップ */
export const TOOL_MAP = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
