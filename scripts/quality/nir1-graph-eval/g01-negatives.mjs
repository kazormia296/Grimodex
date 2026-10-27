/* global window */
// CP-4 S5-B: K24-G01-N2〜N4 の段（DR-CP4-O-1 (5)、G-01 の addendum の
// diagnosticNegatives）。測定の loop（samplePlan の 3 arm、AB/BA）と K2/4 の
// 宣言の段は A の正式の runner に置き、この module はその runner が呼ぶ段を持つ:
//   1. `prepareG01NegativeBeforeDeclaration`（宣言より前）: N3 は宣言の時点と
//      同じ bytes の本文版、N4 は「 Draft.」を足した本文の版と元の本文の再保存。
//   2. `runG01NegativeControl`（宣言の段の直後、mutation の前）: 同じ workspace
//      と seed の製品の fetch で、Graph-only の行が宣言の Scene・pin の Entity が
//      対象・seed からの edge を持つこと（DR-CP4-O-6 の対照）。
//   3. `runG01NegativeStep`（対照の後、V-10 の probe と warm-up の前）: N2 は
//      同じ本文の再保存、N3／N4 は Scene の本文版の restore（project の snapshot
//      の restore は使わない）。その後に測定の Main を閉じて同じ workspace で
//      開き直し（`reopenUntilSealed`。setup の seal の session と同じ上限）、
//      B の新しい封印と Chronicle を待ち（届かなければ blocked）、SP/1 の SP-P1
//      を DB から照合し直す。N4 の宣言の前の保存の後も同じ開き直しで待つ。
//   4. 測った sample の「届いた」は `g01FrameReached`、結果は
//      `frozen-diagnostics.mjs` の `assessG01Negative`。
// 測定の Main は B-ROUTE の journey seam で起動する（`g01NegativeLaunchEnv`）。
// 書込みは製品の writer だけ（renderer/cp4-diagnostic-probe.ts）。

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { G01_N4_DRAFT_SUFFIX, G01_NEGATIVES } from "./frozen-diagnostics.mjs";
import {
  B_SEAL_REOPENS,
  B_SEAL_WAIT_MS,
  indexStateProbe,
} from "./frozen-setup-driver.mjs";
import { verifySeedPins } from "./seed-pin.mjs";
import { traceMaintenanceEnv } from "./trace-record.mjs";

/** The poll interval of the wait (the setup's B seal wait polls every 500 ms). */
export const G01_NEGATIVE_POLL_MS = 500;

function fail(detail) {
  throw new Error(`[precheck] S5-B g01-negative: ${detail}`);
}

function specOf(id) {
  if (!Object.hasOwn(G01_NEGATIVES, id))
    fail(`${String(id)} is not K24-G01-N2〜N4`);
  return G01_NEGATIVES[id];
}

/**
 * The measurement Main's env of a negative (the addendum's
 * `measurementProcess`): the B-ROUTE journey seam on top of the launch env
 * (CI, owner token, a fresh nonce, the nir1-graph-index-build trigger).
 */
export function g01NegativeLaunchEnv({ nonce, base }) {
  return traceMaintenanceEnv({ nonce, base });
}

const pageCall = (page, entry, input) =>
  page.evaluate(
    ([name, value]) => window.cp4Harness.diagnostic[name](value),
    [entry, input],
  );

const sceneOf = (ids, target) => {
  const runtime = ids?.scenes?.[target.sceneId];
  if (typeof runtime !== "string")
    fail(`the setup maps no runtime Scene to ${target.sceneId}`);
  return runtime;
};

/**
 * Before the declaration: the body version the negative restores later.
 * Returns `{ prepared }` or `{ blocked }` (the step cannot be prepared; the
 * diagnostic is recorded as blocked, never counted).
 */
