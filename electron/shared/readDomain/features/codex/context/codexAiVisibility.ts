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
  /**
   * The current scene. Empty after trimming (or null, or undefined) means the base
   * anchor, and the scene cannot be resolved: an entry that one of its phases
   * hides is hidden (DR-MP4-41). Same for an id the reading order does not have.
   */
  readonly sceneId: string | null | undefined;
  readonly sceneTimeIndex: SceneTimeIndex;
  readonly resolutionMode: CodexResolutionState;
}

export interface CodexAiVisibility<TEntry> {
  /**
   * Hidden and unknown modes; with `unresolved`, every entry. When the scene
   * cannot be resolved (no scene, or an id the reading order does not have), also
   * every entry that has a phase one of which hides it (DR-MP4-41). An entry that
   * has a hiding phase whose anchor scene the resolver cannot place (null, deleted,
   * archived) is hidden whatever the scene is (DR-MP4-46).
   */
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
 * Codex), and the base anchor applies none either. `decideCodexAiVisibility`
 * does not leave it at that for the visibility decision (DR-MP4-41, below):
 * neither "no scene" nor an unknown scene is read as "public".
 */
function anchorOf(sceneId: string | null | undefined): TemporalAnchor {
  const trimmed = sceneId?.trim();
  return trimmed ? { kind: "scene", sceneId: trimmed } : { kind: "base" };
}

/**
 * The scene cannot be resolved (DR-MP4-41): no phase can be applied for it. Two
 * cases, both fail closed below:
 * - A scene id was given (non-empty after trimming) but the reading order does
 *   not have it. The id is archived, in the trash or deleted, the index was just
 *   reset, the id is another project's, or it is a note or a folder: selecting a
 *   note or a folder in the tree makes `activeSceneId` that id (the most common
 *   case in practice; agent tools and the inline AI then see it).
 * - No scene (null, undefined, empty, whitespace; Q1 of the 2026-11-23
 *   decision). The base anchor applies no phase either. This is the case of the
 *   inline AI while a Codex entry, a snippet or a chronicle event is edited,
 *   `codexYomi`, and the agent tools (right after start-up, or a project with no
 *   scene). Beats and foreshadowing need a scene id, so they reach this only as
 *   the first case (a scene that the reading order does not have).
 * `anchorOf` still reads "no scene" as the base anchor (unchanged); only the
 * visibility decision treats it as unresolvable.
 *
 * The scene id of a `scene` anchor is compared as it is (the resolver does not
 * trim it either): `anchorOf` trims before it builds the anchor, and a caller
 * that builds the anchor itself gets the resolver's reading of the id.
 * `latest` (every phase applied, whatever the scene) and `phase` (a preview of
 * one phase) do not depend on a current scene and are not unresolvable here.
 */
