import type { CodexEntryPhase } from "../../../db/schema.js";
import { isCodexContextModeHiddenFromAi } from "./codexVisibilityPolicy.js";
import {
  resolveCodexContexts,
  type ResolvableCodexContextEntry,
} from "./resolvedCodexContext.js";
import type {
  PhaseResolutionMode,
  SceneTimeIndex,
  TemporalAnchor,
} from "./sceneTimeIndex.js";

/**
 * Which Codex entries the AI may see, decided from rows already read (Mastra
 * migration MP-4b PR-8a, DR-MP4-39). Pure: entries, phases, the current scene
 * and the scene time index in; the hidden ids and the texts out. The renderer's
 * `resolveCodexForAi` and the read core's `resolveCodexAiVisibility` both call
 * it, so the decision is one function. Reading the rows (the entries select, the
 * phases select, the order of the two and of the store read) stays with each
 * caller.
 *
 * This file imports no store, no `invoke`, no `@/` path and nothing about the
 * chat IR. Relative `.js` imports only.
 */

/** Phase 解決後の、AI へ渡してよい Codex の文（hidden でないものだけ）。 */
export interface CodexTextForAi {
  summary: string | null;
  content: string;
  /**
   * base の mode が hidden（または不明）で、Phase 解決後は hidden でないもの。
   * true のときだけ summary・content・detailValues が Phase 解決後で、false なら base の文
   * （hidden でない項目の文は今までどおり base のまま返す）。
   */
  released: boolean;
  /** Phase 解決後の mode（解決結果が無ければ base）。 */
  mode: string;
  /**
   * released で `withDetails` のときだけ。Phase 解決後の詳細値（definitionId → 値。null は
   * Phase による消去）。base の詳細は作者が秘匿した状態の値なので、これを使う。
   */
  detailValues?: ReadonlyMap<string, string | null>;
}

/**
 * The resolution mode as a value or an explicit "could not be resolved". There is
 * no default here: `unresolved` hides every entry that is given (fail closed;
 * DR-MP4-6 item 3, DR-MP4-8). `ReadInputMode` (`core/readInputs.ts`) is
 * assignable to this (its `reason` is not read).
 */
export type CodexResolutionState =
  | { readonly kind: "resolved"; readonly mode: PhaseResolutionMode }
  | { readonly kind: "unresolved" };

export interface CodexAiVisibilityInput<
  TEntry extends ResolvableCodexContextEntry,
> {
  /** The rows the database returned. An id it did not return is hidden by the caller. */
  readonly entries: readonly TEntry[];
  /** Every phase of every entry in `entries` (the `story` fallback looks at all of an entry's phases). */
  readonly phases: readonly CodexEntryPhase[];
  /** The current scene. Empty after trimming (or null, or undefined) means the base anchor. */
  readonly sceneId: string | null | undefined;
  readonly sceneTimeIndex: SceneTimeIndex;
  readonly resolutionMode: CodexResolutionState;
}

export interface CodexAiVisibility<TEntry> {
  /** Hidden and unknown modes; with `unresolved`, every entry. */
  readonly hidden: Set<string>;
  /** The entries that are not hidden, with their text after phase resolution. */
  readonly texts: Map<string, CodexTextForAi>;
  /** Hidden at base and released by a phase (the same objects as in `entries`). */
  readonly released: TEntry[];
  /** The anchor the entries were resolved at (the caller's detail branch resolves again at it). */
  readonly anchor: TemporalAnchor;
}

/**
 * The anchor is the current scene when there is one, else base. A scene that is
 * not in the reading order resolves like base (no phase applies; DR-MP4-1 for
 * Codex), and the base anchor applies none either.
 */
function anchorOf(sceneId: string | null | undefined): TemporalAnchor {
  const trimmed = sceneId?.trim();
  return trimmed ? { kind: "scene", sceneId: trimmed } : { kind: "base" };
}

export function decideCodexAiVisibility<
  TEntry extends ResolvableCodexContextEntry,
>(input: CodexAiVisibilityInput<TEntry>): CodexAiVisibility<TEntry> {
  const hidden = new Set<string>();
  const texts = new Map<string, CodexTextForAi>();
  const released: TEntry[] = [];
  const anchor = anchorOf(input.sceneId);
  if (input.resolutionMode.kind !== "resolved") {
    for (const entry of input.entries) hidden.add(entry.id);
    return { hidden, texts, released, anchor };
  }
  const { resolvedById } = resolveCodexContexts({
    entries: input.entries,
    phases: input.phases,
    anchor,
    sceneTimeIndex: input.sceneTimeIndex,
    resolutionMode: input.resolutionMode.mode,
  });
  for (const entry of input.entries) {
    const resolved = resolvedById.get(entry.id);
    const mode = resolved?.contextMode ?? entry.contextMode;
    if (isCodexContextModeHiddenFromAi(mode)) {
      hidden.add(entry.id);
      continue;
    }
    // 置き換えは「base が hidden（または不明）で、解決後が hidden でない」項目だけ。
    const isReleased =
      resolved !== undefined &&
      isCodexContextModeHiddenFromAi(entry.contextMode);
    if (isReleased) released.push(entry);
    texts.set(entry.id, {
      summary: isReleased ? resolved.summary : entry.summary,
      content: isReleased ? resolved.content : entry.content,
      released: isReleased,
      mode,
    });
  }
  return { hidden, texts, released, anchor };
}
