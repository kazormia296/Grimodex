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

function escapeRegExp(value) {
  return value.replace(/[\^$.*+?()[\]{}|]/g, "\\$&");
}

function sectionFromHeading(markdown, heading) {
  const headingPattern = new RegExp(
    "^" + escapeRegExp(heading) + "[ \t]*$",
    "m",
  );
  const headingMatch = markdown.match(headingPattern);
  assert.ok(
    headingMatch,
    heading + " must exist as a level-two heading",
  );

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remaining = markdown.slice(sectionStart);
  const nextHeadingOffset = remaining.search(/^##[ \t]+/m);
  return nextHeadingOffset === -1
    ? remaining
    : remaining.slice(0, nextHeadingOffset);
}

function normalizeSection(section) {
  return section.replace(/\s+/g, " ").trim();
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
    "node scripts/quality/certify-gate-b2-bootstrap.mjs",
  );
  assert.equal(
    packageJson.scripts["certify:gate-b2:freeze"],
    "node scripts/quality/freeze-gate-b2-candidate.mjs",
  );
  assert.equal(
    packageJson.scripts["qualify:ai-live"],
    "node scripts/quality/run-live-model-qualification.mjs",
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /certify-gate-b2\.test\.mjs/,
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /run-live-model-qualification\.test\.mjs/,
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

test("high-risk work keeps threat models user-confirmed and candidate evidence reproducible", async () => {
  const agents = await read("AGENTS.md");
  const policy = await read("policies/quality/iron-laws.md");
  const agentsSection = normalizeSection(
    sectionFromHeading(agents, "## 高リスク作業の運用規律"),
  );
  const policySection = normalizeSection(
    sectionFromHeading(policy, "## GDX-PRECHECK-001 — Stop on failed prechecks"),
  );
  const traceSection = normalizeSection(
    sectionFromHeading(policy, "## GDX-TRACE-001 — Preserve traceability and failure state"),
  );
  const ship = await read(".agents/skills/ship-branch/SKILL.md");
  const shipCiSection = normalizeSection(
    sectionFromHeading(ship, "## 2. ローカルCI gateを固定する"),
  );
  const shipMergeSection = normalizeSection(
    sectionFromHeading(ship, "## 7. Merge と反映確認を行う"),
  );
  const manifest = yaml.load(await read("evals/quality-manifest.yaml"));
  const precheck = manifest.requirements.find(
    (requirement) => requirement.id === "GDX-PRECHECK-001",
  );

  function assertBothSections(label, pattern) {
    assert.match(agentsSection, pattern, label + " is missing from AGENTS.md");
    assert.match(
      policySection,
      pattern,
      label + " is missing from GDX-PRECHECK-001",
    );
  }

  for (const phrase of [
    /security-sensitive threat model/i,
    /draft/i,
    /trusted\/untrusted actors/i,
    /in-scope and out-of-scope attacks/i,
    /mandatory defenses/i,
    /acceptance implications/i,
    /explicit user confirmation/i,
    /material changes/i,
    /reconfirmation/i,
    /blocking precheck/i,
    /\[precheck\]/i,
  ]) {
    assertBothSections("threat-model precheck contract", phrase);
  }

  assert.match(agentsSection, /サブエージェントとレビュー担当.*提案/i);
  assert.match(agentsSection, /脅威モデル.*無断.*固定.*変更/i);
  assert.match(
    policySection,
    /subagents and reviewers may propose.*not silently freeze or change/i,
  );

  for (const phrase of [
    /one integrator/i,
    /implementer\(s\)/i,
    /candidate-untouched independent acceptance reviewer\(s\)/i,
    /single candidate ledger/i,
    /base.*head.*tree.*clean state.*receipt directory/i,
    /receipt directory.*threat-model version\/ref/i,
    /reviewable lanes/i,
    /critical candidate/i,
    /focused gates/i,
  ]) {
    assertBothSections("candidate/reviewer contract", phrase);
  }
  assert.match(
    agentsSection,
    /実装担当.*独立.*受入れレビュー担当.*分離/i,
  );
  assert.match(agentsSection, /役割.*重複させない/i);
  assert.match(agentsSection, /受入れレビュー担当.*候補.*編集しない/i);
  assert.match(agentsSection, /focused gates.*freeze/i);
  assert.match(agentsSection, /freeze.*編集せず/i);
  assert.match(agentsSection, /候補.*再開.*receipt.*無効化/i);
  assert.match(policySection, /roles do not overlap/i);
  assert.match(policySection, /acceptance reviewer\(s\).*must not edit the candidate/i);
  assert.match(policySection, /focused gates.*candidate freezes/i);
  assert.match(
    policySection,
    /After freeze, no edits.*finding reopens the candidate.*invalidates its receipts/i,
  );

  for (const phrase of [
    /focused preflight/i,
    /risk-derived applicable late stages only/i,
    /runtime performance.*fresh Xvfb/i,
    /migration\/recovery/i,
    /real product journeys/i,
    /diagnostic only/i,
    /clean Full-from-stage-1 \+ verify/i,
  ]) {
    assertBothSections("focused preflight contract", phrase);
  }
  assert.match(agentsSection, /例示.*examples/i);
  assert.match(agentsSection, /一律要件.*blanket requirements/i);
  assert.match(
    agentsSection,
    /該当しない host capability.*要求せず.*block条件にも使わない/i,
  );
  assert.match(policySection, /examples, not blanket requirements/i);
  assert.match(policySection, /inapplicable host capability/i);

  for (const phrase of [
    /unattributed runtime blocker/i,
    /causal evidence/i,
    /rAF.*event-loop.*wake\/discovery.*memory-sampler.*process CPU\/I\/O.*device\/PSI/i,
    /exact failed receipt/i,
    /diagnostic\/P3 debt/i,
    /critical candidate/i,
  ]) {
    assertBothSections("runtime/debt contract", phrase);
  }
  assert.match(agentsSection, /変更したパスだけから環境または製品の状態を推定しない/i);
  assert.match(policySection, /Do not infer environment or product status from touched paths/i);

  for (const phrase of [
    /data categories.*permission/i,
    /claude-fable-5-1/i,
    /effort.*high/i,
    /Fast/i,
  ]) {
    assertBothSections("external-review model contract", phrase);
  }
  assert.match(agentsSection, /Claude review/i);
  assert.match(agentsSection, /外部 review.*作業.*開始時 precheck.*固定/i);
  assert.match(agentsSection, /requested\/effective model/i);
  assert.match(agentsSection, /silently substitute/i);
  assert.match(agentsSection, /すべてのリポジトリやログを送る包括許可にはしない/i);
  assert.match(policySection, /external Claude review.*start-of-work precheck/i);
  assert.match(policySection, /requested and effective model/i);
  assert.match(policySection, /never silently substitute/i);
  assert.match(policySection, /not blanket.*all repositories or logs/i);

  for (const phrase of [
    /acceptance evidence.*directly candidate-bound.*verified parent receipt.*candidate-bound/i,
    /metrics or artifacts.*independently.*parent receipt.*direct.*candidate identity.*commit\/tree\/run.*artifact digest/i,
    /standalone evidence.*diagnostic-only/i,
    /Missing direct binding.*tracked hardening debt.*retroactively invalidate.*complete parent receipt/i,
    /acceptedTreeSha.*Full receipt.*candidate\.resolvedHeadTreeSha.*current accepted HEAD/i,
    /separately.*merge commit.*included.*origin\/master.*accepted tree SHA.*remote merge tree/i,
    /invalidate the receipts.*rerun.*Full-from-stage-1 \+ verify/i,
  ]) {
    assert.match(traceSection, phrase);
  }
  assert.match(
    shipCiSection,
    /candidate\.resolvedHeadSha.*current accepted HEAD.*acceptedHeadSha.*candidate\.resolvedHeadSha.*acceptedTreeSha.*candidate\.resolvedHeadTreeSha/i,
  );
  assert.doesNotMatch(
    shipCiSection,
    /git rev-parse <accepted-head>\^\{tree\}/i,
    "acceptedTreeSha must come from the existing Full receipt field",
  );
  assert.match(
    shipMergeSection,
    /git fetch origin master.*merge commit.*origin\/master.*含まれる.*別条件/i,
  );
  assert.match(
    shipMergeSection,
    /Full receipt.*current accepted HEAD.*acceptedTreeSha.*merge.*remote merge tree.*acceptedTreeSha.*git rev-parse <merge-sha>\^\{tree\}/i,
  );
  assert.doesNotMatch(
    shipMergeSection,
    /git rev-parse origin\/master\^\{tree\}/i,
    "origin/master inclusion must not replace accepted-tree comparison",
  );
  assert.match(
    shipMergeSection,
    /不一致.*receipt.*無効化.*Full-from-stage-1 \+ verify/i,
  );

  assert.ok(precheck, "GDX-PRECHECK-001 must exist");
  const trace = manifest.requirements.find(
    (requirement) => requirement.id === "GDX-TRACE-001",
  );
  assert.ok(trace, "GDX-TRACE-001 must exist");
  assert.ok(
    precheck.implementedBy.includes("AGENTS.md"),
    "AGENTS.md must be traced under GDX-PRECHECK-001",
  );
  assert.ok(
    precheck.lightTests.includes("scripts/quality/quality-workflow.test.mjs"),
    "the contract test must remain in the precheck light suite",
  );
  assert.ok(
    trace.implementedBy.includes("AGENTS.md"),
    "AGENTS.md must be traced under GDX-TRACE-001",
  );
  assert.ok(
    trace.implementedBy.includes(".agents/skills/ship-branch/SKILL.md"),
    "ship-branch must be traced under GDX-TRACE-001",
  );
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
  assert.match(impact, /pnpm ci:local:quick/);
  assert.match(impact, /pnpm ci:local:verify/);
  assert.match(impact, /deferred/i);
});

test("adversarial review keeps execution controls explicit and findings evidence-backed", async () => {
  const agents = await read("AGENTS.md");
  const review = await read(".agents/skills/adversarial-review/SKILL.md");
  const manifest = yaml.load(await read("evals/quality-manifest.yaml"));
  const reviewUi = yaml.load(
    await read(".agents/skills/adversarial-review/agents/openai.yaml"),
  );

  assert.deepEqual(Object.keys(frontmatter(review)).sort(), [
    "description",
    "name",
  ]);
  assert.equal(frontmatter(review).name, "adversarial-review");
  assert.match(frontmatter(review).description, /多次元|multidimensional/i);
  assert.match(frontmatter(review).description, /敵対的|adversarial/i);
  assert.match(agents, /多次元敵対的レビュー.*adversarial-review/is);

  assert.match(review, /model=<inherit\|model-id>/);
  assert.match(
    review,
    /effort=<inherit\|low\|medium\|high\|xhigh\|max\|ultra>/,
  );
  assert.match(review, /fast=<inherit\|on\|off>/);
  assert.match(review, /Fast.*service tier|service tier.*Fast/is);
  assert.match(review, /requested.*effective/is);
  assert.match(review, /個別.*Fast.*上書き.*(?:ない|不可).*\[precheck\]/is);

  assert.match(review, /独立.*reviewer|reviewer.*独立/is);
  assert.match(review, /正しさ|correctness/i);
  assert.match(review, /security|セキュリティ/i);
  assert.match(review, /境界|contract/i);
  assert.match(review, /テスト|test/i);
  assert.match(review, /performance|性能/i);
  assert.match(review, /false positive|誤検知/i);

  assert.match(review, /P0.*P1.*P2.*P3/is);
  assert.match(review, /file:line/);
  assert.match(review, /failure scenario|失敗シナリオ/i);
  assert.match(review, /根拠|evidence/i);
  assert.match(review, /変更しない|read-only/i);

  assert.match(reviewUi.interface.default_prompt, /\$adversarial-review/);
  assert.match(reviewUi.interface.default_prompt, /model=/);
  assert.match(reviewUi.interface.default_prompt, /effort=/);
  assert.match(reviewUi.interface.default_prompt, /fast=(?:on|off|inherit)/);

  for (const requirementId of [
    "GDX-PRECHECK-001",
    "GDX-ARTIFACT-001",
    "GDX-ISOLATION-001",
    "GDX-TRACE-001",
  ]) {
    const requirement = manifest.requirements.find(
      (candidate) => candidate.id === requirementId,
    );
    assert.ok(requirement, `${requirementId} must exist`);
    assert.ok(
      requirement.implementedBy.includes(
        ".agents/skills/adversarial-review/SKILL.md",
      ),
    );
    assert.ok(
      requirement.lightTests.includes(
        "scripts/quality/quality-workflow.test.mjs",
      ),
    );
  }
});

test("sandbox EPERM reruns preserve the failed command and escalate only a verified tsx IPC bootstrap", async () => {
  const agents = await read("AGENTS.md");
  const skill = await read(".agents/skills/rerun-sandbox-eperm/SKILL.md");
  const skillUi = yaml.load(
    await read(".agents/skills/rerun-sandbox-eperm/agents/openai.yaml"),
  );
  const manifest = yaml.load(await read("evals/quality-manifest.yaml"));

  assert.deepEqual(Object.keys(frontmatter(skill)).sort(), [
    "description",
    "name",
  ]);
  assert.equal(frontmatter(skill).name, "rerun-sandbox-eperm");
  assert.match(frontmatter(skill).description, /tsx/i);
  assert.match(frontmatter(skill).description, /IPC|pipe|listen/i);
  assert.match(frontmatter(skill).description, /EPERM/);
  assert.match(agents, /tsx.*IPC.*EPERM.*rerun-sandbox-eperm/is);

  assert.match(skill, /sandbox.*tsx.*(?:IPC|pipe|listen).*EPERM/is);
  assert.match(skill, /command.*cwd.*(?:argv|引数).*(?:env|環境)/is);
  assert.match(skill, /同一|unchanged/i);
  assert.match(skill, /sandbox_permissions.*require_escalated/is);
  assert.match(skill, /一度だけ|exactly once/i);
  assert.match(skill, /最初.*失敗.*保存|preserve.*first failure/is);
  assert.match(skill, /一般.*EPERM.*(?:対象外|十分ではない)/is);
  assert.match(skill, /product.*EPERM.*(?:対象外|再実行しない)/is);
  assert.match(skill, /TMPDIR.*(?:変更しない|書き換えない)/is);
  assert.match(skill, /sudo.*(?:使用しない|実行しない)/is);
  assert.match(skill, /prompt injection|untrusted/i);

  assert.match(skill, /sandbox 外.*成功.*\[tool\]/is);
  assert.match(skill, /同じ.*EPERM.*再試行しない/is);
  assert.match(skill, /別の失敗.*再試行しない/is);
  assert.match(skill, /command.*exit code.*stderr/is);

  assert.match(skillUi.interface.default_prompt, /\$rerun-sandbox-eperm/);

  for (const requirementId of [
    "GDX-PRECHECK-001",
    "GDX-POLICY-001",
    "GDX-TRACE-001",
  ]) {
    const requirement = manifest.requirements.find(
      (candidate) => candidate.id === requirementId,
    );
    assert.ok(requirement, `${requirementId} must exist`);
    assert.ok(
      requirement.implementedBy.includes(
        ".agents/skills/rerun-sandbox-eperm/SKILL.md",
      ),
    );
    assert.ok(
      requirement.lightTests.includes(
        "scripts/quality/quality-workflow.test.mjs",
      ),
    );
  }
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
