import { instantEpochMilliseconds } from "../../lib/time.js";
import { toBool, toDate, toNullableDate } from "./coerce.js";
import { deriveLabel } from "./deriveLabel.js";
import { normalizeForeshadowRow } from "./normalizeForeshadowRow.js";
import {
  safeParseAiEvaluation,
  type DerivedLabel,
  type ForeshadowLoadBearing,
  type ForeshadowRow,
  type ForeshadowSetupRow,
  type ForeshadowWithLabel,
} from "./types.js";

/**
 * The read side of the foreshadow rows (Mastra migration MP-4b PR-5b): the
 * normalizers of a setup row, the label builders, the builder of the open
 * foreshadows of a chat context, and the one function that turns Native's
 * `foreshadow_list_open_for_context` answer into them. They were private to the
 * renderer's `foreshadow/api.ts`, which now imports (and re-exports) them; the
 * bodies are unchanged. Nothing here reads a database or calls Native: the
 * caller (the renderer's `readOpenForeshadowWire`, Main's typed read) fetches
 * the wire and the shared core builds the tool's answer from it.
 */

export function normalizeSetupRow(raw: unknown): ForeshadowSetupRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    foreshadowId: String(row.foreshadowId ?? row.foreshadow_id ?? ""),
    sceneId: String(row.sceneId ?? row.scene_id ?? ""),
    fromPos: Number(row.fromPos ?? row.from_pos ?? 0),
    toPos: Number(row.toPos ?? row.to_pos ?? 0),
    kind: String(
      row.kind ?? "designated_existing",
    ) as ForeshadowSetupRow["kind"],
    strength:
      (row.strength as ForeshadowSetupRow["strength"] | undefined) ?? null,
    aiStrength:
      (row.aiStrength as ForeshadowSetupRow["aiStrength"] | undefined) ??
      (row.ai_strength as ForeshadowSetupRow["aiStrength"] | undefined) ??
      null,
    aiReasoning:
      (row.aiReasoning as string | null | undefined) ??
      (row.ai_reasoning as string | null | undefined) ??
      null,
    attribution:
      (row.attribution as ForeshadowSetupRow["attribution"] | undefined) ??
      "human",
    aiRationale:
      (row.aiRationale as string | null | undefined) ??
      (row.ai_rationale as string | null | undefined) ??
      null,
    lastEvaluatedAt: toNullableDate(
      row.lastEvaluatedAt ?? row.last_evaluated_at,
    ),
    isOrphan: toBool(row.isOrphan ?? row.is_orphan),
    createdAt: toDate(row.createdAt ?? row.created_at),
    updatedAt: toDate(row.updatedAt ?? row.updated_at),
  };
}

export type SetupLabelInput = Pick<
  ForeshadowSetupRow,
  "foreshadowId" | "isOrphan" | "strength" | "aiStrength" | "aiReasoning"
> & {
  sceneId?: string;
};

export function normalizeSetupLabelInput(raw: unknown): SetupLabelInput {
  const row = normalizeSetupRow(raw);
  return {
    foreshadowId: row.foreshadowId,
    sceneId: row.sceneId,
    isOrphan: row.isOrphan,
    strength: row.strength,
    aiStrength: row.aiStrength,
    aiReasoning: row.aiReasoning,
  };
}

