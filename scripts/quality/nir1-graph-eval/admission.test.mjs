// Git facts are read from throwaway repositories; nothing reaches a network.
// The frozen freeze record and G-01 fixture bytes are copied only so that
// their digests can be bound (they are never a Graph input).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GRAPH_ARM_SCOPES,
  GRAPH_ARM_WIRED,
  assertGraphArmRequestable,
  assertObservationPrepAdmits,
} from "../nir1-retrieval/contract.mjs";
import {
  assertDefaultAddonIsProduct,
  collectObservationPrepFacts,
  readK62FreezeHead,
  readNetNamespaces,
} from "./admission.mjs";
import {
  FROZEN_FIXTURE_SHA256,
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_RECORD_SCHEMA,
} from "./constants.mjs";
import {
  H64,
  candidate,
  evalReceipt,
  productReceipt,
} from "./test-support.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TRACE = "evals/nir1-graph/trace-editing.v1.json";
const FIXTURE = "evals/nir1-graph/g05-current-revision-freshness.v1.json";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cp4",
      GIT_AUTHOR_EMAIL: "cp4@example.invalid",
      GIT_COMMITTER_NAME: "cp4",
      GIT_COMMITTER_EMAIL: "cp4@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

async function put(cwd, file, bytes) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), bytes);
  git(cwd, "add", "--", file);
}

