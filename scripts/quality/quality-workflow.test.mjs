import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(relative) {
  return readFile(path.join(repoRoot, relative), "utf8");
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  return yaml.load(match[1]);
}

test("package scripts expose one canonical quality workflow", async () => {
  const packageJson = JSON.parse(await read("package.json"));

  assert.match(packageJson.scripts["test:quality"], /quality\/.*\.test\.mjs/);
  assert.equal(
    packageJson.scripts["eval:fixtures"],
    "node scripts/quality/eval-fixtures.mjs",
  );
  assert.equal(
    packageJson.scripts["eval:impact"],
    "node scripts/quality/impact-map.mjs",
  );
  assert.match(packageJson.scripts["eval:narrative"], /narrative-extraction/);
  assert.match(
    packageJson.scripts["eval:narrative"],
    /ChronicleCalendarPopover\.test\.tsx/,
  );
  assert.match(
    packageJson.scripts["eval:narrative"],
    /ChronicleToolbar\.test\.tsx/,
  );
  assert.match(packageJson.scripts["eval:narrative:live"], /chronicleLegacy/);
  assert.match(packageJson.scripts["verify:quality"], /test:quality/);
  assert.match(packageJson.scripts["verify:quality"], /eval:fixtures/);
  assert.match(packageJson.scripts["verify:quality"], /eval:narrative/);
  assert.equal(
    packageJson.scripts["certify:gate-b2"],
    "node scripts/quality/certify-gate-b2.mjs",
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /certify-gate-b2\.test\.mjs/,
  );
});
test("CI runs the diff gate with full history and selected light suites", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(workflow, /^ {2}quality:\s*$/m);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /pnpm eval:impact/);
  assert.match(workflow, /--run/);
});

test("repo routing points AI behavior authoring and diff evaluation to narrow skills", async () => {
  const agents = await read("AGENTS.md");

  assert.match(agents, /grimodex-author/);
  assert.match(agents, /grimodex-impact-gate/);
  assert.match(agents, /AI指示|システムプロンプト|AI評価fixture/);
  assert.match(agents, /差分評価|impact gate|品質ゲート/);
});

test("new skills use current frontmatter and call the canonical commands", async () => {
  const author = await read(".agents/skills/grimodex-author/SKILL.md");
  const impact = await read(".agents/skills/grimodex-impact-gate/SKILL.md");

  assert.deepEqual(Object.keys(frontmatter(author)).sort(), [
    "description",
    "name",
  ]);
  assert.deepEqual(Object.keys(frontmatter(impact)).sort(), [
    "description",
    "name",
  ]);
  assert.match(author, /policies\/quality\/iron-laws\.md/);
  assert.match(author, /evals\/quality-manifest\.yaml/);
  assert.match(author, /pnpm verify:quality/);
  assert.match(author, /grimodex-impact-gate/);
  assert.match(impact, /pnpm eval:impact/);
  assert.match(impact, /--run/);
  assert.match(impact, /deferred/i);
});

test("release CI failures route through a no-bump targeted debug skill", async () => {
  const agents = await read("AGENTS.md");
  const releaseDebug = await read(".agents/skills/debug-release-ci/SKILL.md");
  const releaseDebugUi = yaml.load(
    await read(".agents/skills/debug-release-ci/agents/openai.yaml"),
  );
  const bump = await read(".agents/skills/bump-version/SKILL.md");
  const debugIssue = await read(".agents/skills/debug-issue/SKILL.md");
  const ship = await read(".agents/skills/ship-branch/SKILL.md");

  assert.deepEqual(Object.keys(frontmatter(releaseDebug)).sort(), [
    "description",
    "name",
  ]);
  assert.equal(frontmatter(releaseDebug).name, "debug-release-ci");
  assert.match(releaseDebugUi.interface.default_prompt, /\$debug-release-ci/);

  assert.match(agents, /release CI|release workflow/i);
  assert.match(agents, /debug-release-ci/);
  assert.match(agents, /一般.*CI.*debug-issue/);
  assert.match(agents, /再実行.*目的.*patch version.*上げない/is);

  assert.match(releaseDebug, /run ID/);
  assert.match(releaseDebug, /head SHA/i);
  assert.match(releaseDebug, /成功済み.*job/i);
  assert.match(releaseDebug, /source_run_id/);
  assert.match(releaseDebug, /candidate_ref/);
  assert.match(releaseDebug, /--ref master/);
  assert.doesNotMatch(releaseDebug, /--ref <fix-branch>/);
  assert.doesNotMatch(releaseDebug, /candidate_ref=<fix-branch>/);
  assert.match(releaseDebug, /candidate_ref=<40-character-fix-commit-sha>/);
  assert.match(releaseDebug, /package\.json.*変更しない/is);
  assert.match(releaseDebug, /tag.*(?:作成しない|移動しない)/is);
  assert.match(releaseDebug, /ship-branch/);
  assert.match(releaseDebug, /bump-version/);

  assert.match(debugIssue, /release workflow.*debug-release-ci/is);
  assert.match(bump, /再実行.*目的.*バージョン.*上げない/is);
  assert.match(bump, /focused gate.*成功/is);
  assert.match(bump, /debug-release-ci/);
  assert.match(ship, /release workflow.*debug-release-ci/is);
});