function isAnchorUnresolvable(
  anchor: TemporalAnchor,
  index: SceneTimeIndex,
): boolean {
  switch (anchor.kind) {
    case "base":
      return true;
    case "scene":
      return !index.readingOrder.has(anchor.sceneId);
    case "latest":
    case "phase":
      return false;
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}

/**
 * DR-MP4-41 (fail closed): when the scene cannot be resolved, an entry that one
 * of its phases would hide is hidden. The phases were not applied, so base alone
 * must not be taken as "public" for it. An entry with no phase, or whose phases
 * hide nothing, is unchanged; an entry that is hidden at base stays hidden. A
 * phase whose anchor scene no longer exists (dangling) counts like any other:
 * which phases would apply cannot be told, so it errs on the hiding side.
 * (This reads no anchor. The other half, a hiding phase that lost its anchor while
 * the scene can be resolved, is `listEntryIdsWithOrphanedHiddenPhase`, DR-MP4-46.)
 */
function hasPhaseHiddenFromAi(
  phases: readonly CodexEntryPhase[] | undefined,
): boolean {
  return (
    phases?.some(
      (phase) =>
        phase.contextModeOverride !== null &&
        isCodexContextModeHiddenFromAi(phase.contextModeOverride),
    ) ?? false
  );
}

/**
 * The ids of the entries that are closed because the scene cannot be resolved
 * (DR-MP4-41): the entries one of whose phases hides them. Empty when the anchor
 * can be resolved. It is the DR-MP4-41 half of `listEntryIdsClosedForAi`, which
 * `decideCodexAiVisibility` and the chat context sources ask (DR-MP4-46), so the
 * rule is written once. An entry that is already
 * hidden at base may also be named here (closing it changes nothing); do not read
 * this set as "the entries the unresolvable scene is the reason for". A hiding
 * phase that lost its anchor while the scene can be resolved is not named here;
 * see `listEntryIdsWithOrphanedHiddenPhase` and `listEntryIdsClosedForAi`.
 */
export function listEntryIdsClosedWhenSceneUnresolvable(input: {
  readonly anchor: TemporalAnchor;
  readonly sceneTimeIndex: SceneTimeIndex;
  readonly phasesByEntry: ReadonlyMap<string, readonly CodexEntryPhase[]>;
}): Set<string> {
  const closed = new Set<string>();
  if (!isAnchorUnresolvable(input.anchor, input.sceneTimeIndex)) return closed;
  for (const [entryId, phases] of input.phasesByEntry) {
    if (hasPhaseHiddenFromAi(phases)) closed.add(entryId);
  }
  return closed;
}

/**
 * DR-MP4-46: a Phase that the resolver cannot place. Its anchor scene is null (the
 * anchor was deleted: the foreign key sets it to null; or it never had one), or
 * the reading order does not have it (archived, a folder above it is archived,
 * another project's id, the index was just reset). `resolveApplicablePhases`
 * (`validRankedPhases`) skips exactly these Phases for every anchor kind, so such a
 * Phase never applies. Same condition as there; a test pins the two together
 * (`skippedPhaseIds`). The resolver is not changed.
 */
export function isPhaseAnchorOrphaned(
  phase: Pick<CodexEntryPhase, "anchorNodeId">,
  index: SceneTimeIndex,
): boolean {
  return (
    phase.anchorNodeId === null || !index.readingOrder.has(phase.anchorNodeId)
  );
}

/**
 * Why a Phase cannot be placed: its anchor scene is null (deleted, or never set;
 * restoring the scene does not bring the anchor back), or it is set but the
 * reading order does not have it (archived, a folder above it is archived,
 * another project's id, the index was just reset).
 */
export type OrphanedPhaseCause = "anchor-null" | "anchor-not-in-reading-order";

/** A Phase that hides its entry from the AI and that the resolver cannot place. */
export interface OrphanedHidingPhase {
  readonly id: string;
  readonly label: string;
  /** The Phase's `contextModeOverride` (hidden, or a mode that is not known). */
  readonly mode: string;
  readonly cause: OrphanedPhaseCause;
}

/**
 * DR-MP4-46 (fail closed): the Phases that hide their entry from the AI (hidden,
 * or an unknown mode) and whose anchor the resolver cannot place
 * (`isPhaseAnchorOrphaned`), with the reason. It is the single source of "a hiding
 * Phase lost its anchor": `listEntryIdsWithOrphanedHiddenPhase` (the rule that
 * closes the entry) and every screen that tells the author about it are derived
 * from this function, so what is shown and what is excluded cannot drift apart.
 * A Phase that does not hide (suppress, mentioned, always, text only) is not named,
 * nor is a hiding Phase whose anchor the resolver can place.
 */
export function listOrphanedHidingPhases(
  phases: readonly Pick<
    CodexEntryPhase,
    "id" | "label" | "anchorNodeId" | "contextModeOverride"
  >[],
  index: SceneTimeIndex,
): OrphanedHidingPhase[] {
  const out: OrphanedHidingPhase[] = [];
  for (const phase of phases) {
    const mode = phase.contextModeOverride;
    if (mode === null || !isCodexContextModeHiddenFromAi(mode)) continue;
    if (!isPhaseAnchorOrphaned(phase, index)) continue;
    out.push({
      id: phase.id,
      label: phase.label,
      mode,
      cause:
        phase.anchorNodeId === null
          ? "anchor-null"
          : "anchor-not-in-reading-order",
    });
  }
  return out;
}

/**
 * Whether the orphaned hiding Phases (`listOrphanedHidingPhases`) are what keeps the
 * entry from the AI, which is what a screen may say "because of this Phase". False
 * when the entry stays closed without them: its base mode is hidden (or unknown)
 * and no Phase the resolver can place carries a mode that is not hidden, so
 * nothing could release it. `decideCodexAiVisibility` closes an entry that has an
 * orphaned hiding Phase before it looks at a release (`closedIds` first, then
 * `isReleased`), so a hidden base with a placeable public Phase (always, mentioned,
 * suppress) IS closed by the orphan rule: this returns true for it. Conservative on
 * one side: a placeable public Phase that a later placeable hiding Phase on the same
 * anchor shadows still counts as one that could release.
 */
export function isEntryClosedByOrphanedHidingPhase(input: {
  readonly entryContextMode: string;
  readonly phases: readonly Pick<
    CodexEntryPhase,
    "id" | "label" | "anchorNodeId" | "contextModeOverride"
  >[];
  readonly index: SceneTimeIndex;
}): boolean {
  if (listOrphanedHidingPhases(input.phases, input.index).length === 0) {
    return false;
  }
  if (!isCodexContextModeHiddenFromAi(input.entryContextMode)) return true;
  return input.phases.some(
    (phase) =>
      !isPhaseAnchorOrphaned(phase, input.index) &&
      phase.contextModeOverride !== null &&
      !isCodexContextModeHiddenFromAi(phase.contextModeOverride),
  );
}

/**
 * DR-MP4-46 (fail closed): the ids of the entries that have a Phase which hides
 * them (hidden, or an unknown mode) and whose anchor the resolver cannot place
 * (`listOrphanedHidingPhases`). That Phase is skipped, so even where the current
 * scene can be resolved base alone would be read as "public". Whatever the anchor
 * kind and mode, and whether or not the current scene can be resolved. A Phase
 * that does not hide (suppress, mentioned, always, text only) is not named, and an
 * entry whose hiding Phases all have a placeable anchor is not named (the resolver
 * applies those).
 */
export function listEntryIdsWithOrphanedHiddenPhase(input: {
  readonly sceneTimeIndex: SceneTimeIndex;
  readonly phasesByEntry: ReadonlyMap<string, readonly CodexEntryPhase[]>;
}): Set<string> {
  const closed = new Set<string>();
  for (const [entryId, phases] of input.phasesByEntry) {
    if (listOrphanedHidingPhases(phases, input.sceneTimeIndex).length > 0) {
      closed.add(entryId);
    }
  }
  return closed;
}

/**
 * Every entry that is closed to the AI by a Phase rule: the union of
 * `listEntryIdsClosedWhenSceneUnresolvable` (DR-MP4-41: the current scene cannot
 * be resolved) and `listEntryIdsWithOrphanedHiddenPhase` (DR-MP4-46: a hiding
 * Phase lost its anchor scene). `decideCodexAiVisibility` and both chat context
 * sources ask this one function. The codex scope's `latest` is included in the
 * second rule (the user's answer Q-G1 of 2026-11-23): `latest` applies every
 * Phase the resolver can place, but never an orphaned one.
 */
export function listEntryIdsClosedForAi(input: {
  readonly anchor: TemporalAnchor;
  readonly sceneTimeIndex: SceneTimeIndex;
  readonly phasesByEntry: ReadonlyMap<string, readonly CodexEntryPhase[]>;
}): Set<string> {
  const closed = listEntryIdsClosedWhenSceneUnresolvable(input);
  for (const entryId of listEntryIdsWithOrphanedHiddenPhase(input)) {
    closed.add(entryId);
  }
  return closed;
}

/**
 * Hides the entries that `closedIds` names (`listEntryIdsClosedForAi`: the scene
 * cannot be resolved, DR-MP4-41, or a hiding phase lost its anchor, DR-MP4-46) by
 * replacing their resolved `contextMode` with `hidden` (a copy; the input map is
 * not changed). The name says "unresolvable scene" for the first reason only; it is
 * kept so that the callers' diff stays small. Only the mode is replaced: every
 * consumer reads the mode before it reads a summary, a body or a detail value, so
 * the rest stays as resolved and is never shown.
 */
export function closeResolvedCodexForUnresolvableScene<
  TResolved extends { readonly contextMode: string },
>(
  resolvedById: ReadonlyMap<string, TResolved>,
  closedIds: ReadonlySet<string>,
): Map<string, TResolved> {
  const closed = new Map<string, TResolved>();
  for (const [entryId, resolved] of resolvedById) {
    closed.set(
      entryId,
      closedIds.has(entryId)
        ? { ...resolved, contextMode: "hidden" }
        : resolved,
    );
  }
  return closed;
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
  const { resolvedById, phasesByEntry } = resolveCodexContexts({
    entries: input.entries,
    phases: input.phases,
    anchor,
    sceneTimeIndex: input.sceneTimeIndex,
    resolutionMode: input.resolutionMode.mode,
  });
  const closedIds = listEntryIdsClosedForAi({
    anchor,
    sceneTimeIndex: input.sceneTimeIndex,
    phasesByEntry,
  });
  for (const entry of input.entries) {
    if (closedIds.has(entry.id)) {
      hidden.add(entry.id);
      continue;
    }
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
