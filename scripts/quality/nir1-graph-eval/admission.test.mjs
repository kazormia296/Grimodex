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
  observationPrepRecordErrors,
} from "../nir1-retrieval/contract.mjs";
import {
  OBSERVATION_PREP_S2_PATH,
  admitFrozenDryRun,
  admitGraphCaseRun,
  assertDefaultAddonIsProduct,
  assertProcedureBound,
  assertReceiptHeadBound,
  collectObservationPrepFacts,
  collectRatification5Evidence,
  collectRatification5EvidenceWithKeepTest,
  readAdmittedFixture,
  readK62FreezeHead,
  readK64FreezeHead,
  readAdmittedObservationPrep,
  readFreezeBoundFile,
  readNetNamespaces,
  rebindRatification5,
} from "./admission.mjs";
import {
  assertPrepForAdmission,
  readFrozenSpP4Plan,
} from "./diagnostic-runner.mjs";
import {
  buildRunHead,
  readBoundFile,
  readDiagnosticPlan,
  readTraceFileHeads,
} from "./frozen-diagnostics.mjs";
import { admitFormalK64Run } from "./frozen-k64-admission.mjs";
import { readTraceDeclaration } from "./trace-frozen.mjs";
import {
  claimFactsSealer,
  claimTestEvidenceSealer,
  isCollectedFacts,
} from "./admission-facts.mjs";
import {
  FROZEN_FIXTURE_SHA256,
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  K64_CANDIDATE_REQUIREMENTS,
  K64_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_RECORD_SCHEMA,
} from "./constants.mjs";
import {
  H40,
  H64,
  candidate,
  evalReceipt,
  keepTestCandidate,
  productReceipt,
  ratification5,
  S4_REHEARSAL_FILES,
  S4_REHEARSAL_G02_DECLARED,
  s4RehearsalRepository,
} from "./test-support.mjs";
import { assessCandidateRegime } from "./followup.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
  procedureFilePath,
  procedureSettings,
} from "./procedure-file.mjs";

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
  assert.ok(Array.isArray(netns.hostInterfaces));
});

