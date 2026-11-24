import type {
  CoreChronicleReadContext,
  CoreChronicleSearchContext,
} from "../../mastraRead/ports.js";
import { searchEvents } from "./chronicleSearchTools.js";
import {
  getChronicleState,
  getCharacterTimeline,
  getEventDetail,
  listEvents,
} from "./chronicleTools.js";
import type { CoreReadExecutor } from "./toolResult.js";

/**
 * The chronicle read tools the shared core implements (Mastra migration MP-4b
 * PR-7a, group B6; `search_events` is `CHRONICLE_SEARCH_TOOL_NAMES` below). Their own names, own
 * context type and own factory, not part of `CORE_READ_TOOL_NAMES` and
 * `createReadExecutors`: these tools load through the chronicle loader port
 * (`CoreChronicleReadContext`) and need no database and no body reader, and a
 * module that builds their context must not have to import the renderer's `db`
 * client (DR-MP4-37). A caller that walks "every core tool" walks each table (three since PR-7b).
 */
export const CHRONICLE_READ_TOOL_NAMES = [
  "list_events",
  "get_event_detail",
  "get_character_timeline",
  "get_chronicle_state",
] as const;

export type ChronicleReadToolName = (typeof CHRONICLE_READ_TOOL_NAMES)[number];

/**
 * Builds the executors over the ports of one caller. Making them reads nothing
 * from the ports: every read happens when a tool runs. Every executor throws
 * `CoreProjectRequiredError` when the tree state has no project, before it reads
 * anything (the renderer answers it with `No active project`).
 */
export function createChronicleReadExecutors(
  ctx: CoreChronicleReadContext,
): Readonly<Record<ChronicleReadToolName, CoreReadExecutor>> {
  return Object.freeze({
    list_events: (params) => listEvents(ctx, params),
    get_event_detail: (params) => getEventDetail(ctx, params),
    get_character_timeline: (params) => getCharacterTimeline(ctx, params),
    get_chronicle_state: (params) => getChronicleState(ctx, params),
  });
}

/**
 * `search_events` (PR-7b, DR-MP4-38): a third table, with its own context type
 * (`CoreChronicleSearchContext`, which carries the project, token counter and
 * dense read) and its own factory. The three tables (`CORE_READ_TOOL_NAMES`,
 * `CHRONICLE_READ_TOOL_NAMES` and this one) share no name. A caller that walks
 * "every core tool" walks all three.
 */
export const CHRONICLE_SEARCH_TOOL_NAMES = ["search_events"] as const;

export type ChronicleSearchToolName =
  (typeof CHRONICLE_SEARCH_TOOL_NAMES)[number];

/**
 * Builds the `search_events` executor over the ports of one caller. Making it
 * reads nothing from the ports. It throws `CoreProjectRequiredError` when the
 * tree state has no project, after an empty query was answered (the renderer's
 * order), and does not catch a failure of the dense read.
 */
export function createChronicleSearchExecutors(
  ctx: CoreChronicleSearchContext,
): Readonly<Record<ChronicleSearchToolName, CoreReadExecutor>> {
  return Object.freeze({
    search_events: (params) => searchEvents(ctx, params),
  });
}
