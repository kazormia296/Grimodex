// CP-4 S1j-2: the dev shape fixtures copy the frozen G-cases' structure and
// none of their material. The frozen fixtures are read only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEV_SHAPES, planShape, shapeFixture } from "./dev-shape-fixture.mjs";
import {
  SETUP_STOPS,
  loadDevGraphCasePlans,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { REPO_ROOT } from "./test-support.mjs";

const FROZEN = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.complete,
});
const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");

test("dev の形の fixture: 生成のとおりの bytes、variant ごとの plan の構造が凍結した G-case と同じ、凍結した材料の ID と文を含まない", () => {
  for (const [caseId, shape] of Object.entries(DEV_SHAPES)) {
    const source = JSON.parse(read(shape.source));
    const text = read(shape.file);
    assert.equal(
      text,
      `${JSON.stringify(shapeFixture({ caseId, fixture: source }), null, 2)}\n`,
      caseId,
    );
    const plans = loadDevGraphCasePlans({
      root: REPO_ROOT,
      fixturePath: shape.file,
      stopsAt: SETUP_STOPS.complete,
    });
    const frozen = FROZEN.filter((plan) => plan.caseId === caseId);
    assert.deepEqual(
      plans.map((plan) => plan.variantId),
      frozen.map((plan) => plan.variantId),
      caseId,
    );
    for (const plan of plans) {
      assert.equal(plan.fixtureKind, "dev");
      assert.deepEqual(
        planShape(plan),
        planShape(frozen.find((row) => row.variantId === plan.variantId)),
        `${caseId}/${plan.variantId}`,
      );
    }
    // No frozen ID, title or body is in the dev file.
    const material = [
      ...(source.scenes ?? []).flatMap((row) => [row.id, row.title, row.body]),
      source.query.sceneId,
      source.query.body,
      ...(source.entities ?? [source.entitySeed, source.targetEntity]).flatMap(
        (row) => [row.id, row.label, row.summary],
      ),
      ...(source.qualifiedIr ?? []).map((row) => row.summary),
    ];
    for (const value of material)
      assert.ok(!text.includes(`"${value}"`), `${caseId}: ${value}`);
  }
});

test("dev の形の plan の構造が違えば一致しない（planShape は Revision の decision、session、段を見る）", () => {
  const caseId = "G-03";
  const source = JSON.parse(read(DEV_SHAPES[caseId].source));
  const frozen = FROZEN.find(
    (plan) => plan.caseId === caseId && plan.variantId === "base",
  );
  const changed = structuredCloneish(frozen);
  changed.steps.find(
    (step) => step.timelineKind === "revision",
  ).input.decision = "rejected";
  assert.notDeepEqual(planShape(changed), planShape(frozen));
  assert.ok(source.setupTimeline.length > 0);
});

function structuredCloneish(value) {
  return JSON.parse(JSON.stringify(value));
}
