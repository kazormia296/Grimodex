// CP-4 TR (DR-CP4-TR-5): the launched build is the one the receipts name.
//
// The standard-build receipt (`--product-receipt`) is checked by the existing
// `assertBuildMatchesProductReceipt` (DR-CP4-K-5 (3): the candidate commit and
// tree, and the four artifacts read back at their paths). The evaluation build
// receipt (`<eval-build>/eval-build.json`) must name the same commit and tree.
// A run that passes no standard-build receipt (a dev preview) is not checked;
// whether the evaluation receipt names the candidate is disclosed only.
//
// runner.mjs, k64-runner.mjs and trace-runner.mjs call this before any launch.

import { readFileSync } from "node:fs";
import path from "node:path";
import { assertBuildMatchesProductReceipt } from "./frozen-setup-driver.mjs";

function parse(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`[precheck] the ${label} receipt is not JSON`);
  }
}

/**
 * `candidate` is `{ commit, tree }` of the run. `productReceiptBytes` /
 * `evalReceiptBytes` are the receipts' bytes or null. Throws `[precheck]`
 * when a receipt names another commit or tree or an artifact differs.
 */
export function checkCandidateBuildReceipts({
  root,
  candidate,
  productReceiptBytes,
  evalReceiptBytes,
  hashFile,
}) {
  const evaluation =
    evalReceiptBytes === null || evalReceiptBytes === undefined
      ? null
      : parse(evalReceiptBytes, "evaluation build");
  const evalHead = evaluation?.candidate?.resolvedHeadSha ?? null;
  const evalTree = evaluation?.candidate?.resolvedHeadTreeSha ?? null;
  if (productReceiptBytes === null || productReceiptBytes === undefined)
    return {
      checked: false,
      reason: "no-product-receipt",
      evalReceiptHead: evalHead,
      evalReceiptHeadMatchesCandidate:
        evaluation === null ? null : evalHead === candidate.commit,
    };
  const productReceipt = parse(productReceiptBytes, "standard-build");
  const build = assertBuildMatchesProductReceipt({
    root,
    candidate,
    productReceipt,
    ...(hashFile ? { hashFile } : {}),
  });
  if (evaluation === null)
    throw new Error(
      "[precheck] the evaluation build receipt is missing (eval-build.json next to the evaluation .node)",
    );
  const problems = [];
  if (evalHead !== candidate.commit)
    problems.push(
      `commit (receipt ${String(evalHead)}, candidate ${String(candidate.commit)})`,
    );
  if (evalTree !== candidate.tree) problems.push("tree");
  if (problems.length > 0)
    throw new Error(
      `[precheck] the evaluation build receipt is not the candidate's: ${problems.join(", ")}`,
    );
  return {
    checked: true,
    productReceiptHead: productReceipt.candidate.resolvedHeadSha,
    productReceiptTree: productReceipt.candidate.resolvedHeadTreeSha,
    evalReceiptHead: evalHead,
    evalReceiptTree: evalTree,
    artifacts: build.artifacts,
  };
}

/** The runners' entry: reads `--product-receipt` and `<evalDir>/eval-build.json`. */
export function checkRunnerBuildReceipts({
  root,
  options,
  candidate,
  evalDir,
}) {
  const read = (file, label, required) => {
    try {
      return readFileSync(file);
    } catch (error) {
      if (!required && error?.code === "ENOENT") return null;
      throw new Error(`[precheck] the ${label} receipt cannot be read`, {
        cause: error,
      });
    }
  };
  return checkCandidateBuildReceipts({
    root,
    candidate: { commit: candidate.commit, tree: candidate.tree },
    productReceiptBytes: options["product-receipt"]
      ? read(path.resolve(options["product-receipt"]), "standard-build", true)
      : null,
    evalReceiptBytes: read(
      path.join(evalDir, "eval-build.json"),
      "evaluation build",
      false,
    ),
  });
}