export async function prepareG01NegativeBeforeDeclaration({
  id,
  page,
  ids,
  target,
}) {
  const spec = specOf(id);
  const scene = { projectId: ids.projectId, sceneId: sceneOf(ids, target) };
  if (spec.beforeDeclaration === null) return { prepared: null, blocked: null };
  if (spec.beforeDeclaration === "same-bytes-version") {
    const result = await pageCall(page, "sameBytesVersion", scene);
    if (!result?.ok)
      return {
        prepared: null,
        blocked: { reason: "before-declaration", error: result?.error ?? null },
      };
    return {
      prepared: { kind: spec.beforeDeclaration, ...result.value },
      blocked: null,
    };
  }
  const result = await pageCall(page, "draftThenOriginal", {
    ...scene,
    suffix: G01_N4_DRAFT_SUFFIX,
  });
  if (!result?.ok)
    return {
      prepared: null,
      blocked: { reason: "before-declaration", error: result?.error ?? null },
    };
  const value = result.value;
  // The declared body stays the fixture's; the draft version differs.
  if (
    value.afterSha256 !== value.originalSha256 ||
    value.draftSha256 === value.originalSha256
  )
    return {
      prepared: null,
      blocked: {
        reason: "before-declaration",
        error: "the draft or the original body did not hold",
        value,
      },
    };
  return {
    prepared: { kind: spec.beforeDeclaration, ...value },
    blocked: null,
  };
}

/**
 * The wait after the mutation (the setup's B seal rule): a B generation newer
 * than the one before the mutation, not dirty, and a usable Chronicle Index
 * (`indexStateProbe`), within `limitMs` (B_SEAL_WAIT_MS).
 */
export async function waitG01NegativeSealed({
  readIndex,
  before,
  limitMs = B_SEAL_WAIT_MS,
  sleep = delay,
  now = () => Date.now(),
}) {
  const started = now();
  const previous = Number(before?.b?.generation ?? 0);
  for (;;) {
    const metadata = readIndex();
    const probe = indexStateProbe({ metadata });
    if (
      Number(metadata?.b?.generation ?? 0) > previous &&
      probe.graph === "usable" &&
      probe.chronicle === "usable"
    )
      return { ok: true, waitedMs: now() - started, metadata };
    if (now() - started >= limitMs)
      return { ok: false, waitedMs: now() - started, metadata };
    await sleep(G01_NEGATIVE_POLL_MS);
  }
}

/**
 * SP/1 SP-P1 again after the mutation: the query Scene's only pin is the
 * planned seed (read from the workspace DB).
 */
export function recheckG01SpP1({ ids, target, read }) {
  const [row] = verifySeedPins([
    {
      caseId: "G-01",
      variantId: "v1",
      querySceneId: ids.scenes[target.querySceneId],
      expectedSeed: ids.entities[target.seedEntityId],
      expectedSeedLogical: target.seedEntityId,
      entityRuntimeIds: ids.entities,
      read,
    },
  ]).rows;
  return {
    status: row.status,
    productSeed: row.productSeed,
    pinCount: row.pinCount,
  };
}

/**
 * The Graph's relational input of the workspace (Codex entries, Relations,
 * pins; ids only): equal between the control and the measurement means the
 * mutation (a body write) did not change what the frame traverses.
 */
export function graphInputsDigest(rows) {
  const pick = {
    codexEntries: rows?.codexEntries ?? null,
    codexRelations: rows?.codexRelations ?? null,
    pins: rows?.pins ?? null,
  };
  return createHash("sha256").update(JSON.stringify(pick)).digest("hex");
}

/** The control's attempts (D′: a late first answer, then the cached one). */
export const G01_CONTROL_ATTEMPTS = 5;
/** Longer than the owner's rebuild_min_interval (1 s), a harness value. */
export const G01_CONTROL_GAP_MS = 1_200;

/**
 * DR-CP4-O-6: the control's verdict on one product answer — `reached` when
 * the Graph answer is graph-ready and its Graph-only row is the declared
 * Scene, pinned to the target Entity, through an edge from the seed to the
 * target Entity; `not-reached` when graph-ready without that path;
 * `undetermined` otherwise (late, unavailable, failed).
 */
