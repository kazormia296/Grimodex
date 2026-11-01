// B2a の宣言の addendum v2 と validator の変異試験（メモリ上だけ。repo は書かない）。
// 使い方: node mutate-b2a.mjs <worktree>
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const mod = await import(
  pathToFileURL(path.join(root, "scripts/quality/nir1-graph/observation-prep.mjs"))
);
const { declarationAddendumErrors, loadObservationPrepContext } = mod;
const ctx = await loadObservationPrepContext({ repoRoot: root });
const base = ctx.parsed.declarationAddendum;
const clone = (v) => JSON.parse(JSON.stringify(v));
const g04 = (a) => a.declarations.find((r) => r.caseId === "G-04");
const g02 = (a) => a.declarations.find((r) => r.caseId === "G-02");

const results = [];
function run(name, mutate, mutateCtx) {
  const a = clone(base);
  mutate(a);
  let c = ctx;
  if (mutateCtx) {
    c = { ...ctx, freeze: { ...ctx.freeze, json: clone(ctx.freeze.json) } };
    if (ctx.supersededDeclarationAddendum)
      c.supersededDeclarationAddendum = clone(ctx.supersededDeclarationAddendum);
    c.fixtures = Object.fromEntries(
      Object.entries(ctx.fixtures).map(([k, v]) => [k, { ...v, json: clone(v.json) }]),
    );
    mutateCtx(c);
  }
  const errors = declarationAddendumErrors(a, c);
  results.push({ name, caught: errors.length > 0, errors });
}

