/* global window */
// CP-4 S5-B: K24-G01-N2〜N4 の正式の run を A の Graph arm の runner
// （`frozen-k64-run.mjs`、`--run-kind negative`）に繋ぐ hook（DR-CP4-O-8、O-16）。
// A の runner は測定の process の組立て（写し、Main、workspace、宣言の段、Raw、
// Chronicle、SP-P1、probe）と samplePlan（3 arm、AB/BA）の loop を持ち、この
// module の hook を決まった位置で呼ぶ:
//   - `launchEnv(base)`: 測定の Main の起動に B-ROUTE の journey seam を重ねる。
//   - `beforeDeclaration(...)`: 宣言の段の直前（N3／N4 の版の用意。N4 は保存の
//     後に Main を開き直して B と Chronicle を待つ）。
//   - `afterDeclaration(...)`: 宣言の段の直後（対照、mutation、Main の開き直し、
//     SP-P1 の照合し直し）。開き直した session を返す。
//   - `askGraph(take)`: graph の arm の 1 sample を、答えが中立（late）の間だけ
//     同じ操作で聞き直し、最初に決まった答えの sample を返す（DR-CP4-O-14）。
//   - `assess(samples)`: 測った graph の arm の sample の照合と結果（case の判定に
//     数えない）。
// blocked（版を作れない、B が戻らない）は `negativeBlocked` を持つ error で止め、
// A の runner はその variant を stopped として記録する（判定に数えない）。

import { randomUUID } from "node:crypto";
import {
  G01_SAMPLE_ATTEMPTS,
  askUntilDecided,
  assertG01RetryFixed,
  g01NegativeLaunchEnv,
  g01NegativeSampleOf,
  prepareG01NegativeBeforeDeclaration,
  reopenUntilSealed,
  runG01NegativeControl,
  runG01NegativeStep,
} from "./g01-negatives.mjs";
import {
  G01_NEGATIVES,
  assessG01Negative,
  g01NegativeTargets,
} from "./frozen-diagnostics.mjs";
import {
  readIndexMetadata,
  readQuerySceneSeedPins,
  readWorkspaceRows,
} from "./workspace-db.mjs";

function blocked(state, reason) {
  const error = new Error(
    `S5-B ${state.id} blocked: ${JSON.stringify(reason)} (a diagnostic; never counted)`,
  );
  error.negativeBlocked = reason;
  error.negative = state;
  return error;
}

/** The k64 row's Graph answer as the re-ask rule reads it (parent, child). */
export function rowProbeOf(row) {
  return {
    parent: { graphOutcome: row?.graph?.outcome ?? null },
    child: row?.followUp?.child
      ? { graphOutcome: row.followUp.child.outcome ?? null }
      : null,
  };
}

/**
 * The hooks of one negative (`id` K24-G01-N2〜N4) for A's runner. `root`
 * reads the frozen G-01 targets (or `target` for a dev shape check).
 */