export function classifyG01Control({ answer, ids, target }) {
  if (answer?.graphOutcome !== "graph-ready") return "undetermined";
  const scene = ids.scenes?.[target.sceneId];
  const entity = ids.entities?.[target.entityId];
  const seed = ids.entities?.[target.seedEntityId];
  const row = answer.graphOnly;
  const reached =
    row?.sceneId === scene &&
    row?.pinEntityId === entity &&
    (row?.edges ?? []).some((edge) => edge.from === seed && edge.to === entity);
  return reached ? "reached" : "not-reached";
}

/**
 * The control (after the declaration, before the mutation, same workspace
 * and seed): up to G01_CONTROL_ATTEMPTS product fetches until one is
 * graph-ready; records every answer and the Graph input digest.
 */
export async function runG01NegativeControl({
  page,
  ids,
  target,
  readGraphInputs,
  sleep = delay,
  attempts = G01_CONTROL_ATTEMPTS,
}) {
  const answers = [];
  let status = "undetermined";
  for (let at = 0; at < attempts; at++) {
    const result = await pageCall(page, "graphProbe", {
      sceneId: ids.scenes[target.querySceneId],
      seed: ids.entities[target.seedEntityId],
    });
    const answer = result?.ok ? result.value : { error: result?.error ?? null };
    answers.push(answer);
    status = classifyG01Control({ answer, ids, target });
    if (answer.graphOutcome === "graph-ready") break;
    await sleep(G01_CONTROL_GAP_MS);
  }
  return { status, answers, graphInputs: graphInputsDigest(readGraphInputs()) };
}

/**
 * DR-CP4-O-3 (7): after the mutation the measurement Main is closed and
 * reopened on the same workspace with the B-ROUTE seam (its wake runs the
 * gated B build), at most 1 + B_SEAL_REOPENS openings (the setup's seal
 * session rule), each waiting B_SEAL_WAIT_MS for a new sealed generation.
 * `openSession({ attempt, dirLabel })` returns a session with `close()`;
 * the records have the setup receipt's `sealAttempts` fields.
 */
export async function reopenUntilSealed({
  closeCurrent,
  openSession,
  readIndex,
  before,
  reopens = B_SEAL_REOPENS,
  wait = waitG01NegativeSealed,
  label = "measure",
}) {
  await closeCurrent();
  const sealAttempts = [];
  for (let attempt = 0; attempt <= reopens; attempt++) {
    const dirLabel = `${label}-reopen-${attempt}`;
    const session = await openSession({ attempt, dirLabel });
    const sealed = await wait({ readIndex, before });
    sealAttempts.push({
      session: label,
      attempt,
      dirLabel,
      outcome: sealed.ok ? "sealed" : "not-published",
      published: sealed.ok,
      waitedMs: sealed.waitedMs,
      metadata: sealed.metadata ?? null,
    });
    if (sealed.ok) return { ok: true, session, sealAttempts };
    await session.close();
  }
  return { ok: false, session: null, sealAttempts };
}

/**
 * After the declaration step (and the control), before the V-10 probe: the
 * mutation, the reopening of the Main until B is sealed again, SP-P1 again
 * and the Graph input digest. Returns the step record and the open session
 * (null when blocked); `blocked` is set when the mutation path is
 * unavailable or B was not sealed within the openings (never counted).
 */
