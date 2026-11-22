import type { CoreReadContext } from "../../mastraRead/ports.js";
import { listCodexTags } from "./codexTagTools.js";
import { getThreadScenes, listPlotThreads } from "./plotThreadTools.js";
import type { CoreReadExecutor } from "./toolResult.js";
import {
  getChapterSummaries,
  getScene,
  getSceneTimelineNeighbors,
  listChapters,
} from "./treeReadTools.js";

/**
 * The read tools the shared core implements (Mastra migration MP-4b). PR-4 has
 * the seven of groups B1 and B2; the other read tools move in the PRs after it.
 * A name here is a tool the renderer's executors call through the core and that
 * main will call through the same code.
 */
export const CORE_READ_TOOL_NAMES = [
  "list_codex_tags",
  "list_chapters",
  "get_chapter_summaries",
  "get_scene_timeline_neighbors",
  "list_plot_threads",
  "get_thread_scenes",
  "get_scene",
] as const;

export type CoreReadToolName = (typeof CORE_READ_TOOL_NAMES)[number];

/**
 * Builds the read executors over the ports of one caller. The renderer passes
 * live getters (its store, its `db`); main will pass the values of a turn. Making
 * the executors reads nothing from the ports: every read happens when a tool
 * runs, at the point that tool needs it.
 *
 * Every executor throws `CoreProjectRequiredError` when the tree state has no
 * project, before it reads anything; a caller that answers an empty project with
 * a result (the renderer does) catches that error.
 */
export function createReadExecutors(
  ctx: CoreReadContext,
): Readonly<Record<CoreReadToolName, CoreReadExecutor>> {
  return Object.freeze({
    list_codex_tags: (params) => listCodexTags(ctx, params),
    list_chapters: () => listChapters(ctx),
    get_chapter_summaries: () => getChapterSummaries(ctx),
    get_scene_timeline_neighbors: (params) =>
      getSceneTimelineNeighbors(ctx, params),
    list_plot_threads: () => listPlotThreads(ctx),
    get_thread_scenes: (params) => getThreadScenes(ctx, params),
    get_scene: (params) => getScene(ctx, params),
  });
}
