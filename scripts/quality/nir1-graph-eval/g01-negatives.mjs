/* global window */
// CP-4 S5-B: K24-G01-N2〜N4 の段（DR-CP4-O-1 (5)、G-01 の addendum の
// diagnosticNegatives）。測定の loop（samplePlan の 3 arm、AB/BA）と K2/4 の
// 宣言の段は A の正式の runner に置き、この module はその runner が呼ぶ段を持つ:
//   1. `prepareG01NegativeBeforeDeclaration`（宣言より前）: N3 は宣言の時点と
//      同じ bytes の本文版、N4 は「 Draft.」を足した本文の版と元の本文の再保存。
//   2. `runG01NegativeStep`（宣言の段の直後、V-10 の probe と warm-up の前）:
//      N2 は同じ本文の再保存、N3／N4 は Scene の本文版の restore（project の
//      snapshot の restore は使わない）。その後、B の seal が current に戻り
//      Chronicle の Index が使えることを setup の B の seal の待ちと同じ規則と
//      上限で待ち（届かなければ blocked）、SP/1 の SP-P1 を DB から照合し直す。
//   3. 測った sample の照合と結果は `frozen-diagnostics.mjs` の
//      `assessG01Negative`。
// 測定の Main は B-ROUTE の journey seam で起動する（`g01NegativeLaunchEnv`）。
// 書込みは製品の writer だけ（renderer/cp4-diagnostic-probe.ts）。

import { setTimeout as delay } from "node:timers/promises";
import { G01_N4_DRAFT_SUFFIX, G01_NEGATIVES } from "./frozen-diagnostics.mjs";
import { B_SEAL_WAIT_MS, indexStateProbe } from "./frozen-setup-driver.mjs";
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
 * After the declaration step, before the V-10 probe: the mutation, the wait
 * for B and the Chronicle Index, and SP-P1 again. Returns the step record;
 * `blocked` is set when the mutation path is unavailable or B never returned
 * (the diagnostic is recorded as blocked, never counted).
 */
export async function runG01NegativeStep({
  id,
  page,
  ids,
  target,
  before,
  readIndex,
  readPins,
  wait = waitG01NegativeSealed,
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
        blocked: {
          reason: "mutation",
          error:
            result?.error ?? "the restored body is not the prepared version",
        },
      };
    mutation = result.value;
  }
  const sealed = await wait({ readIndex, before: indexBefore });
  if (!sealed.ok)
    return {
      id,
      mutation,
      indexBefore,
      wait: sealed,
      blocked: { reason: "b-seal-not-current", waitedMs: sealed.waitedMs },
    };
  const spP1Recheck = recheckG01SpP1({ ids, target, read: readPins() });
  return {
    id,
    mutation,
    indexBefore,
    wait: sealed,
    spP1Recheck,
    blocked: null,
  };
}

/**
 * One measured Graph-arm sample of a negative in logical IDs (the formal
 * runner's sample row): the parent's seed, whether the frame reached
 * `g01-mira-entity` (null: no entry reads the Graph frame), the returned
 * Scenes.
 */
export function g01NegativeSampleOf({ row, ids, frameReached = null }) {
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
    frameReached,
    returnedSceneIds: (row.finalSceneIds ?? []).map(
      (sceneId) => inverse.get(sceneId) ?? `unmapped:${sceneId}`,
    ),
  };
}
