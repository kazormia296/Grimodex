# Gate C2 Change Feed operation fragments

This directory holds one JSON fragment per Gate C2 Wave lane, matched by
`policies/narrative/change-feed-writers.json`'s `operationFragments` glob
(`policies/narrative/change-feed-operations/*.json`).
`validate-change-feed-writers.mjs` loads every fragment and merges its
`operations` into the same in-memory list the root manifest uses, so a
fragment operation goes through the identical route-pair, exclusion-reason,
and runtime-evidence checks as a root-manifest entry.

## Why fragments exist

The root manifest is a single ~4500-line JSON document. Having eight Wave 1
lanes and eight Wave 2 lanes edit it directly would turn every lane branch
into a merge conflict on the same file. Each lane instead owns exactly one
fragment file here; the Integration Owner is the only party that edits the
root manifest itself (to add or change `operationFragments` glob entries).

## Fragment shape

```json
{
  "schemaVersion": 1,
  "owner": "lane-c-finding-identity",
  "operations": [
    /* same operation object shape as policies/narrative/change-feed-writers.json */
  ]
}
```

## Rules

- One fragment file per lane. Name it `c2-<lane-topic>.json`
  (e.g. `c2-attention.json`, `c2-run.json`).
- Every operation inside a fragment must land with `coverageStatus:
  "verified"`. There is no interim `"declared"` state for a C2 operation on
  `master`: the command, its paired Electron IPC / N-API route, its
  BrowserMock parity, and its runtime evidence are required to land together
  at Transport Assembly (C2-T1 / C2-T2). A fragment operation with any other
  `coverageStatus` fails `pnpm test:narrative:change-feed-writers`.
- `feedPolicy: "excluded"` fragment operations may use the
  `non-backflow-invariant` exclusion reason for state that must never write
  back into the Narrative Change Feed (for example Attention set/clear).
- This directory is empty until a Wave lane's Transport Assembly lands its
  fragment; an empty directory is a valid, passing state.
