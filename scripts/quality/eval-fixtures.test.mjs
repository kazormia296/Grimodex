import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHeavyEvaluationReport,
  evaluateFixtureContracts,
  loadQualityModel,
  validateQualityModel,
} from "./eval-fixtures.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("the checked-in light corpus contains 20-30 isolated, traceable cases", async () => {
  const model = await loadQualityModel({ repoRoot });
  const validation = await validateQualityModel(model, { repoRoot });

  assert.deepEqual(validation.errors, []);
  assert.ok(model.cases.length >= 20 && model.cases.length <= 30);
  assert.equal(
    validation.coveredRequirementIds.length,
    model.requirements.length,
  );
  assert.deepEqual(validation.failureClasses, [
    "routing",
    "precheck",
    "tool",
    "policy",
    "quality",
    "artifact",
  ]);

  const stateKeys = model.cases.flatMap((evaluationCase) =>
    Object.values(evaluationCase.fixture.state),
  );
  assert.equal(new Set(stateKeys).size, stateKeys.length);
});

test("fixture contract evaluation checks real tool schemas and policy metadata", async () => {
  const model = await loadQualityModel({ repoRoot });
  const report = evaluateFixtureContracts(model);

  assert.equal(report.failed, 0);
  assert.equal(report.passed, model.cases.length);
  assert.ok(report.results.every((result) => result.status === "passed"));
});

test("shared state and unknown requirement IDs are rejected", async () => {
  const model = await loadQualityModel({ repoRoot });
  const invalid = structuredClone(model);
  invalid.cases[1].fixture.state.workspaceId =
    invalid.cases[0].fixture.state.workspaceId;
  invalid.cases[1].requirementIds.push("GDX-UNKNOWN-999");

  const validation = await validateQualityModel(invalid, { repoRoot });

  assert.ok(validation.errors.some((error) => /shared state/i.test(error)));
  assert.ok(
    validation.errors.some((error) => /unknown requirement/i.test(error)),
  );
});

test("a required tool without a declared available schema fails the light contract", async () => {
  const model = await loadQualityModel({ repoRoot });
  const invalid = structuredClone(model);
  const target = invalid.cases.find(
    (evaluationCase) => evaluationCase.expected.requiredTools.length > 0,
  );
  assert.ok(target);
  target.fixture.availableTools = [];

  const report = evaluateFixtureContracts(invalid);

  assert.ok(report.failed > 0);
  assert.ok(
    report.results.some((result) =>
      result.findings.some((finding) => finding.code === "missing-tool-schema"),
    ),
  );
});

test("AI data consent blocks are proven only by missing consent and zero provider calls", async () => {
  const model = await loadQualityModel({ repoRoot });
  const target = model.cases.find(
    (evaluationCase) => evaluationCase.id === "eval-ai-data-consent-precheck",
  );
  assert.ok(target);
  assert.equal(target.expected.blockedBy, "consent-missing");
  assert.equal(target.input.consent, "missing");
  assert.equal(target.input.providerCalls, 0);

  const consented = structuredClone(model);
  const consentedTarget = consented.cases.find(
    (evaluationCase) => evaluationCase.id === "eval-ai-data-consent-precheck",
  );
  assert.ok(consentedTarget);
  consentedTarget.input.consent = "accepted";
  const consentedReport = evaluateFixtureContracts(consented);
  assert.ok(
    consentedReport.results
      .find((result) => result.id === "eval-ai-data-consent-precheck")
      ?.findings.some((finding) => finding.code === "unproven-block-condition"),
  );

  const leaked = structuredClone(model);
  const leakedTarget = leaked.cases.find(
    (evaluationCase) => evaluationCase.id === "eval-ai-data-consent-precheck",
  );
  assert.ok(leakedTarget);
  leakedTarget.input.providerCalls = 1;
  const leakedReport = evaluateFixtureContracts(leaked);
  assert.ok(
    leakedReport.results
      .find((result) => result.id === "eval-ai-data-consent-precheck")
      ?.findings.some(
        (finding) => finding.code === "provider-called-before-consent",
      ),
  );
});

test("the Web Editor fixture exposes only a user-selected BYOK route", async () => {
  const model = await loadQualityModel({ repoRoot });
  const target = model.cases.find(
    (evaluationCase) => evaluationCase.id === "eval-ai-data-consent-precheck",
  );

  assert.ok(target);
  assert.equal(target.input.route, "byok");
  assert.equal(target.input.provider, "openai");
  assert.equal(target.input.consent, "missing");
  assert.equal(target.input.providerCalls, 0);
  assert.ok(
    model.cases.every(
      (evaluationCase) =>
        !/(scan|hosted|managed-openrouter)/i.test(
          JSON.stringify(evaluationCase),
        ),
    ),
  );
});

test("heavy evaluations are explicit deferred evidence, never implicit passes", async () => {
  const model = await loadQualityModel({ repoRoot });
  const heavy = buildHeavyEvaluationReport(model);

  assert.ok(heavy.length > 0);
  assert.ok(heavy.every((entry) => entry.status === "deferred"));
  assert.ok(heavy.every((entry) => entry.command.length > 0));
  assert.ok(heavy.every((entry) => entry.reason.length > 0));
});
