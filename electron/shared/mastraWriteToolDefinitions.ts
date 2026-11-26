/** Shared definitions for the 15 legacy write tools; kept byte-equivalent to the renderer golden. */
import type { AgentReadToolDefinition } from "./agentReadToolDefinitions.js";

export const MASTRA_WRITE_TOOL_NAMES = [
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
] as const;
export type MastraWriteToolName = (typeof MASTRA_WRITE_TOOL_NAMES)[number];

export interface MastraWritePort {
  execute(
    toolName: MastraWriteToolName,
    input: unknown,
    context: {
      readonly senderId: number;
      readonly projectId: string;
      readonly executionId: string;
      readonly chatMessageId: string;
      readonly toolCallId: string;
      readonly signal: AbortSignal;
    },
  ): Promise<unknown>;
}

export function createMastraWriteToolDefinitions(): AgentReadToolDefinition[] {
  return [
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
            description:
              "Optional Markdown body. The app converts and validates it before saving.",
          },
          aliases: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of alternate names",
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
          content: {
            type: "string",
            description:
              "Markdown body. The app converts and validates it before saving.",
          },
          aliases: {
            type: "array",
            items: { type: "string" },
            description: "Array of alternate names",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "create_foreshadow",
      description:
        "Create a new foreshadowing (plant/payoff) item. Requires knowledgeWrite policy.",
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
        },
        required: ["title"],
      },
    },
    {
      name: "update_foreshadow",
      description:
        "Update an existing foreshadowing item using the version returned by list_open_foreshadows or get_foreshadow_detail. Stale versions are rejected. Requires knowledgeWrite policy. Only provided fields change.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Foreshadow UUID" },
          baseVersion: {
            type: "integer",
            minimum: 0,
            description:
              "Version observed by the read that informed this update",
          },
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
        },
        required: ["id", "baseVersion"],
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
            description:
              "Optional Markdown body. The app converts and validates it before saving.",
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
    {
      name: "create_event",
      description:
        "Create a new chronicle event (an in-world fabula event). Requires knowledgeWrite policy. kind is 'birth', 'death', or 'generic' (default). startTime is required and is days from the in-world epoch; precision is required: 'exact', 'approx', or 'unknown'. startGranularity is inferred from the supplied date/time when omitted and cannot be 'none'. If the date is uncertain, provide an estimated date and express the uncertainty with precision. primaryCodexId is the home-lane character; participantCodexIds are other involved characters; sceneIds stamps the event onto scenes. Returns the new event id.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title" },
          note: { type: "string", description: "Optional note" },
          kind: {
            type: "string",
            description: "'birth' | 'death' | 'generic'",
          },
          precision: {
            type: "string",
            enum: ["exact", "approx", "unknown"],
            description: "Required confidence in the event date",
          },
          primaryCodexId: {
            type: "string",
            description: "Home-lane character Codex id",
          },
          locationCodexId: { type: "string", description: "Location Codex id" },
          startTime: {
            type: "number",
            description: "Required date in days from the in-world epoch",
          },
          endTime: { type: "number", description: "Interval end (days)" },
          startMinute: {
            type: "number",
            description:
              "Time of day for the start, in minutes (0-1439, 24h clock)",
          },
          endMinute: {
            type: "number",
            description:
              "Time of day for the end, in minutes (0-1439, 24h clock)",
          },
          startGranularity: {
            type: "string",
            enum: ["season", "year", "month", "day", "time"],
            description:
              "How precise the start date is; inferred from the supplied date/time when omitted",
          },
          endGranularity: {
            type: "string",
            description:
              "How precise the end date is: 'none' | 'season' | 'year' | 'month' | 'day' | 'time'",
          },
          revealSceneId: {
            type: "string",
            description:
              "Optional scene id where readers learn of this event; chronicle read tools mark it so earlier scenes aren't written as if readers knew. It does not hide the event. Omit or pass empty for none.",
          },
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
        required: ["title", "startTime", "precision"],
      },
    },
    {
      name: "update_event",
      description:
        "Update a chronicle event. Only the fields you pass are changed; omitted fields are left as-is. startTime cannot be cleared to null, and startGranularity cannot be 'none'. If the date is uncertain, provide an estimated date and express the uncertainty with precision. Requires knowledgeWrite policy.",
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Event id to update" },
          title: { type: "string" },
          note: { type: "string" },
          kind: {
            type: "string",
            description: "'birth' | 'death' | 'generic'",
          },
          precision: {
            type: "string",
            enum: ["exact", "approx", "unknown"],
            description: "Optional confidence in the event date",
          },
          primaryCodexId: { type: "string" },
          locationCodexId: { type: "string" },
          startTime: { type: "number" },
          endTime: { type: "number" },
          startMinute: {
            type: "number",
            description: "Start time of day in minutes (0-1439, 24h clock)",
          },
          endMinute: {
            type: "number",
            description: "End time of day in minutes (0-1439, 24h clock)",
          },
          startGranularity: {
            type: "string",
            enum: ["season", "year", "month", "day", "time"],
            description:
              "Start date precision: 'season' | 'year' | 'month' | 'day' | 'time'; 'none' is not allowed",
          },
          endGranularity: {
            type: "string",
            description:
              "End date precision: 'none' | 'season' | 'year' | 'month' | 'day' | 'time'",
          },
          revealSceneId: {
            type: "string",
            description:
              "Optional scene id where readers learn of this event; chronicle read tools mark it so earlier scenes aren't written as if readers knew. It does not hide the event. Omit to leave unchanged; pass an empty string to clear.",
          },
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
  ];
}