export function createG01NegativeRun({ id, root, target = null }) {
  if (!Object.hasOwn(G01_NEGATIVES, id))
    throw new Error(`[precheck] S5-B: ${String(id)} is not K24-G01-N2〜N4`);
  const goal = target ?? g01NegativeTargets({ root });
  const state = {
    id,
    target: goal,
    before: null,
    beforeDeclarationSealAttempts: null,
    control: null,
    step: null,
    graphTries: [],
  };
  const reopen = async ({ proc, ids, relaunch, stop, label, before }) => {
    const readIndex = () => readIndexMetadata(proc.dbPath, ids.projectId);
    let current = proc.session;
    const reopened = await reopenUntilSealed({
      closeCurrent: async () => {
        await stop(current);
        current = null;
      },
      openSession: async ({ dirLabel }) => {
        current = await relaunch(dirLabel);
        return { session: current, close: () => stop(current) };
      },
      readIndex,
      before,
      buildChronicle: async (opened) =>
        opened.session.page
          .evaluate((input) => window.cp4Harness.buildIndex(input), {
            sceneId: ids.querySceneId,
            limitMs: 120_000,
          })
          .then(
            (value) => ({ ok: value?.ok === true }),
            (error) => ({ ok: false, error: String(error?.message ?? error) }),
          ),
      label,
    });
    return reopened;
  };
  return {
    id,
    state,
    launchEnv: (base) => g01NegativeLaunchEnv({ nonce: randomUUID(), base }),
    async beforeDeclaration({ page, ids, proc, relaunch, stop }) {
      const indexBefore = readIndexMetadata(proc.dbPath, ids.projectId);
      state.before = await prepareG01NegativeBeforeDeclaration({
        id,
        page,
        ids,
        target: goal,
      });
      if (state.before.blocked) throw blocked(state, state.before.blocked);
      if (state.before.prepared?.kind !== "draft-then-original") return null;
      // N4's saves: B (and the Chronicle Index) sealed again before the
      // declaration, by reopening the Main.
      const reopened = await reopen({
        proc,
        ids,
        relaunch,
        stop,
        label: "before-declaration",
        before: indexBefore,
      });
      state.beforeDeclarationSealAttempts = reopened.sealAttempts;
      if (!reopened.ok)
        throw blocked(state, {
          reason: reopened.reason ?? "b-seal-not-published",
        });
      return reopened.session.session;
    },
    async afterDeclaration({ page, ids, proc, relaunch, stop }) {
      const readIndex = () => readIndexMetadata(proc.dbPath, ids.projectId);
      const readGraphInputs = () =>
        readWorkspaceRows(proc.dbPath, ids.projectId);
      const readCounters = async () =>
        JSON.parse(await proc.session.addon("nir1GraphEvalDiagnostics"));
      state.control = await runG01NegativeControl({
        page,
        ids,
        target: goal,
        readGraphInputs,
        readCounters,
        readIndex,
      });
      let current = proc.session;
      state.step = await runG01NegativeStep({
        id,
        page,
        ids,
        target: goal,
        before: state.before?.prepared ?? null,
        readIndex,
        readPins: () =>
          readQuerySceneSeedPins(proc.dbPath, ids.projectId, ids.querySceneId),
        readGraphInputs,
        closeCurrent: async () => {
          await stop(current);
          current = null;
        },
        openSession: async ({ dirLabel }) => {
          current = await relaunch(dirLabel);
          return { session: current, close: () => stop(current) };
        },
        buildChronicle: async (opened) =>
          opened.session.page
            .evaluate((input) => window.cp4Harness.buildIndex(input), {
              sceneId: ids.querySceneId,
              limitMs: 120_000,
            })
            .then(
              (value) => ({ ok: value?.ok === true }),
              (error) => ({
                ok: false,
                error: String(error?.message ?? error),
              }),
            ),
      });
      if (state.step.blocked) throw blocked(state, state.step.blocked);
      return state.step.session.session;
    },
    /**
     * The measurement point of a negative: the B (and C) generation sealed
     * by the reopened Main after the mutation (S2: measured once B is
     * current again), in place of the setup's.
     */
    measurementProbe(base) {
      const last = state.step?.sealAttempts?.at(-1);
      const metadata = last?.chronicle?.metadata ?? last?.metadata ?? null;
      return {
        ...base,
        bGeneration: metadata?.b?.generation ?? null,
        chronicleGeneration: metadata?.chronicle?.generation ?? null,
        negativeReopen: true,
      };
    },
    async askGraph(take) {
      const takes = [];
      const asked = await askUntilDecided({
        ask: async () => {
          const taken = await take();
          takes.push(taken);
          return rowProbeOf(taken.row);
        },
        limit: G01_SAMPLE_ATTEMPTS,
      });
      const last = takes.at(-1);
      // Review P3: every take set aside (a neutral answer) stays disclosed
      // with its release and its index state at the query.
      const discarded = takes.slice(0, -1).map((taken, at) => ({
        at,
        reason: "neutral-answer",
        parentOutcome: taken.row?.graph?.outcome ?? null,
        childOutcome: taken.row?.followUp?.child?.outcome ?? null,
        release: taken.release ?? null,
        indexUsable: taken.indexUsable ?? null,
      }));
      state.graphTries.push({
        decided: asked.decided,
        tries: asked.tries,
        discardedTakes: discarded.length,
        discarded,
        retry: { limit: asked.limit, gapMs: asked.gapMs },
      });
      last.row = {
        ...last.row,
        negativeRetry: { limit: asked.limit, gapMs: asked.gapMs },
      };
      return last;
    },
    assess({ samples, ids }) {
      const rows = (samples ?? [])
        .filter((row) => row?.arm === "graph" && row?.phase === "measured")
        .map((row) =>
          g01NegativeSampleOf({
            row,
            ids,
            target: goal,
            control: state.control,
            inputsDigest: state.step?.graphInputs ?? null,
            retry: row.negativeRetry ?? null,
          }),
        );
      assertG01RetryFixed({ control: state.control, samples: rows });
      return {
        samples: rows,
        assessment: assessG01Negative({
          id,
          spP1Recheck: state.step?.spP1Recheck,
          samples: rows,
          target: goal,
        }),
        control: state.control,
        step: state.step ? { ...state.step, session: undefined } : null,
        beforeDeclaration: state.before,
        beforeDeclarationSealAttempts: state.beforeDeclarationSealAttempts,
        graphTries: state.graphTries,
      };
    },
  };
}
