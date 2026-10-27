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
  bSealPublished,
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
 * The wait after the mutation (the setup's `b-seal` rule): a B generation
 * newer than the one before the mutation and not dirty, within `limitMs`
 * (B_SEAL_WAIT_MS). The Chronicle Index is built after it through the query
 * route, as the setup's `chronicle-index` step (`reopenUntilSealed`).
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
    // Review P3 (a): the driver's own b-seal rule.
    if (bSealPublished(metadata, previous))
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

/**
 * The control's attempts (review P2-3: each is the hook's parent and, when
 * that is not graph-ready, its follow-up after the product's graph-ready
 * mark). Harness values, not K6/4 values.
 */
export const G01_CONTROL_ATTEMPTS = 30;
/** DR-CP4-O-14: the sample's re-asks of a neutral (late) answer. */
export const G01_SAMPLE_ATTEMPTS = 30;
/** The wait for the product's graph-ready mark after a late parent. */
export const G01_GRAPH_READY_WAIT_MS = 10_000;
/** Between re-asks (fixed; short against the product's follow-up). */
export const G01_CONTROL_GAP_MS = 250;
/** Review P3 (f): what the control does not cover, disclosed. */
export const G01_CONTROL_LIMIT =
  "the control and the measurement share the Graph's relational input (Codex entries, Relations, pins); the B index digest is disclosed, not compared";

/** The answer a sample is judged on: the follow-up's when there is one. */
export const effectiveAnswerOf = (probe) =>
  probe?.child ?? probe?.parent ?? null;

/**
 * DR-CP4-O-14: the kind of one Graph answer — `ready` (graph-ready) and
 * `unavailable` (graph-unavailable, any reason) are decided; anything else
 * (late, no answer, a failed fetch) is neutral: it says neither reached nor
 * not reached, and only a neutral answer is asked again.
 */
export function answerKindOf(answer) {
  const outcome = answer?.graphOutcome;
  if (outcome === "graph-ready") return "ready";
  if (typeof outcome === "string" && outcome.startsWith("graph-unavailable"))
    return "unavailable";
  return "neutral";
}

/**
 * DR-CP4-O-14: the same operation asked again while its answer is neutral,
 * at most `limit` times with the fixed `gapMs` between; the FIRST decided
 * answer decides (never a best-of). Every try is recorded: its kind and
 * outcome, the owner counters' delta (begins, cacheHits, lateCached; a
 * cached answer is read by the same kind rule as any other) and its time.
 */
export async function askUntilDecided({
  ask,
  limit,
  gapMs = G01_CONTROL_GAP_MS,
  readCounters = null,
  sleep = delay,
  clock = () => Date.now(),
}) {
  const tries = [];
  for (let at = 0; at < limit; at++) {
    const before = readCounters ? await readCounters() : null;
    const started = clock();
    const probe = await ask();
    const durationMs = clock() - started;
    const after = readCounters ? await readCounters() : null;
    const answer = effectiveAnswerOf(probe);
    const kind = answerKindOf(answer);
    const counters =
      before && after
        ? Object.fromEntries(
            ["begins", "cacheHits", "lateCached"].map((key) => [
              key,
              (after[key] ?? 0) - (before[key] ?? 0),
            ]),
          )
        : null;
    tries.push({
      at,
      kind,
      outcome: answer?.graphOutcome ?? null,
      parentOutcome: probe?.parent?.graphOutcome ?? null,
      childOutcome: probe?.child?.graphOutcome ?? null,
      cached: counters
        ? counters.cacheHits > 0 || counters.lateCached > 0
        : null,
      counters,
      durationMs,
      timing: {
        parent: probe?.parent?.timing ?? null,
        child: probe?.child?.timing ?? null,
        readyMarkAfterMs: probe?.readyMarkAfterMs ?? null,
      },
      error: probe?.error ?? null,
    });
    if (kind !== "neutral")
      return { decided: true, probe, answer, kind, tries };
    if (at + 1 < limit) await sleep(gapMs);
  }
  return { decided: false, probe: null, answer: null, kind: "neutral", tries };
}

/**
 * DR-CP4-O-6: the control's verdict on one product answer — `reached` when
 * the Graph answer is graph-ready and its Graph-only row is the declared
 * Scene, pinned to the target Entity, through an edge from the seed to the
 * target Entity; `not-reached` when graph-ready without that path;
 * `undetermined` otherwise (late, unavailable, failed).
 */
export function classifyG01Control({ answer, ids, target }) {
  const kind = answerKindOf(answer);
  if (kind === "unavailable") return "not-reached";
  if (kind !== "ready") return "undetermined";
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
 * and seed): up to G01_CONTROL_ATTEMPTS product fetches as the hook consumes
 * them (`graphProbe`: the parent and, when it is late, the follow-up after
 * the graph-ready mark), until one answer is graph-ready; records every
 * answer, the owner counters (cacheHits, lateCached) before and after each,
 * the Graph input digest and the B index metadata (disclosed only).
 */
export async function runG01NegativeControl({
  page,
  ids,
  target,
  readGraphInputs,
  readCounters = null,
  readIndex = null,
  sleep = delay,
  attempts = G01_CONTROL_ATTEMPTS,
}) {
  const asked = await askUntilDecided({
    ask: async () => {
      const result = await pageCall(page, "graphProbe", {
        projectId: ids.projectId,
        sceneId: ids.scenes[target.querySceneId],
        seed: ids.entities[target.seedEntityId],
        readyWaitMs: G01_GRAPH_READY_WAIT_MS,
      });
      return result?.ok ? result.value : { error: result?.error ?? null };
    },
    limit: attempts,
    readCounters,
    sleep,
  });
  return {
    status: asked.decided
      ? classifyG01Control({ answer: asked.answer, ids, target })
      : "undetermined",
    decided: asked.decided,
    decidedAt: asked.decided ? asked.tries.length - 1 : null,
    answer: asked.answer,
    tries: asked.tries,
    graphInputs: graphInputsDigest(readGraphInputs()),
    bIndex: readIndex ? (readIndex()?.b ?? null) : null,
    limit: G01_CONTROL_LIMIT,
  };
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
  buildChronicle,
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
    if (sealed.ok) {
      // The setup's chronicle-index step: the Index through the query route
      // in this Main, then usable in the metadata. Not reopened (as the
      // setup's index-build-timeout).
      const chronicleBuild = await buildChronicle(session);
      const metadata = readIndex();
      const usable =
        indexStateProbe({ metadata }).chronicle === "usable" &&
        chronicleBuild?.ok !== false;
      sealAttempts.at(-1).chronicle = {
        build: chronicleBuild,
        metadata,
        usable,
      };
      // Review P3 (a): a B that went dirty again after its seal (the
      // driver's bDirtiedAfterSeal) is rebuilt only by a new opening.
      if (!bSealPublished(metadata, Number(before?.b?.generation ?? 0))) {
        sealAttempts.at(-1).outcome = "sealed-then-dirty";
        await session.close();
        continue;
      }
      if (usable) return { ok: true, session, sealAttempts };
      return {
        ok: false,
        session,
        sealAttempts,
        reason: "chronicle-index-not-usable",
      };
    }
    await session.close();
  }
  return {
    ok: false,
    session: null,
    sealAttempts,
    reason: "b-seal-not-published",
  };
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
  buildChronicle,
  reopen = reopenUntilSealed,
}) {
  const spec = specOf(id);
  const scene = { projectId: ids.projectId, sceneId: sceneOf(ids, target) };
  const indexBefore = readIndex();
  let mutation;
  if (spec.mutation === "resave-same-body") {
    const result = await pageCall(page, "resaveBody", scene);
    // Review P3 (b): the same bytes saved again as a new version.
    const resaved =
      result?.ok === true &&
      result.value.after.sha256 === result.value.before.sha256 &&
      Number.isInteger(result.value.before.version) &&
      result.value.after.version > result.value.before.version;
    if (!resaved)
      return {
        id,
        mutation: result ?? null,
        session: null,
        blocked: {
          reason: "mutation",
          error:
            result?.error ??
            (result.value.after.sha256 !== result.value.before.sha256
              ? "the body changed"
              : "the resave did not advance the body version"),
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
    buildChronicle,
  });
  if (!reopened.ok)
    return {
      id,
      mutation,
      indexBefore,
      sealAttempts: reopened.sealAttempts,
      session: reopened.session ?? null,
      blocked: {
        reason: reopened.reason ?? "b-seal-not-published",
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
