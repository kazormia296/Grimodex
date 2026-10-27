// S5-B の試験の補助（試験からだけ読む）。

const H = (c) => c.repeat(64);
const C = (c) => c.repeat(40);

/** S2 observation-prep の該当部分（claude/cp4-s2-observation-prep の値の写し）。 */
export function s2Record(mutate = (record) => record) {
  const record = {
    samplePlan: { warmupPerArm: 5, measuredPerArm: 30 },
    traces: [
      {
        kind: "editing",
        path: "evals/nir1-graph/trace-editing.v1.json",
        commit: C("a"),
        sha256: H("1"),
      },
      {
        kind: "browsing",
        path: "evals/nir1-graph/trace-browsing.v1.json",
        commit: C("a"),
        sha256: H("2"),
      },
    ],
    diagnosticRuns: [
      {
        id: "K24-G01-N1",
        runKind: "g-case-diagnostic-negative",
        variant: "G-01/v1",
        declare: false,
        mutationAfterDeclaration: null,
      },
      {
        id: "K24-G01-N2",
        runKind: "g-case-diagnostic-negative",
        variant: "G-01/v1",
        declare: true,
        mutationAfterDeclaration: "resave-same-body",
      },
      {
        id: "K24-G01-N3",
        runKind: "g-case-diagnostic-negative",
        variant: "G-01/v1",
        declare: true,
        mutationAfterDeclaration: "restore-same-bytes-body-version",
      },
      {
        id: "K24-G01-N4",
        runKind: "g-case-diagnostic-negative",
        variant: "G-01/v1",
        declare: true,
        mutationAfterDeclaration: "restore-different-bytes-body-version",
      },
      {
        id: "SP-P4",
        runKind: "seed-pin-parity",
        arms: ["hybrid"],
        graphArm: false,
        seedSent: false,
        variants: [
          "G-01/v1",
          "G-02/base",
          "G-03/base",
          "G-04/base",
          "G-05/base",
          "G-06/base",
          "G-07/base",
          "G-08/base-usable",
        ],
        sides: ["without-seed-pin-step", "with-seed-pin-step"],
        runsPerSide: 1,
        d2aMode: "restricted",
        branch: "single-pre-step-copy",
        compareBy: "logical-id",
        requiredRecords: [
          "owner-begins-delta-zero",
          "logical-to-runtime-both-sides",
          "d2a-mode-both-sides",
        ],
        attemptLimit: 2,
      },
    ],
  };
  return mutate(record) ?? record;
}
