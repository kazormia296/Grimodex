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
  assert.match(packageJson.scripts["verify:quality"], /test:quality/);
  assert.match(packageJson.scripts["verify:quality"], /eval:fixtures/);
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

test("the Iron Laws carry stable IDs used by the machine-readable manifest", async () => {
  const policy = await read("policies/quality/iron-laws.md");
  const manifest = await read("evals/quality-manifest.yaml");
  const requirementIds = [
    "GDX-ROUTE-001",
    "GDX-PRECHECK-001",
    "GDX-TOOL-001",
    "GDX-POLICY-001",
    "GDX-GROUND-001",
    "GDX-ARTIFACT-001",
    "GDX-ISOLATION-001",
    "GDX-TRACE-001",
  ];

  for (const requirementId of requirementIds) {
    assert.match(policy, new RegExp(requirementId));
    assert.match(manifest, new RegExp(requirementId));
  }
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