test("public copy follows the canonical style guide and version bumps stop at a draft release", async () => {
  const agents = await read("AGENTS.md");
  const copy = await read(".agents/skills/write-grimodex-copy/SKILL.md");
  const copyUi = yaml.load(
    await read(".agents/skills/write-grimodex-copy/agents/openai.yaml"),
  );
  const bump = await read(".agents/skills/bump-version/SKILL.md");
  const bumpUi = yaml.load(
    await read(".agents/skills/bump-version/agents/openai.yaml"),
  );
  const guide = await read("docs/communication-style-guide.md");
  const impactMap = await read("evals/impact-map.yaml");

  assert.deepEqual(Object.keys(frontmatter(copy)).sort(), [
    "description",
    "name",
  ]);
  assert.equal(frontmatter(copy).name, "write-grimodex-copy");
  assert.match(copyUi.interface.default_prompt, /\$write-grimodex-copy/);

  assert.match(copy, /docs\/communication-style-guide\.md/);
  assert.match(copy, /リリースノート/);
  assert.match(copy, /日本語.*英語|日英/is);
  assert.match(copy, /事実.*先|事実ベース/is);
  assert.match(copy, /冒頭1〜2文/);
  assert.match(copy, /Issue.*PR.*コミット|PR.*Issue.*commit/is);
  assert.match(copy, /公開.*(?:しない|権限.*ない)/is);
  assert.match(copy, /直近の公開済みGitHub Release/);
  assert.match(copy, /現行Assets/);
  assert.match(copy, /手動導入用Assets.*自動更新用Assets.*別工程/is);
  assert.match(guide, /このファイル.*正本/is);
  assert.match(guide, /Issue、PR、コミットメッセージ/);
  assert.match(guide, /## 配備要領/);
  assert.match(guide, /## DEPLOYMENT PROCEDURE/);
  assert.match(guide, /## ⚠️ インストール前に必ずお読みください/);
  assert.match(guide, /## ⚠️ Please read before installing/);
  assert.match(guide, /runtime library/);
  assert.match(guide, /Release 公開後の別工程/);
  assert.match(impactMap, /docs\/communication-style-guide\.md/);

  assert.match(agents, /write-grimodex-copy/);
  assert.match(agents, /リリースノート|告知文|広報文/);
  assert.match(agents, /日英リリースノート/);
  assert.doesNotMatch(agents, /「日英版」/);
  assert.match(bump, /write-grimodex-copy/);
  assert.match(bump, /RELEASE_NOTES\/v<新バージョン>\.ja\.md/);
  assert.match(bump, /RELEASE_NOTES\/v<新バージョン>\.en\.md/);
  assert.doesNotMatch(bump, /## 新機能 \/ New/);
  assert.match(bump, /配備要領/);
  assert.match(bump, /DEPLOYMENT PROCEDURE/);
  assert.match(bump, /手動導入用Assets.*自動更新用Assets.*別工程/is);
  assert.match(bump, /Draft Release|Draftリリース/i);
  assert.match(bump, /isDraft/);
  assert.match(bump, /別.*明示.*指示.*公開/is);
  assert.match(bump, /--draft=false/);
  assert.match(bumpUi.interface.short_description, /Draft/i);
  assert.match(bumpUi.interface.default_prompt, /\$bump-version/);
  assert.match(bumpUi.interface.default_prompt, /Draft/i);
});

test("the Iron Laws carry stable IDs used by the machine-readable manifest", async () => {
  const policy = await read("policies/quality/iron-laws.md");
  const manifest = await read("evals/quality-manifest.yaml");
  const requirementIds = [
    "GDX-ROUTE-001",
    "GDX-AI-AUDIT-001",
    "GDX-PRECHECK-001",
    "GDX-TOOL-001",
    "GDX-POLICY-001",
    "GDX-GROUND-001",
    "GDX-ARTIFACT-001",
    "GDX-NARR-EVAL-001",
    "GDX-NARR-EVIDENCE-001",
    "GDX-NARR-SEMANTIC-001",
    "GDX-NARR-COVERAGE-001",
    "GDX-NARR-DETAIL-001",
    "GDX-NARR-TEMPORAL-001",
    "GDX-ISOLATION-001",
    "GDX-TRACE-001",
  ];

  for (const requirementId of requirementIds) {
    assert.match(policy, new RegExp(requirementId));
    assert.match(manifest, new RegExp(requirementId));
  }
});

test("the AI audit privacy law excludes transport credentials without rewriting model-visible evidence", async () => {
  const policy = await read("policies/quality/iron-laws.md");

  assert.match(
    policy,
    /Transport\s+credentials supplied outside the model-visible request body[\s\S]*excluded and never become audit payloads/,
  );
  assert.match(
    policy,
    /Credential-shaped text intentionally included in model-visible prompt, context, tool content, or\s+output is preserved exactly/,
  );
  assert.match(policy, /export bundle warns/);
  assert.doesNotMatch(
    policy,
    /API keys,\s*authorization headers, credential-bearing environment values, and other secrets are never audit\s+payloads/,
  );
});

test("the AI audit requirement traces streaming durability and legacy evidence into the light suite", async () => {
  const manifest = yaml.load(await read("evals/quality-manifest.yaml"));
  const auditRequirement = manifest.requirements.find(
    (requirement) => requirement.id === "GDX-AI-AUDIT-001",
  );
  const impactRunner = await read("scripts/quality/impact-map.mjs");

  assert.ok(auditRequirement);
  assert.ok(
    auditRequirement.implementedBy.includes(
      "src/features/ai-audit/orderedStreamAudit.ts",
    ),
  );
  assert.ok(
    auditRequirement.implementedBy.includes(
      "src/features/ai-audit/legacyEvidence.ts",
    ),
  );
  assert.ok(
    auditRequirement.implementedBy.includes(
      "src/features/chat/chatStreamTransport.ts",
    ),
  );
  assert.ok(
    auditRequirement.implementedBy.includes(
      "src/features/attribution/AttributionProjectView.tsx",
    ),
  );
  assert.ok(
    auditRequirement.lightTests.includes(
      "src/features/ai-audit/orderedStreamAudit.test.ts",
    ),
  );
  assert.ok(
    auditRequirement.lightTests.includes(
      "src/features/ai-audit/legacyEvidence.test.ts",
    ),
  );
  assert.match(impactRunner, /ai-audit\/orderedStreamAudit\.test\.ts/);
  assert.match(impactRunner, /ai-audit\/legacyEvidence\.test\.ts/);
});

test("the Heavy runner never selects a Windows command shell from the environment", async () => {
  const runnerUrl = pathToFileURL(
    path.join(repoRoot, "scripts/quality/run-related-scenes-heavy.mjs"),
  );
  const { buildCommandInvocation } = await import(runnerUrl.href);

  assert.deepEqual(buildCommandInvocation("pnpm", ["test:node"], "win32"), {
    executable: "cmd.exe",
    commandArgs: ["/d", "/s", "/c", "pnpm", "test:node"],
  });
  assert.deepEqual(buildCommandInvocation("pnpm", ["test:node"], "linux"), {
    executable: "pnpm",
    commandArgs: ["test:node"],
  });
});