run("M0 無変異（通るべき）", () => {});
run("M1 G-04 の reading の scene 20→30", (a) => (g04(a).readingOrder.scene = 30));
run("M2 G-04 の reading の query 100→90", (a) => (g04(a).readingOrder.query = 90));
run("M3 G-04 の excerpt の end 211→210", (a) => (g04(a).expectedExcerpt.end = 210));
run("M4 G-04 の excerpt の start 0→1", (a) => (g04(a).expectedExcerpt.start = 1));
run("M5 G-04 の sceneId を g04-lio-market に", (a) => {
  g04(a).sceneId = "g04-lio-market";
  g04(a).expectedExcerpt.sceneId = "g04-lio-market";
});
run("M6 G-04 の vetoRecords に 1 件", (a) => (g04(a).vetoRecords = ["x"]));
run("M7 G-04 の行を消す", (a) => (a.declarations = a.declarations.filter((r) => r.caseId !== "G-04")));
run("M8 userConfirmation.commit を消す", (a) => delete a.contractScopeExtension.userConfirmation.commit);
run("M9 userConfirmation を丸ごと消す", (a) => delete a.contractScopeExtension.userConfirmation);
run("M10 userConfirmation.sha256 を変える", (a) => (a.contractScopeExtension.userConfirmation.sha256 = "0".repeat(64)));
run("M11 userConfirmation.record を変える", (a) => (a.contractScopeExtension.userConfirmation.record = "x.md"));
run("M12 contractScopeExtension を消す", (a) => delete a.contractScopeExtension);
run("M13 拡張の variants に G-02/base を足す", (a) => a.contractScopeExtension.variants.push("G-02/base"));
run("M14 拡張の variants を空に", (a) => (a.contractScopeExtension.variants = []));
run("M15 decision を DR-CP4-G4-9 に", (a) => (a.contractScopeExtension.decision = "DR-CP4-G4-9"));
run("M16 rule を空に", (a) => (a.contractScopeExtension.rule = " "));
run("M17 question を 2 に（検査されるか）", (a) => (a.contractScopeExtension.userConfirmation.question = 2));
run("M18 answer を消す（検査されるか）", (a) => delete a.contractScopeExtension.userConfirmation.answer);
run("M19 graphRuntimeObservedBeforeAuthoring を false に", (a) => (a.graphRuntimeObservedBeforeAuthoring = false));
run("M20 postObservationDeclarations を消す", (a) => delete a.postObservationDeclarations);
run("M21 postObservationDeclarations.variants に G-02/base を足す", (a) => a.postObservationDeclarations.variants.push("G-02/base"));
run("M22 postObservationDeclarations.rule を空に", (a) => (a.postObservationDeclarations.rule = ""));
run("M23 supersedes.sha256 を変える", (a) => (a.supersedes.sha256 = "0".repeat(64)));
run("M24 supersedes を消す", (a) => delete a.supersedes);
run("M25 supersedes.commit を短く", (a) => (a.supersedes.commit = "cf1c83e3"));
run("M26 v1 の行（G-02）の end 78→77", (a) => (g02(a).expectedExcerpt.end = 77));
run("M27 v1 の行（G-02）の vetoNote の文を変える", (a) => (g02(a).vetoNote = "変更"));
run("M28 v1 の負例 K24-G02-N1 の expectation の文を変える", (a) => (a.diagnosticNegatives[0].expectation = "変更"));
run("M29 K24-G04-N1 を消す", (a) => (a.diagnosticNegatives = a.diagnosticNegatives.filter((r) => r.id !== "K24-G04-N1")));
run("M30 K24-G04-N1 の countsInCaseJudgement を true に", (a) => (a.diagnosticNegatives.find((r) => r.id === "K24-G04-N1").countsInCaseJudgement = true));
run("M31 K24-G04-N1 の declare を true に", (a) => (a.diagnosticNegatives.find((r) => r.id === "K24-G04-N1").declare = true));
run("M32 K24-G04-N1 の variantId を other に", (a) => (a.diagnosticNegatives.find((r) => r.id === "K24-G04-N1").variantId = "other"));
run("M33 references.fixtures.G-04 を v1 の path／sha256 に", (a) => (a.references.fixtures["G-04"] = { path: "evals/nir1-graph/g04-scope-exact-unknown.v1.json", fixtureId: "nir1-g04-scope-exact-unknown/1", sha256: "4d002261" + "0".repeat(56) }));
run("M34 references.fixtures に G-03 を余分に足す", (a) => (a.references.fixtures["G-03"] = { ...a.references.fixtures["G-02"] }));
run("M35 references.graphCaseFreeze を freeze.v1 に", (a) => (a.references.graphCaseFreeze = { path: "evals/nir1-graph/freeze.v1.json", sha256: "6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7" }));
run("M36 variantsWithoutDeclaration に G-04/base を戻す", (a) => a.variantsWithoutDeclaration.variants.splice(2, 0, "G-04/base"));
run("M37 declarationValues.reveal を secret に", (a) => (a.declarationValues.reveal = "secret"));
run("M38 status を frozen に（review null のまま）", (a) => (a.status = "frozen-after-independent-review"));
// ctx の変異（validator の入力側）
run("C1 v1 の addendum の bytes が変わった（sha 不一致）", () => {}, (c) => (c.supersededDeclarationAddendum = { ...c.supersededDeclarationAddendum, sha256: "1".repeat(64) }));
run("C2 v1 の addendum が読めない", () => {}, (c) => (c.supersededDeclarationAddendum = null));
run("C3 freeze が G-04 を postObservationRevisions に持たない", () => {}, (c) => (c.freeze.json.postObservationRevisions = []));
run("C4 freeze の graphRuntimeObservedBeforeFreeze を false に", () => {}, (c) => (c.freeze.json.graphRuntimeObservedBeforeFreeze = false));
run("C5 freeze が G-02 も作り直したと書く＋G-02 の行の vetoNote を変える", (a) => (g02(a).vetoNote = "変更"), (c) => c.freeze.json.postObservationRevisions.push({ caseId: "G-02" }));
run("C6 fixture v2 の g04-lio-landing の本文を 1 文字縮める（ctx）", () => {}, (c) => {
  const s = c.fixtures["G-04"].json.scenes.find((x) => x.id === "g04-lio-landing");
  s.body = s.body.slice(0, -1);
});
run("C7 fixture v2 の g04-lio-landing に POV を付ける（ctx）", () => {}, (c) => {
  c.fixtures["G-04"].json.scenes.find((x) => x.id === "g04-lio-landing").pov = "g04-bren";
});
run("C8 fixture v2 に secret の foreshadow（payoff=g04-lio-landing）を足す（ctx）", () => {}, (c) => {
  c.fixtures["G-04"].json.foreshadows.push({ id: "fs", secret: true, payoffSceneId: "g04-lio-landing" });
});
run("C9 fixture v2 の g04-lio-landing の A1 を unknown にする（ctx）", () => {}, (c) => {
  c.fixtures["G-04"].json.scope.overrides["g04-lio-landing"] = { marker: "unknown" };
});
run("C10 fixture v2 の appendedSceneId を消す（ctx）", () => {}, (c) => {
  const v = c.fixtures["G-04"].json.variants.find((x) => x.id === "base");
  v.expectations.arms.rPlusIrPlusGraph.appendedSceneId = null;
});

for (const r of results)
  console.log(`${r.caught ? "落ちる" : "通る  "} | ${r.name}${r.caught ? " | " + r.errors[0].slice(0, 150) : ""}`);