export async function runG01NegativeStep({
  id,
  page,
  ids,
  target,
  before,
  readIndex,
  readPins,
  readGraphInputs,
  closeCurrent,
  openSession,
  reopen = reopenUntilSealed,
}) {
  const spec = specOf(id);
  const scene = { projectId: ids.projectId, sceneId: sceneOf(ids, target) };
  const indexBefore = readIndex();
  let mutation;
  if (spec.mutation === "resave-same-body") {
    const result = await pageCall(page, "resaveBody", scene);
    if (!result?.ok || result.value.after.sha256 !== result.value.before.sha256)
      return {
        id,
        mutation: result ?? null,
        session: null,
        blocked: {
          reason: "mutation",
          error: result?.error ?? "the body changed",
        },
      };
    mutation = result.value;
  } else {
    if (!before?.revisionId)
      return {
        id,
        mutation: null,
        session: null,
        blocked: { reason: "mutation", error: "no prepared body version" },
      };
    const result = await pageCall(page, "restoreVersion", {
      ...scene,
      revisionId: before.revisionId,
    });
    const expected =
      spec.mutation === "restore-same-bytes-body-version"
        ? before.sha256
        : before.draftSha256;
    if (
      !result?.ok ||
      result.value.restoredSha256 !== expected ||
      result.value.afterSha256 !== expected
    )
      return {
        id,
        mutation: result ?? null,
        session: null,
        blocked: {
          reason: "mutation",
          error:
            result?.error ?? "the restored body is not the prepared version",
        },
      };
    mutation = result.value;
  }
  const reopened = await reopen({
    closeCurrent,
    openSession,
    readIndex,
    before: indexBefore,
  });
  if (!reopened.ok)
    return {
      id,
      mutation,
      indexBefore,
      sealAttempts: reopened.sealAttempts,
      session: null,
      blocked: {
        reason: "b-seal-not-published",
        openings: reopened.sealAttempts.length,
      },
    };
  const spP1Recheck = recheckG01SpP1({ ids, target, read: readPins() });
  return {
    id,
    mutation,
    indexBefore,
    sealAttempts: reopened.sealAttempts,
    session: reopened.session,
    spP1Recheck,
    graphInputs: graphInputsDigest(readGraphInputs()),
    blocked: null,
  };
}

const graphOutcomeOf = (value) =>
  typeof value === "string" && value.startsWith("graph-unavailable")
    ? "graph-unavailable"
    : (value ?? null);

/**
 * DR-CP4-O-6: whether one measured sample's Graph frame reached the target
 * Entity — true when the control reached it, the Graph input is the
 * control's, the sample requested the Graph with the seed, its answer (the
 * parent, or the follow-up child) is graph-ready and A3 found the expected
 * material eligible at the query's start; false when the seed differs, the
 * answer is graph-unavailable or A3 is not eligible; null (undetermined)
 * otherwise.
 */
export function g01FrameReached({ row, ids, target, control, inputsDigest }) {
  if (control?.status !== "reached" || inputsDigest !== control.graphInputs)
    return null;
  const seed = row.followUp?.parent?.seed ?? row.seed ?? null;
  if (seed !== ids.entities?.[target.seedEntityId]) return false;
  const outcomes = [row.graph?.outcome, row.followUp?.child?.outcome].map(
    graphOutcomeOf,
  );
  if (outcomes.includes("graph-ready")) {
    if (row.a3AtStart?.eligible === true) return true;
    if (row.a3AtStart?.eligible === false) return false;
    return null;
  }
  if (outcomes.includes("graph-unavailable")) return false;
  return null;
}

/**
 * One measured Graph-arm sample of a negative in logical IDs (the formal
 * runner's sample row): the parent's seed, whether the frame reached the
 * target Entity (`g01FrameReached`), the returned Scenes.
 */
export function g01NegativeSampleOf({
  row,
  ids,
  target = null,
  control = null,
  inputsDigest = null,
}) {
  const inverse = new Map(
    Object.entries(ids.scenes ?? {}).map(([logical, runtime]) => [
      runtime,
      logical,
    ]),
  );
  const entities = new Map(
    Object.entries(ids.entities ?? {}).map(([logical, runtime]) => [
      runtime,
      logical,
    ]),
  );
  return {
    phase: row.phase,
    repeat: row.repeat,
    arm: row.arm,
    seedRequested: entities.get(row.followUp?.parent?.seed ?? row.seed) ?? null,
    frameReached: target
      ? g01FrameReached({ row, ids, target, control, inputsDigest })
      : null,
    returnedSceneIds: (row.finalSceneIds ?? []).map(
      (sceneId) => inverse.get(sceneId) ?? `unmapped:${sceneId}`,
    ),
  };
}
