// Git facts are read from a throwaway repository; nothing reaches a network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GRAPH_ARM_SCOPES,
  GRAPH_ARM_WIRED,
  assertGraphArmRequestable,
} from "../nir1-retrieval/contract.mjs";
import {
  assertDefaultAddonIsNotEvaluation,
  collectObservationPrepFacts,
  readK62FreezeHead,
} from "./admission.mjs";
import { K62_FREEZE } from "./constants.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const RECORD = "evals/nir1-graph/observation-prep-freeze.v1.json";

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

async function commitFile(cwd, file, text, message) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), text);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-q", "--no-gpg-sign", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function evalReceipt(head) {
  return {
    schemaVersion: "nir1-graph-eval-build/1",
    status: "passed",
    standardBuild: false,
    evaluationBuild: true,
    sourceUnchanged: true,
    candidate: {
      worktreeClean: true,
      resolvedBaseSha: head,
      resolvedHeadSha: head,
      resolvedHeadTreeSha: head,
      currentHeadSha: head,
    },
    features: ["nir1-graph-eval"],
    capabilities: { nir1GraphEval: true },
    artifacts: {
      ".artifacts/cp4/eval-build/grimodex-node.node": "e".repeat(64),
      ".artifacts/cp4/eval-build/nir1-c-query-worker": "f".repeat(64),
    },
    worker: {
      path: ".artifacts/cp4/eval-build/nir1-c-query-worker",
      sha256: "f".repeat(64),
    },
  };
}

test("N-1: observation-prep facts gate a frozen fixture end to end", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "cp4-prep-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    const prep = await commitFile(
      repo,
      RECORD,
      '{"v":1}\n',
      "observation prep",
    );
    git(repo, "update-ref", "refs/remotes/origin/master", prep);
    const head = await commitFile(
      repo,
      "candidate.txt",
      "candidate\n",
      "candidate",
    );
    const facts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: head,
      freezeRecordPath: RECORD,
    });
    assert.equal(facts.ancestorOfCandidateHead, true);
    assert.deepEqual(facts.remoteRefs, ["refs/remotes/origin/master"]);
    assert.equal(
      facts.freezeRecordSha256AtCommit,
      facts.freezeRecordSha256AtHead,
    );
    const request = (observationPrep) =>
      assertGraphArmRequestable(GRAPH_ARM_WIRED, {
        scope: GRAPH_ARM_SCOPES.graphCase,
        buildReceipt: evalReceipt(head),
        fixturePaths: [
          "evals/nir1-graph/g05-current-revision-freshness.v1.json",
        ],
        observationPrep,
      });
    assert.equal(request(facts).fixtureClass, "frozen");

    // Not on any remote-tracking ref.
    git(repo, "checkout", "-q", "-b", "local-only");
    const local = await commitFile(repo, "local.txt", "x\n", "local prep");
    const localHead = await commitFile(repo, "local2.txt", "y\n", "local head");
    const localFacts = collectObservationPrepFacts({
      root: repo,
      commit: local,
      candidateHead: localHead,
      freezeRecordPath: RECORD,
    });
    assert.deepEqual(localFacts.remoteRefs, []);
    assert.throws(
      () =>
        assertGraphArmRequestable(GRAPH_ARM_WIRED, {
          scope: GRAPH_ARM_SCOPES.graphCase,
          buildReceipt: evalReceipt(localHead),
          fixturePaths: [
            "evals/nir1-graph/g05-current-revision-freshness.v1.json",
          ],
          observationPrep: localFacts,
        }),
      /remote-tracking ref/,
    );

    // The freeze record changed after the pre-observation commit.
    git(repo, "checkout", "-q", "main");
    const edited = await commitFile(repo, RECORD, '{"v":2}\n', "edit record");
    const editedFacts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: edited,
      freezeRecordPath: RECORD,
    });
    assert.notEqual(
      editedFacts.freezeRecordSha256AtCommit,
      editedFacts.freezeRecordSha256AtHead,
    );
    assert.throws(
      () =>
        assertGraphArmRequestable(GRAPH_ARM_WIRED, {
          scope: GRAPH_ARM_SCOPES.graphCase,
          buildReceipt: evalReceipt(edited),
          fixturePaths: [
            "evals/nir1-graph/g05-current-revision-freshness.v1.json",
          ],
          observationPrep: editedFacts,
        }),
      /freeze record differs/,
    );

    // A candidate that does not descend from the pre-observation commit.
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    git(repo, "rm", "-rq", "--cached", ".");
    const unrelated = await commitFile(repo, RECORD, '{"v":1}\n', "unrelated");
    const unrelatedFacts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: unrelated,
      freezeRecordPath: RECORD,
    });
    assert.equal(unrelatedFacts.ancestorOfCandidateHead, false);
    assert.throws(
      () =>
        assertGraphArmRequestable(GRAPH_ARM_WIRED, {
          scope: GRAPH_ARM_SCOPES.graphCase,
          buildReceipt: evalReceipt(unrelated),
          fixturePaths: ["evals/nir1-g01/fixture.v1.json"],
          observationPrep: unrelatedFacts,
        }),
      /not an ancestor/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
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

test("§15.2: the harness refuses a default addon that is the evaluation build", () => {
  const receipt = evalReceipt("a".repeat(40));
  assert.doesNotThrow(() =>
    assertDefaultAddonIsNotEvaluation({
      defaultAddonSha256: "d".repeat(64),
      evalReceipt: receipt,
    }),
  );
  assert.throws(
    () =>
      assertDefaultAddonIsNotEvaluation({
        defaultAddonSha256: "e".repeat(64),
        evalReceipt: receipt,
      }),
    /\[precheck\] the default addon path holds the evaluation build/,
  );
});