export function buildForeshadowsWithLabels(
  rows: ForeshadowRow[],
  setups: SetupLabelInput[],
): ForeshadowWithLabel[] {
  if (rows.length === 0) return [];

  const countMap = new Map<string, number>();
  const weakMap = new Map<string, boolean>();

  for (const s of setups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
    const evaluation = safeParseAiEvaluation(s.aiReasoning);
    const effectiveStrength =
      s.strength ?? evaluation?.careful?.strength ?? s.aiStrength;
    if (effectiveStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  return rows.map((r) => {
    const setupCount = countMap.get(r.id) ?? 0;
    const anyWeak = weakMap.get(r.id) ?? false;
    return { ...r, setupCount, label: deriveLabel(r, setupCount, anyWeak) };
  });
}

/**
 * The open foreshadows of a project for a chat context: not yet paid off, not
 * abandoned, not secret (the caller's read leaves the secret ones out), sorted
 * by `loadBearing` priority (critical > supporting > optional > none) and then
 * by `updatedAt`, newest first. A tie keeps the input order. `setupCount` does
 * not count an orphaned setup. A light shape for the bulk display: no `notes`.
 */
export interface OpenForeshadowForContext {
  id: string;
  title: string;
  intent: string | null;
  loadBearing: ForeshadowLoadBearing | null;
  version: number;
  setupCount: number;
  /** Derived lifecycle label from setup count + strength evaluation. */
  derivedLabel?: DerivedLabel;
}

export function buildOpenForeshadowsForContext(
  rows: Array<{
    id: string;
    title: string;
    intent: string | null;
    loadBearing: ForeshadowLoadBearing | null;
    version: number;
    payoffConfirmed: boolean;
    abandoned: boolean;
    updatedAt: unknown;
  }>,
  setups: SetupLabelInput[],
): OpenForeshadowForContext[] {
  if (rows.length === 0) return [];

  const labeled = buildForeshadowsWithLabels(
    rows.map(
      (r): ForeshadowRow => ({
        id: r.id,
        projectId: "",
        title: r.title,
        intent: r.intent,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: r.payoffConfirmed,
        abandoned: r.abandoned,
        secret: false,
        loadBearing: r.loadBearing,
        version: r.version,
        codexLinkDirtyAt: null,
        createdAt: new Date(),
        updatedAt: new Date(
          r.updatedAt instanceof Date ||
            typeof r.updatedAt === "string" ||
            typeof r.updatedAt === "number"
            ? (instantEpochMilliseconds(r.updatedAt) ?? Date.now())
            : Date.now(),
        ),
      }),
    ),
    setups,
  );
  const labelById = new Map(labeled.map((l) => [l.id, l.label]));

  const countMap = new Map<string, number>();
  for (const s of setups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
  }

  const priority: Record<string, number> = {
    critical: 0,
    supporting: 1,
    optional: 2,
  };
  const toMs = (v: unknown): number => {
    if (v instanceof Date || typeof v === "string" || typeof v === "number") {
      return instantEpochMilliseconds(v) ?? 0;
    }
    return 0;
  };
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      intent: r.intent,
      loadBearing: r.loadBearing,
      version: r.version,
      setupCount: countMap.get(r.id) ?? 0,
      derivedLabel: labelById.get(r.id),
      _updatedMs: toMs(r.updatedAt),
    }))
    .sort((a, b) => {
      const pa = priority[a.loadBearing ?? ""] ?? 3;
      const pb = priority[b.loadBearing ?? ""] ?? 3;
      if (pa !== pb) return pa - pb;
      return b._updatedMs - a._updatedMs;
    })
    .map(({ _updatedMs: _ms, ...rest }) => rest);
}

const OPEN_WIRE = "foreshadow_list_open_for_context";

/**
 * The open foreshadows of Native's `foreshadow_list_open_for_context` answer
 * (the `{foreshadows, setups}` wire: snake_case keys, integer 0/1 booleans,
 * epoch-millisecond times, and no `scene_id` in a setup row; the renderer's
 * in-browser branch gives the same two lists with camelCase keys, booleans and
 * `Date`s, and both are accepted).
 *
 * The answer is parsed and not narrowed when it gets here, and this decides what
 * a malformed one is. It fails closed: `foreshadows` and `setups` must both be
 * arrays (Native always sends both), a foreshadow row must be an object with a
 * string `id` and `title`, and a setup row an object with a string
 * `foreshadow_id` (or `foreshadowId`). A missing list read as an empty one would
 * turn a wire that changed shape into "0 open foreshadows" (or into a
 * `setupCount` of 0 for every item), a success the model would believe, and a
 * row that is not an object would become a phantom foreshadow with an empty id
 * and title. Whether a row is secret is the read's condition (Native's SQL, or
 * the in-browser branch's `secret = 0`); the wire has no secret column, so it
 * cannot be filtered here.
 */
export function openForeshadowsFromWire(
  wire: unknown,
): OpenForeshadowForContext[] {
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) {
    throw new Error(`${OPEN_WIRE}: the result is not an object`);
  }
  const { foreshadows, setups } = wire as {
    foreshadows?: unknown;
    setups?: unknown;
  };
  if (!Array.isArray(foreshadows)) {
    throw new Error(`${OPEN_WIRE}: foreshadows is not an array`);
  }
  if (!Array.isArray(setups)) {
    throw new Error(`${OPEN_WIRE}: setups is not an array`);
  }
  for (const row of foreshadows as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new Error(`${OPEN_WIRE}: a foreshadow row is not an object`);
    }
    const { id, title } = row as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || typeof title !== "string") {
      throw new Error(
        `${OPEN_WIRE}: a foreshadow row has no string id and title`,
      );
    }
  }
  for (const row of setups as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new Error(`${OPEN_WIRE}: a setup row is not an object`);
    }
    const record = row as Record<string, unknown>;
    if (typeof (record.foreshadowId ?? record.foreshadow_id) !== "string") {
      throw new Error(`${OPEN_WIRE}: a setup row has no string foreshadow_id`);
    }
  }
  return buildOpenForeshadowsForContext(
    (foreshadows as unknown[]).map(normalizeForeshadowRow),
    (setups as unknown[]).map(normalizeSetupLabelInput),
  );
}