function commit(cwd, message) {
  git(cwd, "commit", "-q", "--no-gpg-sign", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function record(overrides = {}) {
  return `${JSON.stringify({
    schemaVersion: OBSERVATION_PREP_RECORD_SCHEMA,
    graphRuntimeObservedBeforeFreeze: false,
    k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
    graphCaseFreeze: { ...GRAPH_CASE_FREEZE },
    g01Fixture: { path: G01_FIXTURE.path, sha256: G01_FIXTURE.sha256 },
    boundFiles: { [TRACE]: sha256Of("trace\n") },
    ...overrides,
  })}\n`;
}

async function repository() {
  const repo = await mkdtemp(path.join(tmpdir(), "cp4-prep-"));
  git(repo, "init", "-q", "-b", "main");
  await put(
    repo,
    GRAPH_CASE_FREEZE.path,
    await readFile(path.join(ROOT, GRAPH_CASE_FREEZE.path)),
  );
  await put(
    repo,
    G01_FIXTURE.path,
    await readFile(path.join(ROOT, G01_FIXTURE.path)),
  );
  await put(repo, TRACE, "trace\n");
  const base = commit(repo, "frozen material");
  return { repo, base };
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

function graphCase(head, observationPrep) {
  const tree = head;
  return assertGraphArmRequestable(GRAPH_ARM_WIRED, {
    scope: GRAPH_ARM_SCOPES.graphCase,
    buildReceipt: evalReceipt({ candidate: candidate(head, tree) }),
    productReceipt: productReceipt({ candidate: candidate(head, tree) }),
    fixtures: [{ path: FIXTURE, sha256: FROZEN_FIXTURE_SHA256[FIXTURE] }],
    observationPrep,
  });
}

test("N-1 / P1-1 / P2-1: observation-prep facts gate a frozen fixture end to end", async () => {
  const { repo } = await repository();
  try {
    const traceDigest = sha256Of("trace\n");
    await put(
      repo,
      OBSERVATION_PREP_RECORD_PATH,
      record({ boundFiles: { [TRACE]: traceDigest } }),
    );
    const prep = commit(repo, "observation prep");
    git(repo, "update-ref", "refs/remotes/origin/master", prep);
    await put(repo, "candidate.txt", "candidate\n");
    const head = commit(repo, "candidate");
    const facts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: head,
    });
    assert.equal(facts.recordPath, OBSERVATION_PREP_RECORD_PATH);
    assert.equal(facts.recordIntroducedByCommit, true);
    assert.equal(facts.onRemoteRef, true);
    assert.equal(facts.remoteRef, "refs/remotes/origin/master");
    assert.equal(graphCase(head, facts).fixtureClass, "frozen");
    assert.throws(
      () =>
        collectObservationPrepFacts({
          root: repo,
          commit: prep,
          candidateHead: head,
          freezeRecordPath: GRAPH_CASE_FREEZE.path,
        }),
      /unsupported option/,
    );

    // A later commit does not introduce the record.
    const later = facts.candidateHead;
    git(repo, "update-ref", "refs/remotes/origin/master", later);
    const laterFacts = collectObservationPrepFacts({
      root: repo,
      commit: later,
      candidateHead: later,
    });
    assert.equal(laterFacts.recordIntroducedByCommit, false);
    assert.equal(laterFacts.onRemoteRef, true);
    assert.throws(() => graphCase(later, laterFacts), /did not introduce/);

    // On another remote-tracking ref only.
    git(repo, "update-ref", "refs/remotes/origin/master", facts.commit + "~1");
    git(repo, "update-ref", "refs/remotes/fork/feature", prep);
    const forkFacts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: head,
    });
    assert.equal(forkFacts.onRemoteRef, false);
    assert.throws(
      () => graphCase(head, forkFacts),
      /not on refs\/remotes\/origin\/master/,
    );
    git(repo, "update-ref", "refs/remotes/origin/master", prep);

    // A bound file changed after the pre-observation commit.
    await put(repo, TRACE, "trace v2\n");
    const edited = commit(repo, "edit trace");
    assert.throws(
      () =>
        graphCase(
          edited,
          collectObservationPrepFacts({
            root: repo,
            commit: prep,
            candidateHead: edited,
          }),
        ),
      /differs from the record/,
    );
    // The record itself changed.
    await put(repo, TRACE, "trace\n");
    await put(
      repo,
      OBSERVATION_PREP_RECORD_PATH,
      record({ boundFiles: { [TRACE]: traceDigest }, note: "x" }),
    );
    const rewritten = commit(repo, "rewrite record");
    assert.throws(
      () =>
        graphCase(
          rewritten,
          collectObservationPrepFacts({
            root: repo,
            commit: prep,
            candidateHead: rewritten,
          }),
        ),
      /freeze record differs/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P1-1: a record that does not bind the frozen digests is refused", async () => {
  const { repo } = await repository();
  try {
    await put(
      repo,
      OBSERVATION_PREP_RECORD_PATH,
      record({ graphRuntimeObservedBeforeFreeze: true }),
    );
    const prep = commit(repo, "observed record");
    git(repo, "update-ref", "refs/remotes/origin/master", prep);
    assert.throws(
      () =>
        graphCase(
          prep,
          collectObservationPrepFacts({
            root: repo,
            commit: prep,
            candidateHead: prep,
          }),
        ),
      /graphRuntimeObservedBeforeFreeze/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P1-1: the reviewer's reproduction (a commit without the record) is refused", () => {
  const head = git(ROOT, "rev-parse", "HEAD");
  const facts = collectObservationPrepFacts({
    root: ROOT,
    commit: "HEAD",
    candidateHead: "HEAD",
  });
  assert.equal(facts.recordIntroducedByCommit, false);
  assert.throws(() => assertObservationPrepAdmits(facts, head), /\[precheck\]/);
});

test("N-4: the K6/2 freeze head is read from the freeze commit or no receipt is written", (t) => {
  try {
    git(ROOT, "cat-file", "-e", `${K62_FREEZE.commit}^{commit}`);
  } catch {
    t.skip("the K6/2 freeze commit is not in this clone (shallow checkout)");
    return;
  }
  assert.deepEqual(
    readK62FreezeHead({ root: ROOT, commit: K62_FREEZE.commit }),
    {
      freezeCommit: K62_FREEZE.commit,
      sha256: K62_FREEZE.sha256,
    },
  );
  assert.throws(
    () => readK62FreezeHead({ root: ROOT, commit: "" }),
    /not given/,
  );
  assert.throws(
    () => readK62FreezeHead({ root: ROOT, commit: `${K62_FREEZE.commit}~1` }),
    /\[precheck\]/,
  );
});

test("P2-10: the default addon path must hold the product .node (positive check)", () => {
  const product = productReceipt();
  const evaluation = evalReceipt();
  const productNode =
    product.artifacts["electron/native/grimodex-node/grimodex-node.node"];
  assert.doesNotThrow(() =>
    assertDefaultAddonIsProduct({
      defaultAddonSha256: productNode,
      productReceipt: product,
      evalReceipt: evaluation,
    }),
  );
  assert.throws(
    () =>
      assertDefaultAddonIsProduct({
        defaultAddonSha256: H64("0"),
        productReceipt: product,
        evalReceipt: evaluation,
      }),
    /does not hold the product/,
  );
  assert.throws(
    () =>
      assertDefaultAddonIsProduct({
        defaultAddonSha256: productNode,
        productReceipt: product,
        evalReceipt: null,
      }),
    /\[precheck\]/,
  );
  assert.throws(
    () =>
      assertDefaultAddonIsProduct({
        defaultAddonSha256: productNode,
        productReceipt: null,
        evalReceipt: evaluation,
      }),
    /\[precheck\]/,
  );
  const sameAsEval = productReceipt({
    artifacts: {
      ...product.artifacts,
      "electron/native/grimodex-node/grimodex-node.node": H64("e"),
    },
  });
  assert.throws(
    () =>
      assertDefaultAddonIsProduct({
        defaultAddonSha256: H64("e"),
        productReceipt: sameAsEval,
        evalReceipt: evaluation,
      }),
    /holds the evaluation build/,
  );
});

test("P2-9: the network namespaces of the harness and its parent are readable on Linux", (t) => {
  const netns = readNetNamespaces();
  if (process.platform !== "linux") {
    assert.equal(netns.unavailable, true);
    t.skip("not Linux");
    return;
  }
  assert.match(netns.self, /^net:\[\d+\]$/u);
  assert.match(netns.parent, /^net:\[\d+\]$/u);
});
