import {
  assertCoreProjectId,
  type CoreCodexVisibilityPorts,
} from "../../mastraRead/ports.js";
import type { CodexEntryPhase } from "../db/schema.js";
import {
  decideCodexAiVisibility,
  type CodexTextForAi,
} from "../features/codex/context/codexAiVisibility.js";
import { readCodexVisibilityEntries } from "./codexReaders.js";

/**
 * Which Codex entries the AI may see, over the read core's ports (Mastra
 * migration MP-4b PR-8a, DR-MP4-39). The asynchronous entry of
 * `decideCodexAiVisibility`: it reads the entries and the phases through the
 * ports, in the order of the renderer's `resolveCodexForAi`, and hands them to the
 * same pure function. Nothing calls it from a tool yet (the four Codex tools move
 * in PR-8b) and Main does not call it (flag L is closed).
 *
 * The order of the awaits is the renderer's: the entries select, then the phases,
 * and only after that the phase state (`getPhaseState()`), so the state is the
 * one at the end of the reads. The caller reads the current scene after it has
 * made its own result and passes it in.
 *
 * Nothing is cached: every call reads the entries and the phases again, as the
 * renderer does. A decision held for a turn would show a Codex entry that the
 * author turned hidden in the middle of the turn (Q5 (f); DR-MP4-39).
 *
 * A failure of a port is not caught: the tool fails, and nothing reaches the AI.
 */

/** Ids per statement (the SQLite variable limit; the same as `sceneBody.ts`). */
const ID_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) {
    out.push(values.slice(i, i + ID_CHUNK));
  }
  return out;
}

export interface CodexAiVisibilityRequest {
  readonly projectId: string;
  readonly entryIds: readonly string[];
  /** The current scene (empty after trimming, null or undefined: the base anchor). */
  readonly sceneId: string | null | undefined;
  /** Read the body too (the entries select carries `content`). */
  readonly withContent?: boolean;
}

export interface CodexAiVisibilityResult {
  /** Hidden, unknown modes, and ids the project has no entry for. */
  readonly hidden: Set<string>;
  /** The entries that are not hidden, with their text after phase resolution. */
  readonly texts: Map<string, CodexTextForAi>;
}

/**
 * The project is required (`CoreProjectRequiredError`): an empty one would drop
 * the project condition. An id the project has no entry for is hidden (fail
 * closed), as the renderer's decision does. When the phase state names a project
 * and it is not the one asked about, this throws: it is another project's reading
 * order and mode.
 */
export async function resolveCodexAiVisibility(
  deps: CoreCodexVisibilityPorts,
  request: CodexAiVisibilityRequest,
): Promise<CodexAiVisibilityResult> {
  assertCoreProjectId(request.projectId);
  const ids = [...new Set(request.entryIds)];
  const hidden = new Set<string>();
  const texts = new Map<string, CodexTextForAi>();
  if (ids.length === 0) return { hidden, texts };

  const found = new Set<string>();
  const entries: Array<{
    id: string;
    summary: string | null;
    contextMode: string;
    content: string;
  }> = [];
  for (const chunk of chunks(ids)) {
    const rows = await readCodexVisibilityEntries(
      deps.getDb(),
      request.projectId,
      chunk,
      request.withContent === true,
    );
    for (const row of rows) {
      found.add(row.id);
      entries.push({
        id: row.id,
        summary: row.summary,
        contextMode: row.contextMode,
        content: "content" in row ? (row.content ?? "") : "",
      });
    }
  }
  for (const id of ids) if (!found.has(id)) hidden.add(id);
  if (entries.length === 0) return { hidden, texts };

  const phases: CodexEntryPhase[] = [];
  for (const chunk of chunks(entries.map((entry) => entry.id))) {
    phases.push(...(await deps.codex.listPhases(chunk)));
  }
  const state = deps.getPhaseState();
  if (state.projectId !== undefined && state.projectId !== request.projectId) {
    throw new Error(
      "read core: the phase state belongs to a different project than the one asked about",
    );
  }
  const decision = decideCodexAiVisibility({
    entries,
    phases,
    sceneId: request.sceneId,
    sceneTimeIndex: state.sceneTimeIndex,
    resolutionMode: state.resolutionMode,
  });
  for (const id of decision.hidden) hidden.add(id);
  for (const [id, text] of decision.texts) texts.set(id, text);
  return { hidden, texts };
}

/**
 * The hidden ids among `entryIds` (the same decision as `resolveCodexAiVisibility`).
 * The contract of the hidden-id port the chronicle tools will use (DR-MP4-39):
 * the scene is the caller's current scene and not a model argument, nothing is
 * cached, an id the project has no entry for is in the set (it is not told apart
 * from a hidden one), and a failure is thrown.
 */
export async function listHiddenCodexIds(
  deps: CoreCodexVisibilityPorts,
  request: Omit<CodexAiVisibilityRequest, "withContent">,
): Promise<ReadonlySet<string>> {
  return (await resolveCodexAiVisibility(deps, request)).hidden;
}

/**
 * `resolveCodexAiVisibility` over `rows`: hidden rows are dropped and the order is
 * kept. A row that has a `summary` and was released by a phase (hidden at base)
 * gets the summary after phase resolution, so it does not carry the base text the
 * author hid. Nothing is read for an empty list.
 */
export async function dropHiddenCodexRows<T extends { id: string }>(
  deps: CoreCodexVisibilityPorts,
  rows: readonly T[],
  options: {
    readonly projectId: string;
    readonly sceneId: string | null | undefined;
  },
): Promise<T[]> {
  if (rows.length === 0) return [];
  const { hidden, texts } = await resolveCodexAiVisibility(deps, {
    entryIds: rows.map((row) => row.id),
    projectId: options.projectId,
    sceneId: options.sceneId,
  });
  const out: T[] = [];
  for (const row of rows) {
    if (hidden.has(row.id)) continue;
    const text = texts.get(row.id);
    out.push(
      text?.released && "summary" in row
        ? { ...row, summary: text.summary }
        : row,
    );
  }
  return out;
}