test("B-4: readNetNamespaces は host の interface と利用者の systemd --user の netns を読む（合成の /proc）", async () => {
  const proc = await mkdtemp(path.join(tmpdir(), "cp4-netns-"));
  try {
    const { symlink } = await import("node:fs/promises");
    const pid = async (id, { name, uid, cmdline, ns }) => {
      await mkdir(path.join(proc, id, "ns"), { recursive: true });
      await writeFile(
        path.join(proc, id, "status"),
        `Name:\t${name}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
      );
      await writeFile(path.join(proc, id, "cmdline"), cmdline);
      await symlink(ns, path.join(proc, id, "ns", "net"));
    };
    await pid("100", {
      name: "node",
      uid: 1000,
      cmdline: "node\0x",
      ns: "net:[5]",
    });
    await pid("90", {
      name: "node",
      uid: 1000,
      cmdline: "node",
      ns: "net:[5]",
    });
    await pid("50", {
      name: "systemd",
      uid: 1000,
      cmdline: "/usr/lib/systemd/systemd\0--user",
      ns: "net:[7]",
    });
    await pid("51", {
      name: "systemd",
      uid: 0,
      cmdline: "/sbin/init",
      ns: "net:[8]",
    });
    await mkdir(path.join(proc, "100", "net"), { recursive: true });
    await writeFile(
      path.join(proc, "100", "net", "dev"),
      "Inter-|\n face |\n    lo: 0 0\n",
    );
    const netns = readNetNamespaces({
      procRoot: proc,
      selfPid: 100,
      parentPid: 90,
      uid: 1000,
    });
    assert.deepEqual(netns, {
      self: "net:[5]",
      parent: "net:[5]",
      hostInterfaces: ["lo"],
      userManager: "net:[7]",
    });
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

/** A repo whose candidate head descends from an observation-prep commit. */
async function preparedRepository() {
  const { repo, base } = await repository();
  await put(repo, OBSERVATION_PREP_RECORD_PATH, record());
  const prep = commit(repo, "observation prep");
  git(repo, "update-ref", "refs/remotes/origin/master", prep);
  await put(repo, "candidate.txt", "candidate\n");
  const head = commit(repo, "candidate");
  return { repo, base, prep, head };
}

const PRODUCT_NODE = "electron/native/grimodex-node/grimodex-node.node";

test("P2-7（変異 M19）: prep が origin/master にあっても候補の祖先でなければ拒む（実 git）", async () => {
  const { repo, base } = await repository();
  try {
    await put(repo, OBSERVATION_PREP_RECORD_PATH, record());
    const prep = commit(repo, "observation prep");
    git(repo, "update-ref", "refs/remotes/origin/master", prep);
    git(repo, "checkout", "-q", "-b", "candidate", base);
    await put(repo, "candidate.txt", "candidate\n");
    const head = commit(repo, "candidate without the prep commit");
    const facts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: head,
    });
    assert.equal(facts.onRemoteRef, true);
    assert.equal(facts.ancestorOfCandidateHead, false);
    assert.throws(
      () => graphCase(head, facts),
      /not an ancestor of the candidate head/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P2-7: 手で作った facts と書き換えた facts は N-1 の guard を通らない（出所の束縛）", async () => {
  const { repo, head, prep } = await preparedRepository();
  try {
    const facts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: head,
    });
    assert.equal(graphCase(head, facts).fixtureClass, "frozen");
    for (const forged of [{ ...facts }, JSON.parse(JSON.stringify(facts))])
      assert.throws(() => graphCase(head, forged), /collected/);
    assert.throws(() => {
      facts.ancestorOfCandidateHead = false;
    }, TypeError);
    assert.throws(() => {
      facts.headFileSha256[TRACE] = H64("0");
    }, TypeError);
    assert.throws(() => claimFactsSealer(), /already claimed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P2-7: admitGraphCaseRun は facts を自分で集め、N-1、既定の addon、K6/2 と K6/4 の凍結を順に確かめる", async () => {
  const { repo, base, prep, head } = await preparedRepository();
  try {
    const product = productReceipt({ candidate: candidate(head, head) });
    const input = {
      root: repo,
      candidateHead: head,
      prepCommit: prep,
      buildReceipt: evalReceipt({ candidate: candidate(head, head) }),
      productReceipt: product,
      fixtures: [{ path: FIXTURE, sha256: FROZEN_FIXTURE_SHA256[FIXTURE] }],
      defaultAddonSha256: product.artifacts[PRODUCT_NODE],
      k62Commit: K62_FREEZE.commit,
      k64Commit: H40("4"),
    };
    // Everything the temp repo can show passes; the K6/2 freeze commit lives
    // only in the real repository, so the run stops there.
    assert.throws(
      () => admitGraphCaseRun(input),
      new RegExp(K62_FREEZE.commit),
    );
    assert.throws(
      () => admitGraphCaseRun({ ...input, prepCommit: undefined }),
      /\[precheck\]/,
    );
    assert.throws(
      () => admitGraphCaseRun({ ...input, prepCommit: base }),
      /did not introduce/,
    );
    assert.throws(
      () =>
        admitGraphCaseRun({
          ...input,
          defaultAddonSha256: H64("e"),
        }),
      /default addon path/,
    );
    assert.throws(
      () =>
        admitGraphCaseRun({
          ...input,
          fixtures: [
            {
              path: "scripts/quality/nir1-graph-eval/dev-fixtures/dev-g02.v1.json",
              sha256: H64("d"),
            },
          ],
        }),
      /frozen fixtures/,
    );
    assert.throws(
      () => admitGraphCaseRun({ ...input, observationPrep: {} }),
      /unsupported option/,
    );
    // P2-4: the keep test runs before (async); this entry takes only the
    // sealed evidence of the same candidate head.
    assert.throws(
      () => admitGraphCaseRun({ ...input, keepTestWorktree: repo }),
      /unsupported option keepTestWorktree/,
    );
    const sealed = collectRatification5Evidence({
      root: repo,
      candidateHead: head,
    });
    assert.throws(
      () =>
        admitGraphCaseRun({
          ...input,
          ratification5: JSON.parse(JSON.stringify(sealed)),
        }),
      /sealed evidence/,
    );
    assert.throws(
      () =>
        admitGraphCaseRun({
          ...input,
          ratification5: collectRatification5Evidence({
            root: repo,
            candidateHead: base,
          }),
        }),
      /another candidate head/,
    );
    assert.throws(
      () => admitGraphCaseRun({ ...input, ratification5: sealed }),
      new RegExp(K62_FREEZE.commit),
    );
    // A fixture read needs the admission this entry returns.
    const direct = graphCase(
      head,
      collectObservationPrepFacts({
        root: repo,
        commit: prep,
        candidateHead: head,
      }),
    );
    assert.throws(
      () => readAdmittedFixture(direct, { root: repo, path: FIXTURE }),
      /admitGraphCaseRun/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("批准 7（DR-CP4-T14-1）: K6/4 の凍結の commit は claude/nir1-contracts の 5dea38af に固定されている", () => {
  assert.equal(
    K64_FREEZE.freezeCommit,
    "5dea38af158283c2a925d68ef0d8b0771c0ea209",
  );
  assert.match(K64_FREEZE.freezeCommit, /^[0-9a-f]{40}$/u);
  assert.notEqual(K64_FREEZE.freezeCommit, K64_FREEZE.confirmedCommit);
  assert.equal(
    K64_FREEZE.sha256,
    "d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3",
  );
});

// CI の clone は claude/nir1-contracts を fetch しないので、正の経路は一時 repo
// の凍結の descriptor を注入して確かめる（製品の既定は K64_FREEZE のまま）。
test("批准 7: K6/4 の先頭は固定した commit と bytes の両方が一致するときだけ読み、null の descriptor では止まる", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "cp4-k64-freeze-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    const frozen = "# K6/4 (test bytes)\n";
    await put(repo, K64_FREEZE.path, frozen);
    const freezeCommit = commit(repo, "freeze");
    git(repo, "tag", "k64-freeze", freezeCommit);
    await put(repo, "other.txt", "after\n");
    const later = commit(repo, "later, same K6/4 bytes");
    await put(repo, K64_FREEZE.path, `${frozen}changed\n`);
    const changed = commit(repo, "changed K6/4 bytes");
    git(repo, "rm", "-q", "--", K64_FREEZE.path);
    const removed = commit(repo, "removed K6/4");
    const freeze = Object.freeze({
      ...K64_FREEZE,
      sha256: sha256Of(frozen),
      freezeCommit,
    });
    const read = (commitRef, descriptor = freeze) =>
      readK64FreezeHead({ root: repo, commit: commitRef }, descriptor);
    // 正の経路：commit（ref でも）を git で解決し、bytes の SHA-256 も一致する。
    const expected = { freezeCommit, sha256: sha256Of(frozen) };
    assert.deepEqual(read(freezeCommit), expected);
    assert.deepEqual(read("k64-freeze"), expected);
    // 同じ bytes でも固定した commit でなければ拒む。
    assert.throws(() => read(later), /freeze commit or bytes differ/);
    // 固定した commit を指しても bytes が凍結と違えば拒む。
    assert.throws(
      () => read(changed, { ...freeze, freezeCommit: changed }),
      /freeze commit or bytes differ/,
    );
    assert.throws(() => read(changed), /freeze commit or bytes differ/);
    assert.throws(() => read(removed), /cannot be read/);
    assert.throws(() => read(undefined), /not given/);
    // 固定前の性質（fail closed）: freezeCommit が null なら何も読まずに止まる。
    assert.throws(
      () => read(freezeCommit, { ...freeze, freezeCommit: null }),
      /\[precheck\] the K6\/4 freeze commit is not pinned/,
    );
    // 製品の既定（K64_FREEZE）は一時 repo の凍結を受け付けない。
    assert.throws(
      () => readK64FreezeHead({ root: repo, commit: freezeCommit }),
      /freeze commit or bytes differ/,
    );
    assert.throws(
      () => readK64FreezeHead({ root: repo, commit: K64_FREEZE.freezeCommit }),
      new RegExp(K64_FREEZE.freezeCommit),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("§15.8: 凍結した fixture の path の試走は製品の .node で、評価の .node を拒む", () => {
  const product = productReceipt();
  const evaluation = evalReceipt();
  const fixtures = [{ path: FIXTURE, sha256: FROZEN_FIXTURE_SHA256[FIXTURE] }];
  const dry = admitFrozenDryRun({
    fixtures,
    nativeSha256: product.artifacts[PRODUCT_NODE],
    productReceipt: product,
    evalReceipt: evaluation,
  });
  assert.equal(dry.graphArm, "not-activated");
  assert.throws(
    () =>
      admitFrozenDryRun({
        fixtures,
        nativeSha256:
          evaluation.artifacts[".artifacts/cp4/eval-build/grimodex-node.node"],
        productReceipt: product,
        evalReceipt: evaluation,
      }),
    /product \.node/,
  );
  assert.throws(
    () =>
      admitFrozenDryRun({
        fixtures,
        nativeSha256: product.artifacts[PRODUCT_NODE],
        productReceipt: evaluation,
        evalReceipt: evaluation,
      }),
    /\[precheck\]/,
  );
});

test("P2-7: receipt の先頭の observationPrep を git の facts と freeze record で照合する", async () => {
  const { repo, base, prep, head } = await preparedRepository();
  try {
    const facts = collectObservationPrepFacts({
      root: repo,
      commit: prep,
      candidateHead: head,
    });
    const receipt = (observationPrep, commitSha = head) => ({
      head: {
        k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
        k64: { freezeCommit: H40("4"), sha256: K64_FREEZE.sha256 },
        observationPrep,
      },
      candidate: { commit: commitSha },
    });
    assert.throws(
      () =>
        assertReceiptHeadBound({
          root: repo,
          receipt: receipt({ commit: prep, freezeRecordSha256: H64("0") }),
        }),
      /freezeRecordSha256/,
    );
    assert.throws(
      () =>
        assertReceiptHeadBound({
          root: repo,
          receipt: receipt(
            { commit: prep, freezeRecordSha256: facts.recordSha256AtCommit },
            base,
          ),
        }),
      /not an ancestor/,
    );
    // D-1: a recorded 批准 5 is re-collected from git for the candidate and
    // must be the same; a self-reported `ancestor: true` is refused.
    const forged = receipt({
      commit: prep,
      freezeRecordSha256: facts.recordSha256AtCommit,
    });
    const collected = JSON.parse(
      JSON.stringify(
        collectRatification5Evidence({ root: repo, candidateHead: head }),
      ),
    );
    forged.candidate.ratification5 = {
      ...collected,
      dPrime: { ...collected.dPrime, ancestor: true },
    };
    assert.throws(
      () => assertReceiptHeadBound({ root: repo, receipt: forged }),
      /ratification5/,
    );
    forged.candidate.ratification5 = collected;
    assert.throws(
      () => assertReceiptHeadBound({ root: repo, receipt: forged }),
      new RegExp(K62_FREEZE.commit),
    );
    // P2-4: a re-collection handed in must be sealed, of this candidate and
    // the same as the record.
    for (const [ratification5, pattern] of [
      [collected, /sealed evidence/],
      [
        collectRatification5Evidence({ root: repo, candidateHead: base }),
        /another candidate head/,
      ],
      [
        collectRatification5Evidence({ root: repo, candidateHead: head }),
        new RegExp(K62_FREEZE.commit),
      ],
    ])
      assert.throws(
        () =>
          assertReceiptHeadBound({
            root: repo,
            receipt: forged,
            ratification5,
          }),
        pattern,
      );
    // A keep-test record is not re-run here (sync); it needs the sealed
    // re-collection of rebindRatification5.
    const keepRecord = receipt({
      commit: prep,
      freezeRecordSha256: facts.recordSha256AtCommit,
    });
    keepRecord.candidate.ratification5 = {
      ...collected,
      rsJoinHook: { evidence: "candidate-test" },
    };
    assert.throws(
      () => assertReceiptHeadBound({ root: repo, receipt: keepRecord }),
      /rebindRatification5/,
    );
    // The bound head passes the prep checks and stops at the K6/2 freeze,
    // which this temp repository does not hold.
    assert.throws(
      () =>
        assertReceiptHeadBound({
          root: repo,
          receipt: receipt({
            commit: prep,
            freezeRecordSha256: facts.recordSha256AtCommit,
          }),
        }),
      new RegExp(K62_FREEZE.commit),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("D-1／E-1: 批准 5 は git から集めて封印し、(b) の候補の試験の経路は collector が試験を走らせるまで K6/2（fail closed）", async () => {
  const evidence = collectRatification5Evidence({
    root: ROOT,
    candidateHead: "HEAD",
  });
  assert.equal(evidence.kind, "ratification5");
  assert.ok(Object.isFrozen(evidence.dPrime));
  assert.equal(evidence.testOnly, undefined);
  assert.equal(evidence.dPrime.ancestor, true);
  assert.equal(evidence.wfWindow.ancestor, true);
  // (b) は hook の commit の祖先だけ。squash で祖先でないので、この repository の候補は K6/2。
  assert.deepEqual(evidence.rsJoinHook, {
    evidence: "ancestor",
    commit: "c7b091dadabac6cc098a932052cf817493205204",
    ancestor: false,
  });
  assert.deepEqual(assessCandidateRegime(evidence, evidence.candidateHead), {
    regime: "k62",
    missing: ["b:rs-join-hook"],
  });
  // E-1: 呼出し側の渡す試験の receipt（手書きの JSON）は受け付けない。
  assert.throws(
    () =>
      collectRatification5Evidence({
        root: ROOT,
        candidateHead: "HEAD",
        rsJoinTestReceiptPath: "/tmp/receipt.json",
      }),
    /unsupported option rsJoinTestReceiptPath/,
  );
  for (const entry of [admitGraphCaseRun, assertReceiptHeadBound])
    assert.throws(
      () => entry({ root: ROOT, rsJoinTestReceiptPath: "/tmp/r.json" }),
      /unsupported option rsJoinTestReceiptPath/,
    );
  // 写し（JSON の往復や手書き）は封印が無いので緩和を当てない（N31 の迂回を閉じる）。
  const forged = {
    ...JSON.parse(JSON.stringify(evidence)),
    rsJoinHook: {
      evidence: "candidate-test",
      testFile:
        "src/features/related-scenes/useNir1RelatedScenes.graphReadyKeep.test.tsx",
      passed: true,
    },
  };
  assert.deepEqual(assessCandidateRegime(forged), {
    regime: "k62",
    missing: ["ratification5-not-collected"],
  });
  // 試験専用の封印（test-support の ratification5）は testOnly と書かれ、K6/4 の判定の試験にだけ使う。
  const testOnly = ratification5();
  assert.equal(testOnly.testOnly, true);
  assert.equal(
    assessCandidateRegime(testOnly, testOnly.candidateHead).regime,
    "k64",
  );
  assert.equal(
    assessCandidateRegime(testOnly, testOnly.candidateHead).testOnly,
    true,
  );
  // 試験専用の sealer は一度しか取れない（本番の module が先に取れば test-support が読み込めない）。
  assert.throws(() => claimTestEvidenceSealer(), /already claimed/);
  // D′ と W_f を含まない候補（その commit が無い repository）は (a)(c) を欠く。
  const { repo } = await repository();
  try {
    const bare = collectRatification5Evidence({
      root: repo,
      candidateHead: "HEAD",
    });
    assert.equal(bare.dPrime.ancestor, false);
    assert.equal(bare.wfWindow.ancestor, false);
    assert.equal(assessCandidateRegime(bare, bare.candidateHead).regime, "k62");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("S1f: 集計の前に、receipt の手順のファイルを commit から読み直して settings.k64 と照合する", async () => {
  const { repo } = await repository();
  try {
    const draft = JSON.parse(
      await readFile(
        path.join(ROOT, procedureFilePath(DEV_DRAFT_PROCEDURE_VERSION)),
        "utf8",
      ),
    );
    const reviewed = {
      ...draft,
      version: "v1",
      draft: false,
      review: {
        reviewer: "synthetic-reviewer",
        reviewedAt: "2026-10-27",
        record: "synthetic",
      },
    };
    await put(repo, procedureFilePath("v1"), `${JSON.stringify(reviewed)}\n`);
    await put(repo, procedureFilePath("draft-1"), `${JSON.stringify(draft)}\n`);
    commit(repo, "procedure");
    const loaded = loadProcedureFile({
      root: repo,
      version: "v1",
      commit: "HEAD",
      purpose: "formal",
    });
    const receipt = (k64) => ({ settings: { k64 } });
    const bound = assertProcedureBound({
      root: repo,
      receipt: receipt(procedureSettings(loaded)),
    });
    assert.equal(bound.sha256, loaded.sha256);
    const settings = procedureSettings(loaded);
    for (const k64 of [
      { ...settings, r1r4WaitMs: 9_000 },
      {
        ...settings,
        procedureFile: { ...settings.procedureFile, sha256: H64("0") },
      },
    ])
      assert.throws(
        () => assertProcedureBound({ root: repo, receipt: receipt(k64) }),
        /版の食い違い/,
      );
    // draft の版は正式の receipt の手順のファイルにならない。
    assert.throws(
      () =>
        assertProcedureBound({
          root: repo,
          receipt: receipt({
            ...settings,
            procedureFile: {
              ...settings.procedureFile,
              version: "draft-1",
              path: procedureFilePath("draft-1"),
            },
          }),
        }),
      /draft/,
    );
    assert.throws(
      () => assertProcedureBound({ root: repo, receipt: receipt(null) }),
      /procedureFile/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("S1f 批准 5 (b): collector が候補の clean な worktree で keep test を走らせ、pass を封印する。落ちれば hook の祖先だけ（K6/2）", async () => {
  const { repo, head, mode } = await keepTestCandidate();
  try {
    const collect = () =>
      collectRatification5EvidenceWithKeepTest({
        root: repo,
        candidateHead: head,
        keepTestWorktree: repo,
      });
    // P2-4: 同期の collector は keep test を走らせない（async の入口だけ）。
    assert.throws(
      () =>
        collectRatification5Evidence({
          root: repo,
          candidateHead: head,
          keepTestWorktree: repo,
        }),
      /collectRatification5EvidenceWithKeepTest/,
    );
    const passed = await collect();
    assert.equal(isCollectedFacts(passed), true);
    assert.equal(passed.testOnly, undefined);
    assert.equal(passed.rsJoinHook.evidence, "candidate-test");
    assert.equal(passed.rsJoinHook.head, head);
    assert.equal(passed.rsJoinHook.passed, true);
    assert.equal(
      passed.rsJoinHook.testFile,
      K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest,
    );
    assert.match(passed.rsJoinHook.testFileSha256, /^[0-9a-f]{64}$/u);
    assert.match(passed.rsJoinHook.runDigest, /^[0-9a-f]{64}$/u);
    assert.equal(passed.rsJoinHook.tests, 2);
    // P2-4 (a): 走った install（lock の sha256 と vitest の版）を封印に残す。
    assert.deepEqual(
      JSON.parse(JSON.stringify(passed.rsJoinHook.dependencies)),
      {
        lockfileSha256: passed.rsJoinHook.dependencies.lockfileSha256,
        installedLockSha256: passed.rsJoinHook.dependencies.lockfileSha256,
        vitestVersion: "4.1.12",
        lockedVitestVersion: "4.1.12",
      },
    );
    assert.match(
      passed.rsJoinHook.dependencies.lockfileSha256,
      /^[0-9a-f]{64}$/u,
    );
    // (a)(c) の commit が無い一時の repository なので K6/2 だが、(b) は欠けない。
    assert.deepEqual(assessCandidateRegime(passed, head).missing, [
      "a:d-prime",
      "c:w-f-window",
    ]);
    assert.ok(
      assessCandidateRegime(passed, H40("0")).missing.includes(
        "ratification5-other-candidate",
      ),
    );
    // 集め直しても同じ（digest は時刻を含まない）。
    assert.equal(JSON.stringify(await collect()), JSON.stringify(passed));
    // 写しは封印が無い。
    assert.deepEqual(
      assessCandidateRegime(JSON.parse(JSON.stringify(passed)), head).missing,
      ["ratification5-not-collected"],
    );
    // 落ちた・0 件の試験は (b) を満たさず、hook の commit の祖先だけで判定する。
    for (const [value, reason] of [
      [{ kind: "report", assertions: [["a", "failed"]] }, "failed"],
      [{ kind: "report", assertions: [] }, "no-tests"],
    ]) {
      await mode(value);
      const refused = await collect();
      assert.deepEqual(JSON.parse(JSON.stringify(refused.rsJoinHook)), {
        evidence: "ancestor",
        commit: K64_CANDIDATE_REQUIREMENTS.rsJoinHookCommit,
        ancestor: false,
        keepTest: { status: "refused", reason },
      });
      assert.ok(
        assessCandidateRegime(refused, head).missing.includes("b:rs-join-hook"),
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("S1f 批准 5 (b): 集計の前の照合は、記録が candidate-test なら worktree で keep test を走らせ直す", async () => {
  const { repo, head, mode } = await keepTestCandidate();
  try {
    const sealed = await collectRatification5EvidenceWithKeepTest({
      root: repo,
      candidateHead: head,
      keepTestWorktree: repo,
    });
    const recorded = JSON.parse(JSON.stringify(sealed));
    const receipt = { candidate: { commit: head, ratification5: recorded } };
    await assert.rejects(
      () => rebindRatification5({ root: repo, receipt }),
      /keepTestWorktree/,
    );
    const rebound = await rebindRatification5({
      root: repo,
      receipt,
      keepTestWorktree: repo,
    });
    assert.equal(isCollectedFacts(rebound), true);
    assert.equal(rebound.rsJoinHook.evidence, "candidate-test");
    // P2-4: assertReceiptHeadBound（同期）は keep test を走らせない。
    // candidate-test の記録には rebindRatification5 の封印を渡す。
    const head1 = {
      observationPrep: { commit: head },
    };
    assert.throws(
      () =>
        assertReceiptHeadBound({
          root: repo,
          receipt: { ...receipt, head: head1 },
          keepTestWorktree: repo,
        }),
      /unsupported option keepTestWorktree/,
    );
    await mode({ kind: "report", assertions: [["a", "failed"]] });
    await assert.rejects(
      () =>
        rebindRatification5({ root: repo, receipt, keepTestWorktree: repo }),
      /ratification5 differs/,
    );
    assert.equal(
      await rebindRatification5({
        root: repo,
        receipt: { candidate: { commit: head } },
      }),
      null,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P2-2: 試験用の sealer は node の試験の process の外では取れない（本番の node から自作の批准 5 を封印できない）", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const script = `
    import(${JSON.stringify(path.join(import.meta.dirname, "admission-facts.mjs"))}).then((m) => {
      try { m.claimTestEvidenceSealer(); console.log("CLAIMED"); }
      catch (error) { console.log("REFUSED " + error.message); }
    });`;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env,
      encoding: "utf8",
    },
  );
  assert.match(out, /^REFUSED \[precheck\].*node --test/mu);
});

test("P2-2: 試験の run の中で封印した試験専用の証拠も、その外（試験の context が無い）では K6/2 のまま", () => {
  const script = `
    const facts = await import(${JSON.stringify(path.join(import.meta.dirname, "admission-facts.mjs"))});
    const { assessCandidateRegime } = await import(${JSON.stringify(path.join(import.meta.dirname, "followup.mjs"))});
    const seal = facts.claimTestEvidenceSealer();
    const head = "${"a".repeat(40)}";
    const evidence = seal({ kind: "ratification5", candidateHead: head });
    const inside = assessCandidateRegime(evidence, head).missing;
    delete process.env.NODE_TEST_CONTEXT;
    const outside = assessCandidateRegime(evidence, head).missing;
    console.log(JSON.stringify({ inside, outside }));`;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
      encoding: "utf8",
    },
  );
  const { inside, outside } = JSON.parse(out.trim().split("\n").at(-1));
  assert.ok(!inside.includes("ratification5-test-only-outside-tests"));
  assert.deepEqual(outside, ["ratification5-test-only-outside-tests"]);
});

// ---- S4 の予行（DR-CP4-S4-1）-------------------------------------------------
// S4a → S4b → 候補の合成の repository（test-support の s4RehearsalRepository）で、
// 正式の入口が S4 の記録を読む流れを通しで確かめる。契約の freeze record
// （object の boundFiles）と S2 の observation-prep（配列の boundFiles、
// diagnosticRuns、samplePlan、traces）は別の file で、S2 の file は freeze
// record の束縛の sha256 と照合してから読む。

const S2_PREP = S4_REHEARSAL_FILES.prep;

test("DR-CP4-S4-1 予行: freeze record は S2 の plan ではない（修正前の入口はここで止まった）", () => {
  const r = s4RehearsalRepository();
  try {
    const facts = collectObservationPrepFacts({
      root: r.repo,
      commit: r.s4b,
      candidateHead: r.head,
    });
    // The contract admits the freeze record itself.
    assert.equal(assertObservationPrepAdmits(facts, r.head), facts);
    assert.equal(facts.headFileSha256[S2_PREP], r.prepSha256);
    // The S5-B entries read `collectObservationPrepFacts(...).record` as if
    // it were S2's file: SP-P4 (diagnostic-runner) and the trace stop.
    assert.throws(
      () => readDiagnosticPlan(facts.record),
      /\[precheck\].*diagnosticRuns is missing/u,
    );
    assert.throws(
      () => readTraceDeclaration({ root: r.repo, record: facts.record }),
      /\[precheck\].*not in the observation-prep boundFiles/u,
    );
    assert.deepEqual(
      readTraceFileHeads({ root: r.repo, traces: facts.record.traces }),
      [],
    );
  } finally {
    r.cleanup();
  }
});

test("DR-CP4-S4-1 予行: S4a→S4b の記録を、admission → S2 の検証つき読取 → 診断の plan → trace の先頭と宣言 → A の S2 → 入口の関数の順に通る", () => {
  const r = s4RehearsalRepository();
  try {
    // 1. The contract's facts and admission (unchanged).
    const facts = collectObservationPrepFacts({
      root: r.repo,
      commit: r.s4b,
      candidateHead: r.head,
    });
    assertObservationPrepAdmits(facts, r.head);
    assert.equal(facts.recordIntroducedByCommit, true);
    assert.equal(facts.onRemoteRef, true);
    // 2. S2's file, read as the candidate head's blob and bound by sha256.
    const prep = readAdmittedObservationPrep({
      root: r.repo,
      prepCommit: r.s4b,
      candidateHead: r.head,
    });
    assert.equal(prep.path, OBSERVATION_PREP_S2_PATH);
    assert.equal(prep.path, S2_PREP);
    assert.equal(prep.commit, r.head);
    assert.equal(prep.sha256, r.prepSha256);
    assert.equal(prep.sha256, facts.record.boundFiles[S2_PREP]);
    assert.equal(prep.facts.commit, r.s4b);
    assert.ok(Array.isArray(prep.value.boundFiles));
    // 3. The diagnostics' plan (S5-B) from S2's file.
    const plan = readDiagnosticPlan(prep.value);
    assert.equal(plan.spP4.warmup, 5);
    assert.equal(plan.spP4.measured, 30);
    assert.equal(plan.spP4.variants.length, 8);
    // 4. The trace heads (S2 `traces`, at the S4a commit) and the receipt head.
    const traces = readTraceFileHeads({
      root: r.repo,
      traces: prep.value.traces,
    });
    assert.deepEqual(
      traces.map((row) => [row.kind, row.commit]),
      [
        ["editing", r.s4a],
        ["browsing", r.s4a],
      ],
    );
    const head = buildRunHead({
      kind: "sp-p4",
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      k64: { freezeCommit: r.k64Freeze.freezeCommit, sha256: H64("4") },
      observationPrep: {
        commit: facts.commit,
        freezeRecordSha256: facts.recordSha256AtCommit,
      },
      traces,
    });
    assert.equal(head.traces.length, 2);
    // 5. The trace's declaration and the other bound files (S2's array).
    const declaration = readTraceDeclaration({
      root: r.repo,
      record: prep.value,
    });
    assert.equal(declaration.sceneId, S4_REHEARSAL_G02_DECLARED);
    assert.equal(declaration.addendum.commit, r.s4a);
    assert.equal(
      declaration.addendum.sha256,
      facts.record.boundFiles[S4_REHEARSAL_FILES.declarationAddendum],
    );
    assert.equal(
      readBoundFile({
        root: r.repo,
        record: prep.value,
        file: S4_REHEARSAL_FILES.setupAddendum,
      }).sha256,
      r.digests[S4_REHEARSAL_FILES.setupAddendum],
    );
    // 6. A (S5-A): the S2 files at the S4 commit, bound the same way.
    const calls = [];
    const formal = admitFormalK64Run(
      {
        root: r.repo,
        candidate: r.head,
        prepCommit: r.s4b,
        k62Commit: K62_FREEZE.commit,
        k64Commit: r.k64Freeze.freezeCommit,
        buildReceipt: { kind: "eval" },
        productReceipt: { kind: "product" },
        defaultAddonSha256: H64("0"),
      },
      {
        freeze: r.k64Freeze,
        admitGraphCase: (value) => {
          calls.push(value);
          return Object.freeze({ stub: true });
        },
      },
    );
    assert.equal(formal.s2.files.observationPrep.sha256, r.prepSha256);
    assert.deepEqual(
      formal.s2.files.observationPrep.value.samplePlan,
      prep.value.samplePlan,
    );
    for (const name of ["declarationAddendum", "g01Addendum"])
      assert.equal(
        formal.s2.files[name].sha256,
        facts.record.boundFiles[formal.s2.files[name].path],
      );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prepCommit, r.s4b);
    // 7. The SP-P4 runner's entry (diagnostic-runner, without main).
    const entry = readFrozenSpP4Plan({
      root: r.repo,
      prepCommit: r.s4b,
      candidateHead: r.head,
    });
    assert.equal(entry.prep.sha256, r.prepSha256);
    assert.deepEqual(entry.plan, plan);
    // The admission is for the same S4 commit and candidate head.
    const admitted = {
      candidateHead: r.head,
      head: { observationPrep: { commit: r.s4b } },
    };
    assert.equal(
      assertPrepForAdmission({ prep: entry.prep, admission: admitted }),
      entry.prep,
    );
    for (const other of [
      { ...admitted, candidateHead: r.s4b },
      { ...admitted, head: { observationPrep: { commit: r.s4a } } },
    ])
      assert.throws(
        () => assertPrepForAdmission({ prep: entry.prep, admission: other }),
        /\[precheck\].*another pre-observation commit or candidate head/u,
      );
  } finally {
    r.cleanup();
  }
});

test("DR-CP4-S4-1 予行: S2 の file が束縛と違う・束縛に無い・配列と object の取り違え・S2 と freeze record の食い違いは [precheck]", () => {
  const read = (r) => () =>
    readAdmittedObservationPrep({
      root: r.repo,
      prepCommit: r.s4b,
      candidateHead: r.head,
    });
  const cases = [
    // S2's file changed on the candidate after S4b (the freeze record binds
    // the S4b bytes).
    [
      { candidate: { [S2_PREP]: '{"changed":true}\n' } },
      /at the candidate head differs from the record/u,
    ],
    // The freeze record does not bind S2's file.
    [
      {
        freeze: (value) => {
          delete value.boundFiles[S2_PREP];
          return value;
        },
      },
      /does not bind evals\/nir1-graph\/observation-prep\.v1\.json/u,
    ],
    // The freeze record's boundFiles is S2's array (path, commit, sha256).
    [
      {
        freeze: (value, ctx) => ({
          ...value,
          boundFiles: Object.entries(value.boundFiles).map(
            ([file, sha256]) => ({ path: file, commit: ctx.s4a, sha256 }),
          ),
        }),
      },
      /boundFiles must be an object of path → sha256/u,
    ],
    // S2's boundFiles is an object (the freeze record's shape).
    [
      {
        s2: (value) => ({
          ...value,
          boundFiles: Object.fromEntries(
            value.boundFiles.map((row) => [row.path, row.sha256]),
          ),
        }),
      },
      /S2 boundFiles must be the array/u,
    ],
    // S2 binds a file the freeze record does not.
    [
      {
        freeze: (value) => {
          delete value.boundFiles[S4_REHEARSAL_FILES.seedPinAddendum];
          return value;
        },
      },
      /seed-pin-addendum\.v1\.json: S2 and the freeze record bind different bytes/u,
    ],
    // S2's trace row names other bytes than the freeze record binds.
    [
      {
        s2: (value) => {
          value.traces[0] = { ...value.traces[0], sha256: H64("9") };
          return value;
        },
      },
      /trace-editing\.v1\.json: S2 and the freeze record bind different bytes/u,
    ],
    // The freeze record itself is not admitted (observed before freezing).
    [
      {
        freeze: (value) => ({
          ...value,
          graphRuntimeObservedBeforeFreeze: true,
        }),
      },
      /graphRuntimeObservedBeforeFreeze/u,
    ],
    // S2's file is not JSON (bound by its sha256 all the same).
    [{ s2: () => "not json" }, /is not JSON/u],
    // S2 is still the draft, or keeps a placeholder S4b did not fill.
    [
      {
        s2: (value) => ({
          ...value,
          status: "draft-awaiting-s3-review-and-s4-freeze",
        }),
      },
      /is not frozen-before-observation or keeps a placeholder/u,
    ],
    [
      {
        s2: (value) => ({
          ...value,
          placeholders: [{ token: "S4:k64-freeze-commit" }],
        }),
      },
      /is not frozen-before-observation or keeps a placeholder/u,
    ],
    [
      {
        s2: (value) => ({
          ...value,
          contracts: { k64: { freezeCommit: "S4:k64-freeze-commit" } },
        }),
      },
      /is not frozen-before-observation or keeps a placeholder/u,
    ],
  ];
  for (const [options, pattern] of cases) {
    const r = s4RehearsalRepository(options);
    try {
      assert.throws(read(r), (error) => {
        assert.match(error.message, /^\[precheck\]/u);
        assert.match(error.message, pattern);
        return true;
      });
      // The entries stop the same way (they use the same reader).
      assert.throws(
        () =>
          readFrozenSpP4Plan({
            root: r.repo,
            prepCommit: r.s4b,
            candidateHead: r.head,
          }),
        pattern,
      );
    } finally {
      r.cleanup();
    }
  }
});

test("DR-CP4-S4-1: 検証つき読取は admission.mjs が集めた facts だけを受け、freeze record の束縛の sha256 と blob を照合する", () => {
  const r = s4RehearsalRepository();
  try {
    const facts = collectObservationPrepFacts({
      root: r.repo,
      commit: r.s4b,
      candidateHead: r.head,
    });
    const bound = readFreezeBoundFile({
      root: r.repo,
      facts,
      file: S4_REHEARSAL_FILES.traceBrowsing,
    });
    assert.equal(bound.sha256, r.digests[S4_REHEARSAL_FILES.traceBrowsing]);
    assert.equal(
      bound.bytes.toString("utf8"),
      `${JSON.stringify({ rehearsal: "browsing" })}\n`,
    );
    for (const forged of [{ ...facts }, JSON.parse(JSON.stringify(facts))])
      assert.throws(
        () =>
          readFreezeBoundFile({ root: r.repo, facts: forged, file: S2_PREP }),
        /\[precheck\].*collected/u,
      );
    assert.throws(
      () => readFreezeBoundFile({ root: r.repo, facts, file: "candidate.txt" }),
      /\[precheck\].*does not bind candidate\.txt/u,
    );
    // An inherited key (`toString`) is not a binding.
    assert.throws(
      () => readFreezeBoundFile({ root: r.repo, facts, file: "toString" }),
      /\[precheck\].*does not bind toString/u,
    );
    assert.throws(
      () =>
        readAdmittedObservationPrep({
          root: r.repo,
          prepCommit: r.s4b,
          candidateHead: r.head,
          file: "candidate.txt",
        }),
      /unsupported option/u,
    );
  } finally {
    r.cleanup();
  }
});

test("DR-CP4-S4-1: 配列の boundFiles は添字を束縛にしない（集める側と契約の両方）", () => {
  // A file named "0" whose sha256 is the array's only element: an array read
  // with Object.keys would bind it (the contract's per-entry check passes).
  const zero = "zero\n";
  const zeroSha = createHash("sha256").update(zero).digest("hex");
  const r = s4RehearsalRepository({
    s4b: { 0: zero },
    freeze: (value) => ({ ...value, boundFiles: [zeroSha] }),
  });
  try {
    const facts = collectObservationPrepFacts({
      root: r.repo,
      commit: r.s4b,
      candidateHead: r.head,
    });
    assert.equal(Object.hasOwn(facts.headFileSha256, "0"), false);
    assert.throws(
      () => assertObservationPrepAdmits(facts, r.head),
      /boundFiles must be an object of path → sha256/u,
    );
    // The contract alone, with the head digests an index read would collect.
    const errors = observationPrepRecordErrors(
      { ...r.freezeValue },
      { 0: zeroSha, ...facts.headFileSha256 },
    );
    assert.ok(
      errors.some((row) => /object of path → sha256/u.test(row)),
      errors.join("; "),
    );
  } finally {
    r.cleanup();
  }
});
