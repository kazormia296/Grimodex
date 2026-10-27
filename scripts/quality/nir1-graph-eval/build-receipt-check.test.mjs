// DR-CP4-TR-5: 製品の標準 build の受領書と評価の build の受領書の head を、run の
// 候補（commit と tree）と照合する。照合そのものは既存の
// assertBuildMatchesProductReceipt（DR-CP4-K-5 (3)）を使う。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";
import {
  checkCandidateBuildReceipts,
  checkRunnerBuildReceipts,
} from "./build-receipt-check.mjs";
import { evalReceipt, productReceipt } from "./test-support.mjs";

const FILES = {
  "dist/index.html": "index",
  "dist-electron/main.cjs": "main",
  "dist-electron/preload.cjs": "preload",
  "electron/native/grimodex-node/grimodex-node.node": "node",
};
const digest = (text) => createHash("sha256").update(text).digest("hex");
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), "cp4-tr-build-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

const head = (commit = COMMIT, tree = TREE) => ({
  worktreeClean: true,
  resolvedBaseSha: "c".repeat(40),
  resolvedHeadSha: commit,
  resolvedHeadTreeSha: tree,
  currentHeadSha: commit,
});

function receipts({ product = head(), evaluation = head() } = {}) {
  return {
    productReceiptBytes: Buffer.from(
      JSON.stringify(
        productReceipt({
          candidate: product,
          artifacts: Object.fromEntries(
            Object.entries(FILES).map(([file, text]) => [file, digest(text)]),
          ),
        }),
      ),
    ),
    evalReceiptBytes: Buffer.from(
      JSON.stringify(evalReceipt({ candidate: evaluation })),
    ),
  };
}

test("TR-5: 受領書を渡したとき、標準 build と評価 build の head と tree、4 つの artifact が候補と一致すれば記録を返す", () => {
  const root = scratch();
  const result = checkCandidateBuildReceipts({
    root,
    candidate: { commit: COMMIT, tree: TREE },
    ...receipts(),
  });
  assert.equal(result.checked, true);
  assert.equal(result.productReceiptHead, COMMIT);
  assert.equal(result.productReceiptTree, TREE);
  assert.equal(result.evalReceiptHead, COMMIT);
  assert.equal(result.evalReceiptTree, TREE);
  assert.deepEqual(
    Object.keys(result.artifacts).sort(),
    Object.keys(FILES).sort(),
  );
});

test("TR-5: 標準 build の受領書の commit・tree・artifact の食い違いは既存の照合（S1i build）で止まる", () => {
  const root = scratch();
  for (const [label, input] of [
    ["commit", receipts({ product: head("d".repeat(40)) })],
    ["tree", receipts({ product: head(COMMIT, "d".repeat(40)) })],
  ])
    assert.throws(
      () =>
        checkCandidateBuildReceipts({
          root,
          candidate: { commit: COMMIT, tree: TREE },
          ...input,
        }),
      new RegExp(`\\[precheck\\] S1i build: .*${label}`, "u"),
    );
  writeFileSync(path.join(root, "dist-electron/main.cjs"), "changed");
  assert.throws(
    () =>
      checkCandidateBuildReceipts({
        root,
        candidate: { commit: COMMIT, tree: TREE },
        ...receipts(),
      }),
    /\[precheck\] S1i build: .*dist-electron\/main\.cjs/u,
  );
});

test("TR-5: 評価 build の受領書の head か tree が候補と違えば、または受領書が無ければ止まる", () => {
  const root = scratch();
  for (const [label, evaluation] of [
    ["commit", head("d".repeat(40))],
    ["tree", head(COMMIT, "d".repeat(40))],
  ])
    assert.throws(
      () =>
        checkCandidateBuildReceipts({
          root,
          candidate: { commit: COMMIT, tree: TREE },
          ...receipts({ evaluation }),
        }),
      new RegExp(
        `\\[precheck\\] the evaluation build receipt is not the candidate's: .*${label}`,
        "u",
      ),
    );
  assert.throws(
    () =>
      checkCandidateBuildReceipts({
        root,
        candidate: { commit: COMMIT, tree: TREE },
        productReceiptBytes: receipts().productReceiptBytes,
        evalReceiptBytes: null,
      }),
    /\[precheck\] the evaluation build receipt is missing/u,
  );
  assert.throws(
    () =>
      checkCandidateBuildReceipts({
        root,
        candidate: { commit: COMMIT, tree: TREE },
        productReceiptBytes: Buffer.from("{not json"),
        evalReceiptBytes: receipts().evalReceiptBytes,
      }),
    /\[precheck\] the standard-build receipt is not JSON/u,
  );
});

test("TR-5: 受領書を渡さない dev の予告は照合せず、評価 build の head の一致だけを開示する", () => {
  const root = scratch();
  const { evalReceiptBytes } = receipts({ evaluation: head("d".repeat(40)) });
  const result = checkCandidateBuildReceipts({
    root,
    candidate: { commit: COMMIT, tree: TREE },
    productReceiptBytes: null,
    evalReceiptBytes,
  });
  assert.deepEqual(result, {
    checked: false,
    reason: "no-product-receipt",
    evalReceiptHead: "d".repeat(40),
    evalReceiptHeadMatchesCandidate: false,
  });
});

test("TR-5: runner の入口は --product-receipt と評価 build の directory の eval-build.json を読んで照合する", () => {
  const root = scratch();
  const { productReceiptBytes, evalReceiptBytes } = receipts();
  const evalDir = path.join(root, ".artifacts/cp4/eval-build");
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(path.join(evalDir, "eval-build.json"), evalReceiptBytes);
  writeFileSync(path.join(root, "standard-build.json"), productReceiptBytes);
  const result = checkRunnerBuildReceipts({
    root,
    options: { "product-receipt": path.join(root, "standard-build.json") },
    candidate: { commit: COMMIT, tree: TREE },
    evalDir,
  });
  assert.equal(result.checked, true);
  assert.equal(
    checkRunnerBuildReceipts({
      root,
      options: {},
      candidate: { commit: COMMIT, tree: TREE },
      evalDir,
    }).checked,
    false,
  );
  // 欠けた --product-receipt の path は読めないので止まる。
  assert.throws(
    () =>
      checkRunnerBuildReceipts({
        root,
        options: { "product-receipt": path.join(root, "missing.json") },
        candidate: { commit: COMMIT, tree: TREE },
        evalDir,
      }),
    /\[precheck\] the standard-build receipt cannot be read/u,
  );
});

test("TR-5: runner.mjs と k64-runner.mjs と trace-runner.mjs は起動の前に同じ照合を呼び、結果を checks.productBuild に書く", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const [file, launchCall] of [
    ["runner.mjs", "startSession({"],
    ["k64-runner.mjs", "session = await launch({"],
    ["trace-runner.mjs", "session = await launch({"],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    // The result is assigned from the call itself (not short-circuited).
    const check = source.search(
      /(?:productBuild|checks\.productBuild) = checkRunnerBuildReceipts\(\{/u,
    );
    assert.ok(check > 0, `${file} calls checkRunnerBuildReceipts`);
    assert.ok(
      check < source.indexOf(launchCall),
      `${file} checks the receipts before the launch`,
    );
    assert.match(source, /checks\.productBuild = /u, file);
  }
});
