import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function sectionFromAnchor(markdown, anchor) {
  const anchorPattern = new RegExp(
    `<a\\s+id=["']${escapeRegExp(anchor)}["']\\s*><\\/a>`,
  );
  const match = markdown.match(anchorPattern);
  assert.ok(match, `the stable policy anchor ${anchor} must exist`);
  const following = markdown.slice(match.index + match[0].length).trimStart();
  const heading = following.match(/^##[ \t]+[^\n]+/);
  assert.ok(heading, `${anchor} must precede its canonical level-two section`);
  return sectionFromHeading(following, heading[0]);
}

async function assertLocalMarkdownLink(sourcePath, targetPath, anchor) {
  const source = await read(sourcePath);
  const links = [...source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)];
  const expectedPath = path.resolve(repoRoot, targetPath);
  const link = links.find((match) => {
    const [destination, fragment] = match[1].split("#");
    return (
      !/^[a-z]+:/i.test(destination) &&
      path.resolve(repoRoot, path.dirname(sourcePath), destination) === expectedPath &&
      fragment === anchor
    );
  });
  assert.ok(
    link,
    `${sourcePath} must link to ${targetPath}${anchor ? `#${anchor}` : ""}`,
  );
  const target = await read(targetPath);
  if (anchor) {
    assert.match(
      target,
      new RegExp(`<a\\s+id=["']${escapeRegExp(anchor)}["']\\s*><\\/a>`),
      `${targetPath} must expose the exact stable anchor ${anchor}`,
    );
  }
  return source;
}

function commandBindings(section, command, label) {
  const lines =
    section.match(
      new RegExp(`${escapeRegExp(command)}[^\\n]*`, "g"),
    ) ?? [];
  assert.ok(lines.length > 0, `${label} command must be written`);
  return lines.map((line) => {
    const base = line.match(/--base\s+("[^"]+"|'[^']+'|\S+)/)?.[1];
    const head = line.match(/--head\s+("[^"]+"|'[^']+'|\S+)/)?.[1];
    assert.ok(base, `${label} command must bind --base`);
    assert.ok(head, `${label} command must bind --head`);
    return {
      base: base.replace(/[`;,.)]+$/g, ""),
      head: head.replace(/[`;,.)]+$/g, ""),
    };
  });
}

function extractGraphProposalSections(executionPlan) {
  const proposalSection = executionPlan
    .split("### R0 security contract proposal (draft)\n", 2)[1]
    ?.split("\n### R0 lane開始判定と評価manifest", 1)[0];
  assert.ok(proposalSection, "R0 security contract proposal must be present");
  const graphStart = proposalSection.indexOf("#### graph-limited-binding\n");
  const graphEnd = proposalSection.indexOf(
    "\n#### native-generation-receipt",
    graphStart,
  );
  assert.ok(graphStart >= 0, "bounded Graph proposal must be present");
  assert.ok(graphEnd > graphStart, "bounded Graph proposal must have an end");
  const proposal = proposalSection.slice(graphStart, graphEnd);
  const lifecycleStart = proposal.indexOf(
    "##### B build owner/lifecycle (proposal/5 confirmed contract)",
  );
  const acceptanceStart = proposal.indexOf(
    "##### Proposal/5 acceptance split (confirmed contract)",
  );
  assert.ok(lifecycleStart >= 0, "Graph lifecycle matrix must be present");
  assert.ok(acceptanceStart > lifecycleStart, "Graph acceptance split must follow lifecycle");
  const lifecycle = proposal.slice(lifecycleStart, acceptanceStart);
  const outsideValidationStart = lifecycle.indexOf(
    "##### Outside-initial-build full-roster validation (proposal/5 confirmed contract)",
  );
  const outsideValidationEnd = lifecycle.indexOf(
    "\n\nこの表は有限",
    outsideValidationStart,
  );
  assert.ok(
    outsideValidationStart >= 0,
    "outside-initial-build full-roster validation must be present",
  );
  assert.ok(
    outsideValidationEnd > outsideValidationStart,
    "outside-initial-build validation must have a bounded section",
  );
  const outsideValidation = lifecycle.slice(
    outsideValidationStart,
    outsideValidationEnd,
  );
  const acceptanceRows = proposal.slice(acceptanceStart).split("\n");

  const l7Start = executionPlan.indexOf("## L7: Entity/Relation入力とGraph\n");
  const l8Start = executionPlan.indexOf("\n## L8:", l7Start);
  assert.ok(l7Start >= 0, "L7 Graph section must be present");
  assert.ok(l8Start > l7Start, "L7 Graph section must have a bounded end");
  const l7Graph = executionPlan.slice(l7Start, l8Start);
  const resourceStart = l7Graph.indexOf("| resource unit | scope | contract |");
  const resourceEnd = l7Graph.indexOf("\n\nworkspace authority", resourceStart);
  assert.ok(resourceStart >= 0, "Graph resource-unit table must be present");
  assert.ok(resourceEnd > resourceStart, "Graph resource-unit table must have a bounded end");
  const resourceRows = l7Graph.slice(resourceStart, resourceEnd).split("\n");

  const l9Start = executionPlan.indexOf("## L9: 受入れと完了判定\n");
  const completionStart = executionPlan.indexOf("\n### 完了区分", l9Start);
  assert.ok(l9Start >= 0, "L9 acceptance section must be present");
  assert.ok(completionStart > l9Start, "L9 acceptance section must have a bounded end");
  const l9Acceptance = executionPlan.slice(l9Start, completionStart);
  const l9GraphAcceptanceStart = l9Acceptance.indexOf("whole-project B buildは");
  assert.ok(l9GraphAcceptanceStart >= 0, "Graph acceptance narrative must cover the whole-project build");

  return {
    proposal,
    lifecycle,
    outsideValidation,
    acceptanceRows,
    resourceRows,
    graphAcceptanceNarrative: l9Acceptance.slice(l9GraphAcceptanceStart),
  };
}

function validateGraphProposalContract(executionPlan) {
  const {
    proposal,
    lifecycle,
    outsideValidation,
    acceptanceRows,
    resourceRows,
    graphAcceptanceNarrative,
  } = extractGraphProposalSections(executionPlan);
  const resourceRow = (label) => {
    const row = resourceRows.find(
      (line) => line.startsWith("|") && line.split("|")[1]?.trim() === label,
    );
    assert.ok(row, `Graph resource-unit row must define ${label}`);
    return row;
  };
  const revisionResourceRow = resourceRow("Entity／Relation Revision bundle");
  assert.match(revisionResourceRow, /512 records.*2 MiB.*validation contract/);
  assert.doesNotMatch(revisionResourceRow, /whole-project|query totals|deadline/i);
  const queryResourceRow = resourceRow("seed-local Graph query");
  for (const queryBound of [
    "read／admission `512`",
    "batch `16x32`",
    "SQL `100,000 VM steps`",
    "`1,000` steps",
    "`2 MiB`",
    "Graph `8ms`",
    "reader／busy wait `0`",
  ]) {
    assert.match(queryResourceRow, new RegExp(escapeRegExp(queryBound)));
  }
  const buildResourceRow = resourceRow("whole-project B Index build");
  assert.match(
    buildResourceRow,
    /現在のproject全体のcandidate roster.*全候補.*small／keyset pages.*qualified material.*全件atomic publish/,
  );
  assert.match(
    buildResourceRow,
    /candidate count.*compact roster count.*cumulative bytes.*cumulative SQL.*query totalsでcapしない/,
  );
  assert.match(
    buildResourceRow,
    /full-set maintenance validation.*Source re-resolution.*is_complete_registered.*restore／cold reopen/,
    "whole-project resource unit must include full-set maintenance validation",
  );
  assert.match(buildResourceRow, /supported capacityの数値は第1診断stage後まで未批准/);
  assert.doesNotMatch(
    buildResourceRow,
    /(?:candidate count|compact roster count|cumulative bytes|cumulative SQL)[^|]*(?:512|100,000|2 MiB|8ms|deadline\s*[:=]|\d+ms)/i,
    "whole-project row must not impose a numeric build cap or deadline",
  );
  assert.doesNotMatch(
    proposal,
    /(?:supported capacity|whole-project B(?: Index)? build)[^\n]*(?:=\s*`?\d+|deadline\s*(?:is|=|:)\s*`?\d+\s*(?:ms|s)?)/i,
    "Graph proposal must not ratify a numeric whole-project build cap or deadline",
  );
  assert.doesNotMatch(
    proposal,
    /(?:persistent adjacency|新しいauthority|新しいschema|新しいconsumer)(?:は|を)\s*(?:追加する|add(?:ed|ing)?|create(?:d|s)?|introduce)/i,
    "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
  );
  assert.doesNotMatch(
    lifecycle,
    /persistent staging(?:は|を)\s*(?:作る|追加する|使用する|persist|create|use)/i,
    "Graph lifecycle must not create or use persistent staging",
  );
  assert.doesNotMatch(
    lifecycle,
    /(?:新しいframework|new framework)(?:は|を)\s*(?:作る|追加する|create|add|introduce)/i,
    "Graph lifecycle must not create a new framework",
  );
  assert.match(proposal, /新しいauthority、schema、consumer、persistent adjacencyは追加しない/);
  assert.match(lifecycle, /persistent stagingは作らない/);
  assert.match(lifecycle, /新しいframework、authority、schema、consumer、persistent adjacencyを作らない/);

  const maintenancePath = (label) => {
    const row = outsideValidation
      .split("\n")
      .find((line) => line.startsWith(`- ${label}:`));
    assert.ok(row, `outside full-roster validation must define ${label}`);
    return row;
  };
  const sourceValidation = maintenancePath("Source re-resolution");
  const coverageValidation = maintenancePath(
    "complete registration/coverage verification (`is_complete_registered`)",
  );
  const reopenValidation = maintenancePath("restore/cold reopen verification");
  const queryValidation = maintenancePath("future seed-local query admission");
  const commonValidation = maintenancePath("Common cancellation／cleanup");
  assert.match(
    outsideValidation,
    /各既存Native／DB maintenance entryがcaller connection、read transaction、progress hook、ownerを持ち、各full validation attemptをend-to-endでmeasurementする/,
    "every outside-build validation path must have an existing owner, connection, transaction, and hook",
  );
  for (const [pathLabel, pathLine] of [
    ["Source re-resolution", sourceValidation],
    ["complete registration/coverage verification", coverageValidation],
    ["restore/cold reopen verification", reopenValidation],
  ]) {
    assert.match(
      pathLine,
      /unowned／unbounded full-roster scanを開始しない/,
      `${pathLabel} must reject unowned or unbounded scanning`,
    );
    assert.doesNotMatch(
      pathLine,
      /full-roster scanを開始する/,
      `${pathLabel} must not permit an unowned or unbounded scan`,
    );
  }
  assert.match(
    sourceValidation,
    /current Sourceを再解決/,
    "Source re-resolution must be explicit",
  );
  assert.match(
    coverageValidation,
    /全件registration／coverageを検証/,
    "registration and coverage verification must be complete",
  );
  assert.match(
    reopenValidation,
    /sealed generation、Source、D1、complete rosterを再検証/,
    "restore and cold reopen must validate the complete sealed binding",
  );
  assert.match(
    queryValidation,
    /canonical seed-local queryはactiveではなく.*queryはvalidation read transactionへsynchronously入らない.*Graph unavailable／contribution `0`.*existing R\+IR／exact-R fallback.*query budget／protections.*別の既存Native／DB maintenance entryへowned validation／rebuildをrequest.*後続queryだけがcurrent sealed bindingを使う/s,
    "query-triggered validation must be deferred to an owned maintenance entry",
  );
  assert.doesNotMatch(
    queryValidation,
    /queryはvalidation read transactionへsynchronously入る/,
    "query must not synchronously enter a validation transaction",
  );
  assert.match(
    commonValidation,
    /admission closure.*actual statement termination／error evidence.*transaction rollback／close.*hook reset.*reader／handles／buffers release.*retry／reentrant admission/,
    "outside full-roster validation must own terminal cleanup and retry",
  );
  assert.match(
    commonValidation,
    /bounded `1,000` VM-step cadenceとRust boundaries.*nested resolverはouter owner／connection hookを継承してhookをinstall／overwrite／resetせず、rollback／closeはouter ownerが実行しnested resolverはterminal statusをpropagateするだけ/,
    "nested resolvers must inherit the outer hook and transaction owner",
  );
  assert.match(
    commonValidation,
    /cancel／timeout／closedはper-edge missing／diagnosticやsuccessful verificationへcoerceせずwhole attemptをterminateする/,
    "cancellation must terminate the whole maintenance attempt",
  );
  assert.match(
    proposal,
    /Outside-initial-build full-set validation:.*Source re-resolution.*is_complete_registered.*restore／cold reopen.*caller connection／read transaction.*progress hook/is,
    "Graph mandatory defenses must bind outside-build validation to existing owners",
  );
  assert.match(
    proposal,
    /final-publication commit cutoff is separate from run creation and intermediate report commits.*FinalizeGranted.*final Graph generation publish commit.*final Verify／Rebuild success transaction.*late cancel cannot rewrite success/is,
    "final publication must close cancellation separately from run commits",
  );
  assert.match(
    proposal,
    /background no-wait try-lock.*continuous shared-connection occupation.*foreground request arriving.*next page／row／A2／D1-edge／digest／serialization boundary.*ends the transaction and releases the connection.*Rust loops.*without waiting for another SQL statement/s,
    "acquired connection occupation and Rust-loop cancellation must be bounded",
  );
  assert.match(
    proposal,
    /Cleanup failure is terminal for reuse.*is_autocommit.*connectionReusable=true.*marks the process-local connection `unusable`.*no retry on that connection.*existing workspace reopen path.*auto-rollback.*autocommit/s,
    "cleanup failure must quarantine the connection",
  );
  assert.match(
    proposal,
    /測定形状は材料数だけでなくRevision数.*Evidence shared／unique.*ineligible候補.*report-heavy.*同じpreseed済みfile-backed DB copyとfresh subprocess.*warmupを既存Indexのrebuildと混ぜない/s,
    "capacity measurement must vary input shape and isolate fresh subprocess runs",
  );
  assert.match(
    proposal,
    /Evidenceは`evidence_ref`.*`source_key`／`revision_token`.*roster→D1／V1 dependency→Freshness→Verify→Restore→cold reopen/s,
    "Evidence identity must round-trip through downstream validation",
  );
  assert.match(
    proposal,
    /existing Full maintenance journeys.*Journey対象外.*new Journey implementation and NIR-1 product activation.*requested and effective model／effort.*effective metadata is unavailable.*`unavailable`.*never infer/i,
    "Full maintenance journeys and effective review metadata must remain explicit",
  );

  const requiredMemoryPatterns = [
    /buildには`mandatory end-to-end peak memory for the full build-through-publish interval`.*prepare／A2 qualificationからpublish＋cleanupまで/,
    /各full-set maintenance pathにも個別のend-to-end peak total memory/,
    /roster bytesとRevision-ID overheadはcomponents onlyとして別に報告する/,
    /snapshot roster＋dependency edges/,
    /A2 row／JSON／parsed bundle／material/,
    /rescan roster＋edges/,
    /digest／serialization/,
    /D1 prepared／digest／verification collections/,
    /edge observations／states/,
    /DB／statement／cache/,
    /container capacity／temp copies/,
    /simultaneous high-water mark.*documented conservative upper bound/,
    /method／coverage／uncertainty/,
    /unaccounted major structureがあればcapacity decisionをしてはならない/,
  ];
  for (const memoryPattern of requiredMemoryPatterns) {
    assert.match(
      proposal,
      memoryPattern,
      "full build and maintenance memory accounting must cover every major retained structure",
    );
  }
  assert.match(
    graphAcceptanceNarrative,
    /buildの`mandatory end-to-end peak memory for the full build-through-publish interval`.*各full-set maintenance validation attemptの個別end-to-end peak total memory.*roster bytesとRevision-ID overheadはcomponents only/is,
    "L9 capacity metrics must require end-to-end memory for build and maintenance",
  );
  assert.match(
    graphAcceptanceNarrative,
    /Full-set maintenance validationも同じproposal\/5 resource／lifecycle contract.*Source re-resolution.*is_complete_registered／coverage.*restore／cold reopen.*別の既存Native／DB maintenance entry.*queryはvalidation transactionへsynchronously入らず.*Graph unavailable／contribution `0`.*cancel／timeout／closedはwhole attemptをterminateする/s,
    "L9 acceptance must bind maintenance validation and query fallback to the same contract",
  );

  const phaseTableStart = lifecycle.indexOf("| phase | statement / read transaction |");
  const phaseTableEnd = lifecycle.indexOf("\nこの表は有限", phaseTableStart);
  assert.ok(phaseTableStart >= 0, "Graph phase lifecycle table must be present");
  assert.ok(phaseTableEnd > phaseTableStart, "Graph phase lifecycle table must have a bounded end");
  const phaseRows = lifecycle.slice(phaseTableStart, phaseTableEnd).split("\n");
  const phaseRow = (phase) => {
    const row = phaseRows.find(
      (line) => line.startsWith("|") && line.split("|")[1]?.trim() === phase,
    );
    assert.ok(row, `Graph phase lifecycle row must define ${phase}`);
    return row;
  };
  for (const [phase, statementPattern] of [
    ["prepare", /prepare statement/],
    ["page", /page.*statement/],
    ["source/coverage", /Source re-resolution.*complete registration\/coverage verification/],
    ["reopen/query", /restore／cold reopen.*full-roster verification.*query/],
    ["publish", /complete-rescan statement/],
  ]) {
    const row = phaseRow(phase);
    assert.match(row, statementPattern);
    for (const hookRequirement of [
      /connection-level progress hook/,
      /bounded `1,000` VM-step cadence/,
      /Rust boundary/,
    ]) {
      assert.match(row, hookRequirement);
    }
  }

  const acceptanceRow = (label) => {
    const normalizedLabel = label.replaceAll("`", "");
    const row = acceptanceRows.find(
      (line) =>
        line.startsWith("|") &&
        line.split("|")[1]?.replaceAll("`", "").trim() === normalizedLabel,
    );
    assert.ok(row, `Graph acceptance row must define ${label}`);
    return row;
  };
  const materialRow = acceptanceRow(
    ">512 qualified material records across multiple individually valid Revisions",
  );
  assert.match(materialRow, /entities\.len \+ relations\.len \+ material_basis\.evidence_set\.len/);
  assert.match(materialRow, /各 Entity／Relation／Evidence entryを各1件として数える/);
  assert.match(materialRow, /Entity-only bundleもvalid/);
  assert.doesNotMatch(materialRow, /Entity \+ Relation \+ Evidence|record\s*=\s*|組|tuple/i);
  assert.match(materialRow, /exact complete roster.*Entity／Relation／Evidenceの全record.*no missing／no duplicates/);
  const decoyRow = acceptanceRow(">512 unrelated/ineligible candidate Revisions");
  assert.match(decoyRow, /Source／Decision／Freshness／Scope不一致.*qualificationから除外/);
  assert.match(decoyRow, /exact roster.*不変/);
  const rosterRow = acceptanceRow("exact roster invariance");
  assert.match(rosterRow, /Entity／Relation／Evidenceの各recordを全件・同一順序.*missing／duplicateなし/);
  assert.match(
    graphAcceptanceNarrative,
    /qualified material record count = `entities\.len \+ relations\.len \+ material_basis\.evidence_set\.len`.*各 Entity／Relation／Evidence entryを各1件.*Entity-only bundleもvalid.*Revision-ID overhead.*exact complete roster.*no missing／no duplicates/,
  );
  assert.doesNotMatch(
    graphAcceptanceNarrative,
    /(?:whole-project B build|supported capacity|supported work size|build memory|build SQL|deadline)[^\n]*(?:(?:cap|limit|max(?:imum)?)\b[^\n]*\d|deadline\s*[:=]?\s*\d|(?:build memory|build SQL)\s*[:=]?\s*`?\d)/i,
    "Graph acceptance must not ratify a numeric whole-project build cap or deadline",
  );
  return true;
}

function checkIgnore(filePath) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--", filePath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `Unexpected git exit status: ${result.status}`,
  );
  return result.status === 0;
}

test("root build outputs and temporary checkout stay outside Git", () => {
  for (const filePath of [
    "target/debug/deps/example.rlib",
    "target/release/deps/example.rlib",
    "target/nir0-tmp/grimodex-impact-example/.git/HEAD",
    ".tmp-c2-5b-edit/src/example.ts",
  ]) {
    assert.equal(checkIgnore(filePath), true, filePath);
  }
});

test("generated-directory rules do not hide similarly named source directories", () => {
  for (const filePath of [
    "src/target/example.ts",
    "src/.tmp-c2-5b-edit/example.ts",
    "scripts/quality/quality-workflow.test.mjs",
  ]) {
    assert.equal(checkIgnore(filePath), false, filePath);
  }
});

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
  assert.match(
    packageJson.scripts["test:quality"],
    /scripts\/codex-entity-relation-product-journey\.test\.mjs/,
    "the canonical quality command must include the A2 Journey contract",
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

test("entrypoints and scoped skills resolve canonical policy anchors before applicable work", async () => {
  const policyPath = "policies/quality/iron-laws.md";
  const routes = new Map([
    ["AGENTS.md", ["agent-validation", "GDX-PRECHECK-001", "GDX-TRACE-001", "immutable-identity"]],
    [".agents/skills/debug-issue/SKILL.md", ["agent-validation", "GDX-PRECHECK-001", "GDX-TRACE-001"]],
    [".agents/skills/implement-feature/SKILL.md", ["agent-validation", "GDX-PRECHECK-001", "GDX-TRACE-001", "immutable-identity"]],
    [".agents/skills/review-code/SKILL.md", ["agent-validation", "GDX-PRECHECK-001", "GDX-TRACE-001", "immutable-identity"]],
    [".agents/skills/refactor-cross-boundaries/SKILL.md", ["agent-validation", "GDX-PRECHECK-001", "GDX-TRACE-001", "immutable-identity"]],
    [".agents/skills/test-feature/SKILL.md", ["agent-validation", "immutable-identity"]],
    [".agents/skills/explore-codebase/SKILL.md", ["agent-validation"]],
    [".agents/skills/grimodex-author/SKILL.md", ["agent-validation", "GDX-PRECHECK-001"]],
    [".agents/skills/grimodex-impact-gate/SKILL.md", ["agent-validation", "GDX-TRACE-001", "immutable-identity"]],
  ]);
  for (const [sourcePath, anchors] of routes) {
    for (const anchor of anchors) {
      await assertLocalMarkdownLink(sourcePath, policyPath, anchor);
    }
  }

  const agents = await read("AGENTS.md");
  assert.match(agents, /(?:該当|適用).*前に.*読む/);
  for (const [scope, anchor] of [
    [/検証|commit|CI/, "agent-validation"],
    [/高リスク|セキュリティ|lifecycle/, "GDX-PRECHECK-001"],
    [/証跡|PR|merge|release/, "GDX-TRACE-001"],
    [/immutable|child|revision|不変ID/, "immutable-identity"],
  ]) {
    const route = agents.split("\n").find((line) => line.includes(`#${anchor}`));
    assert.match(route, scope, `${anchor} must declare when it applies`);
  }

  const claude = await read("CLAUDE.md");
  assert.match(claude, /^@AGENTS\.md$/m, "Claude must import the shared instruction entrypoint");
  await assertLocalMarkdownLink("README.md", "AGENTS.md");
  for (const skill of [
    "add-electron-command", "bump-version", "debug-issue", "explore-codebase",
    "implement-feature", "polish-motion", "review-code", "ship-branch", "test-feature",
  ]) {
    await assertLocalMarkdownLink(
      `.claude/skills/${skill}/SKILL.md`,
      `.agents/skills/${skill}/SKILL.md`,
    );
  }
});

test("validation scope preserves instruction gates and conditional CI without routine overtesting", async () => {
  const policy = await read("policies/quality/iron-laws.md");
  const validation = normalizeSection(sectionFromAnchor(policy, "agent-validation"));
  assert.match(validation, /Investigation.*review only.*Read-only.*no Quick\/Full/i);
  assert.match(validation, /Ordinary prose.*formatting.*diff.*link checks/i);
  assert.match(validation, /Implementation or bug fix.*Focused checks.*affected boundaries/i);
  assert.match(validation, /AI instructions.*skills.*policy.*contract tests.*grimodex-impact-gate.*Light/i);
  assert.match(validation, /Commit only.*requested candidate commit.*no Quick.*merge-readiness/i);
  assert.match(validation, /PR\/release evidence with CI allowed.*Clean candidate Quick.*immediate verify/i);
  assert.match(validation, /Merge or release tag with CI allowed.*Full and verify.*preflight/i);
  assert.match(validation, /Instruction and policy changes are behavior changes.*Markdown/i);
  assert.match(validation, /successful command result.*same candidate, environment, and command.*rerun when those inputs change/i);
  assert.match(validation, /all-suite fallback.*empty, unavailable, or unclassified diffs.*required acceptance receipt/i);

  const agents = await read("AGENTS.md");
  assert.match(agents, /承認済み.*可逆.*修正・検証.*再承認を求めない/s);
  assert.match(agents, /調査・レビューだけ.*read-only/s);
  assert.match(agents, /commit、push、merge、公開.*依頼範囲/s);
});

test("agent operation contracts keep candidate evidence and bounded identity checks aligned", async () => {
  const ironLaws = await read("policies/quality/iron-laws.md");
  const trace = normalizeSection(
    sectionFromAnchor(ironLaws, "GDX-TRACE-001"),
  );
  const identity = normalizeSection(
    sectionFromAnchor(ironLaws, "immutable-identity"),
  );
  const matrix = await read(
    ".agents/skills/refactor-cross-boundaries/references/impact-matrix.md",
  );
  const createBranch = await read(".agents/skills/create-branch/SKILL.md");
  const ship = await read(".agents/skills/ship-branch/SKILL.md");
  const bump = await read(".agents/skills/bump-version/SKILL.md");
  const runbook = await read("docs/local-ci-runner.md");
  const nirPlan = await read("docs/plans/nir1-l6-l9-execution-plan.md");

  const assertOrder = (text, labels) => {
    let previous = -1;
    for (const [label, pattern] of labels) {
      const index = text.search(pattern);
      assert.ok(index >= 0, `${label} must be present`);
      assert.ok(index > previous, `${label} must follow the preceding operation`);
      previous = index;
    }
  };

  assertOrder(trace, [
    ["focused validation", /focused validation finishes first/],
    ["candidate commit", /candidate commit is created/],
    ["clean candidate", /candidate must be clean/],
    ["Quick", /run local Quick/],
    ["immediate verify", /Quick is immediately verified/],
  ]);
  assert.match(trace, /Quick is immediately verified with the same fixed base\/head values/i);
  assert.match(trace, /Commit-only or CI-excluded work.*without starting Quick.*does not claim merge\/release readiness/i);
  assert.match(trace, /without a requested commit or PR.*does not create a commit or start PR-bound CI solely for Quick/i);
  assert.match(trace, /Normal PR and branch pushes do not start hosted GitHub Actions runners/i);
  assert.match(trace, /absence of hosted PR checks is not evidence of a passing gate/i);
  assert.match(trace, /Windows NSIS final compilation.*separate manual Full CI.*tag-release obligation.*unavailable release-only check is never passed/i);

  for (const contract of [identity, matrix]) {
    assert.match(contract, /immutable child.*revision|immutable.*child.*revision/i);
    assert.match(contract, /親`runId`だけ.*再選択|parent.*runId.*reselect|reselect.*parent.*runId.*alone/is);
    assert.match(contract, /limit.*順序.*cursor.*N\/N\+1|limit.*order.*cursor.*N\/N\+1/i);
    assert.match(contract, /(?:操作対象外|対象外)Decision.*不変|non-target.*Decision.*unchanged/i);
  }
  assert.match(identity, /restor.*Decision.*reread.*display.*receipt.*same.*(?:child|revision).*ID/i);
  assert.match(identity, /(?:limit.*filter|filter.*limit|limit.*不存在|limit.*absence)/i);
  assert.match(identity, /durable ID.*corresponding UI.*projection.*before editing/i);
  assert.match(identity, /selector.*(?:ready|readiness)/i);
  assert.match(runbook, /durable ID.*corresponding UI\s*projection before editing/is);
  assert.match(runbook, /selector.*ready signal/);
  assert.match(runbook, /33 catalog entries as 11\/11\/11 shards/);
  assert.match(
    bump,
    /PR／releaseの証跡が依頼範囲に含まれ.*CIが許可されている場合だけ/is,
  );
  assert.match(
    bump,
    /commit-onlyまたはCI明示除外.*Quickを開始せず.*merge／release readiness/is,
  );
  assert.match(
    bump,
    /commit／PRを依頼していない場合はQuickのためだけにcommitを作らず.*CIも開始しない/is,
  );
  assert.match(bump, /上記のPR／release条件を満たす場合だけ.*Quickと直後のverifyを実行/is);
  assert.match(createBranch, /git worktree add -b/);
  assert.match(createBranch, /保存先とbranch名の衝突/);
  assert.match(createBranch, /明示された新worktreeでは元checkoutのdirty状態は停止条件にせず/);
  assert.match(ship, /依頼が push のみ、PR 作成まで、マージまで.*依頼文から確定/);
  assert.match(ship, /push のみでは.*PR／merge 用 Quick／Full.*開始せず.*remote HEAD 確認で完了/);
  assert.match(ship, /PR 作成までなら.*Quick gate.*完了し.*merge 用 gate へ進まない/);
  assert.match(ship, /auto-merge が有効.*push のみまたは PR 作成だけ.*push せず停止/);
  assert.match(ship, /candidate_base.*candidate_head.*Quick.*verify/is);
  assert.match(
    ship,
    /PR／releaseの証跡が依頼範囲に含まれ.*CIが許可されている場合に限り.*Quick/is,
  );
  assert.match(
    ship,
    /CI明示除外の作業ではQuickを開始せず.*merge／release readiness/is,
  );
  assert.match(ship, /上記のPR／release／CI条件を満たす場合だけ.*Quickと直後のverify/is);
  assert.match(ship, /mergeまでがゴールでCIが許可されている場合.*Full/is);
  assert.match(ship, /CIが明示的に除外されている場合はFullとmergeを開始せず/);
  assert.match(ship, /上記のmerge／CI条件を満たす場合だけ.*Fullと直後のverify/is);
  assert.match(bump, /release commit後.*cleanなHEAD.*Quick.*verify/is);
  assert.match(bump, /release_base.*release_head.*ci:local:full.*ci:local:verify/is);
  assert.match(
    bump,
    /tag／Draft Releaseが依頼範囲に含まれ.*CIが許可され.*mergeが完了した場合だけ.*Full/is,
  );
  assert.match(
    bump,
    /local／commit-only／PR-only.*CI明示除外.*Step 9.*Full／verify／tag／Draft Releaseを開始せず.*release readiness/is,
  );
  assert.match(bump, /上記のrelease／CI／merge条件を満たす場合だけ.*release Fullと直後のverify/is);

  const nirValidationSection = normalizeSection(
    sectionFromHeading(nirPlan, "## 実装時の検証手順"),
  );
  assertOrder(nirValidationSection, [
    ["NIR focused validation", /候補commit前のfocused検証/],
    ["NIR candidate commit", /commitが依頼範囲に含まれる場合/],
    ["NIR clean candidate", /cleanな候補HEAD/],
    ["NIR Quick", /候補commit後のPR用Quick/],
    ["NIR immediate verify", /ci:local:verify -- quick.*candidate_head/is],
  ]);
  assert.match(
    nirValidationSection,
    /PR／releaseの証跡が依頼されCIが許可された場合だけQuickと直後verifyを実行/is,
  );
  assert.match(
    nirValidationSection,
    /commit-onlyまたはCI明示除外の作業ではQuickを開始せず/is,
  );
  assert.doesNotMatch(
    nirPlan,
    /pnpm ci:local:quick -- --base origin\/master --head HEAD/,
    "NIR current instructions must not run Quick against the pre-commit dirty HEAD",
  );
});

test("high-risk work keeps threat models user-confirmed and candidate evidence reproducible", async () => {
  const policy = await read("policies/quality/iron-laws.md");
  const policySection = normalizeSection(
    sectionFromAnchor(policy, "GDX-PRECHECK-001"),
  );
  const traceSection = normalizeSection(
    sectionFromAnchor(policy, "GDX-TRACE-001"),
  );
  const ship = await read(".agents/skills/ship-branch/SKILL.md");
  const shipCiRawSection = sectionFromHeading(
    ship,
    "## 2. ローカルCI gateを固定する",
  );
  const shipCiSection = normalizeSection(
    shipCiRawSection,
  );
  const shipMergePrecheckRawSection = sectionFromHeading(
    ship,
    "## 6. Merge 直前に再検証する",
  );
  const shipMergeSection = normalizeSection(
    sectionFromHeading(ship, "## 7. Merge と反映確認を行う"),
  );
  const manifest = yaml.load(await read("evals/quality-manifest.yaml"));
  const precheck = manifest.requirements.find(
    (requirement) => requirement.id === "GDX-PRECHECK-001",
  );

  function assertPolicyContract(label, pattern) {
    assert.match(policySection, pattern, label + " is missing from GDX-PRECHECK-001");
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
    assertPolicyContract("threat-model precheck contract", phrase);
  }

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
    assertPolicyContract("candidate/reviewer contract", phrase);
  }
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
    /resource.?isolation/i,
    /no competing heavy run/i,
    /writable capacity.*workspace.*build-cache.*temp/i,
    /root\/home.*pressure.*temp quota/i,
    /runtime performance.*fresh Xvfb/i,
    /migration\/recovery/i,
    /real product journeys/i,
    /diagnostic only/i,
    /clean Full-from-stage-1 \+ verify/i,
  ]) {
    assertPolicyContract("focused preflight contract", phrase);
  }
  assert.match(policySection, /examples, not blanket requirements/i);
  assert.match(policySection, /inapplicable host capability/i);

  for (const phrase of [
    /external.?egress.*subprocess.*background.*async.?lifecycle/i,
    /finite owner\/lifecycle matrix/i,
    /entry\/start\/retry\/reentrant/i,
    /admission closure.*pending-start.*active handle ownership.*cancellation.*bounded wait/i,
    /close\/exit\/terminal receipt.*error\/timeout\/onClosed.*persisted restart state/i,
    /kill request.*error event.*rejected promise.*termination proof/i,
    /high.?effort review.*candidate-untouched independent acceptance.*P2\+/i,
  ]) {
    assertPolicyContract("lifecycle-owner precheck contract", phrase);
  }
  assert.match(
    policySection,
    /before mutation.*every entry\/start\/retry\/reentrant path/i,
  );
  assert.match(
    policySection,
    /any fixed capacity\/quota threshold.*percentage.*inode.*numeric.*host-specific cache deletion list.*deletion automation/i,
  );
  assert.match(policySection, /thresholds.*risk, workload, and filesystem state.*hardcoding/i);
  assert.match(
    shipCiSection,
    /any fixed capacity\/quota threshold.*percentage.*inode.*numeric.*host-specific cache deletion list.*deletion automation/i,
  );

  for (const phrase of [
    /unattributed runtime blocker/i,
    /causal evidence/i,
    /rAF.*event-loop.*wake\/discovery.*memory-sampler.*process CPU\/I\/O.*device\/PSI/i,
    /exact failed receipt/i,
    /diagnostic\/P3 debt/i,
    /critical candidate/i,
  ]) {
    assertPolicyContract("runtime/debt contract", phrase);
  }
  assert.match(policySection, /Do not infer environment or product status from touched paths/i);

  for (const phrase of [
    /data categories.*permission/i,
    /claude-fable-5-1/i,
    /effort.*high/i,
    /Fast/i,
  ]) {
    assertPolicyContract("external-review model contract", phrase);
  }
  assert.match(policySection, /external Claude review.*start-of-work precheck/i);
  assert.match(policySection, /requested and effective model/i);
  assert.match(policySection, /never silently substitute/i);
  assert.match(policySection, /not blanket.*all repositories or logs/i);

  for (const phrase of [
    /acceptance evidence.*directly candidate-bound.*verified parent receipt.*candidate-bound/i,
    /metrics or artifacts.*independently.*parent receipt.*direct.*candidate identity.*commit\/tree\/run.*artifact digest/i,
    /standalone evidence.*diagnostic-only/i,
    /Missing direct binding.*tracked hardening debt.*retroactively invalidate.*complete parent receipt/i,
    /candidate freeze.*exact candidate.*once.*receipt\/ledger/i,
    /expected-head.*push.*merge.*state/i,
    /merge commit.*included.*origin\/master/i,
    /upstream-base.*candidate HEAD.*PR diff.*editorial docs\/ADR-only/i,
    /exception.*proportionate.*static\/focused checks.*old receipt.*old base/i,
    /ambiguity.*candidate HEAD.*invalidates?.*Full-from-stage-1 \+ verify/i,
  ]) {
    assert.match(traceSection, phrase);
  }
  assert.match(
    shipCiSection,
    /candidate freeze.*ledger.*resolvedBaseSha.*resolvedHeadSha.*currentHeadSha.*tree.*once.*Full receipt.*同じtuple/i,
  );
  const fullBindings = commandBindings(
    shipCiRawSection,
    "pnpm ci:local:full",
    "Full",
  );
  assert.equal(fullBindings.length, 1, "one written Full command is required");
  const fullVerifyBindings = commandBindings(
    shipCiRawSection,
    "pnpm ci:local:verify -- full",
    "Full verify",
  );
  const mergeVerifyBindings = commandBindings(
    shipMergePrecheckRawSection,
    "pnpm ci:local:verify -- full",
    "merge-precheck Full verify",
  );
  for (const binding of [...fullVerifyBindings, ...mergeVerifyBindings]) {
    assert.deepEqual(binding, fullBindings[0]);
  }
  assert.equal(fullBindings[0].base, '"$candidate_base"');
  assert.equal(fullBindings[0].head, '"$candidate_head"');
  assert.doesNotMatch(
    shipMergePrecheckRawSection,
    /pnpm ci:local:verify -- full\s+--base\s+origin\/master\s+--head\s+HEAD/i,
    "merge precheck must not substitute origin/master and HEAD",
  );
  const fetchBeforeApproval = shipMergePrecheckRawSection.indexOf(
    "git fetch origin master",
  );
  const approvedMergeBase = shipMergePrecheckRawSection.indexOf(
    "approved_merge_base",
  );
  assert.ok(fetchBeforeApproval >= 0, "merge precheck must fetch before approval");
  assert.ok(
    approvedMergeBase > fetchBeforeApproval,
    "merge precheck must fetch before base approval/classification",
  );
  for (const section of [policySection, traceSection]) {
    assert.match(
      section,
      /candidate(?:[_ ]base).*(?:candidate(?:[_ ]head)|and head).*(?:once|一度だけ).*Full.*(?:every verify|全verify)/i,
      "candidate refs must be pinned before Full",
    );
    assert.match(
      section,
      /approved_merge_base/i,
      "one approved merge base must be recorded",
    );
  }
  assert.match(policySection, /first parent.*<merge-sha>\^1.*approved.*merge-base/i);
  for (const section of [policySection, traceSection, shipMergeSection]) {
    assert.match(
      section,
      /non.?squash.*before merge.*method.?specific.*actual.?base.*post.?merge.*defined.*approved.*stop/i,
      "non-squash merges require an approved method-specific procedure before execution",
    );
    assert.match(
      section,
      /non.?squash.*(?:do not reuse|not reuse|流用しない).*squash.*first.?parent/i,
      "non-squash merges must not reuse the squash first-parent rule",
    );
    assert.match(
      section,
      /squash merge.*first parent/i,
      "first-parent verification must be scoped to squash merges",
    );
  }
  assert.match(shipCiSection, /push.*merge.*expected-head/i);
  assert.doesNotMatch(shipCiSection, /patch.?digest/i);
  assert.match(
    shipMergeSection,
    /git fetch origin master.*merge commit.*origin\/master.*含まれる/i,
  );
  assert.match(
    shipMergeSection,
    /expected head.*merge commit.*origin\/master.*包含.*成功扱いにしない/i,
  );
  assert.match(
    shipMergeSection,
    /first parent.*<merge-sha>\^1.*approved_merge_base/i,
  );
  assert.match(
    shipMergeSection,
    /non.?squash.*before merge.*method.?specific.*actual.?base.*post.?merge.*defined.*approved.*stop/i,
  );
  assert.match(
    shipMergeSection,
    /non.?squash.*(?:do not reuse|not reuse|流用しない).*squash.*first.?parent/i,
  );
  assert.doesNotMatch(
    shipMergeSection,
    /(?:all|every|全)(?: merge methods|方式).*first.?parent/i,
    "the squash first-parent rule must not be universal",
  );
  assert.match(
    shipMergeSection,
    /parent mismatch.*not report verified success.*newly added base delta.*merge may have occurred.*acceptance evidence.*not valid/i,
  );
  assert.doesNotMatch(shipMergeSection, /git rev-parse <merge-sha>\^\{tree\}/i);
  assert.match(ship, /SHAは不一致.*ユーザーが求めた場合だけ/i);

  assert.ok(precheck, "GDX-PRECHECK-001 must exist");
  const trace = manifest.requirements.find(
    (requirement) => requirement.id === "GDX-TRACE-001",
  );
  assert.ok(trace, "GDX-TRACE-001 must exist");
  assert.ok(
    precheck.implementedBy.includes("AGENTS.md"),
    "AGENTS.md must be traced under GDX-PRECHECK-001",
  );
  for (const implementationPath of [
    ".agents/skills/implement-feature/SKILL.md",
    ".agents/skills/review-code/SKILL.md",
    ".agents/skills/refactor-cross-boundaries/SKILL.md",
    ".agents/skills/refactor-cross-boundaries/references/impact-matrix.md",
    ".agents/skills/ship-branch/SKILL.md",
  ]) {
    assert.ok(
      precheck.implementedBy.includes(implementationPath),
      `${implementationPath} must be traced under GDX-PRECHECK-001`,
    );
  }
  assert.ok(
    precheck.lightTests.includes("scripts/quality/quality-workflow.test.mjs"),
    "the contract test must remain in the precheck light suite",
  );
  assert.ok(
    trace.implementedBy.includes("AGENTS.md"),
    "AGENTS.md must be traced under GDX-TRACE-001",
  );
  for (const entrypoint of ["CLAUDE.md", "GLOBAL_CLAUDE.md"]) {
    assert.ok(precheck.implementedBy.includes(entrypoint), entrypoint);
    assert.ok(trace.implementedBy.includes(entrypoint), entrypoint);
  }
  for (const skill of [
    "add-electron-command", "bump-version", "debug-issue", "explore-codebase",
    "implement-feature", "polish-motion", "review-code", "ship-branch", "test-feature",
    "update-licenses",
  ]) {
    const adapter = `.claude/skills/${skill}/SKILL.md`;
    assert.ok(trace.implementedBy.includes(adapter), `${adapter} must preserve traceability`);
  }
  assert.ok(
    trace.implementedBy.includes(".agents/skills/ship-branch/SKILL.md"),
    "ship-branch must be traced under GDX-TRACE-001",
  );
  for (const implementationPath of [
    ".agents/skills/implement-feature/SKILL.md",
    ".agents/skills/review-code/SKILL.md",
    ".agents/skills/refactor-cross-boundaries/SKILL.md",
    ".agents/skills/refactor-cross-boundaries/references/impact-matrix.md",
    "src/lib/tauri.ts",
  ]) {
    assert.ok(
      trace.implementedBy.includes(implementationPath),
      `${implementationPath} must be traced under GDX-TRACE-001`,
    );
  }
});

test("NIR-1 preserves R0 history, records effective typed ratification, and keeps runtime gated", async () => {
  const executionPlan = await read("docs/plans/nir1-l6-l9-execution-plan.md");
  const roadmap = await read("docs/plans/narrative-semantic-core-roadmap.md");
  const integrationPlan = await read(
    "docs/plans/narrative-ir-nir1-implementation-plan.md",
  );
  const qualityManifest = yaml.load(await read("evals/quality-manifest.yaml"));
  const integrationValidationSection = normalizeSection(
    sectionFromHeading(
      integrationPlan,
      "## 8. 独立受入れ・候補管理・Quick / Full / verify",
    ),
  );

  assert.match(executionPlan, /PR-R0.*履歴台帳と評価契約の固定/is);
  assert.match(
    executionPlan,
    /基点:\s*master@9f6aba5f/,
  );
  assert.match(
    executionPlan,
    /Tree:\s*b7f97fc7dbbb5243da090b41dbc884ecfdc0ec2b/,
  );
  assert.match(
    executionPlan,
    /2026-09-17現在.*#596\/\#597 foundations.*#598 A3 review remediation.*masterにある.*Graph.*Packing.*AI dispatch.*未activate.*B.*capacity-remediation-in-progress.*proposal\/5.*確認済み/is,
  );
  assert.match(executionPlan, /Graph.*Packing.*未activate.*downstream threat model.*draft/is);
  assert.match(executionPlan, /NIR-1全体.*未完了/);
  const a2Heavy = qualityManifest.heavyEvaluations.find(
    (evaluation) => evaluation.id === "heavy-nir1-entity-relation-product-journey",
  );
  assert.equal(
    a2Heavy?.command,
    "GRIMODEX_PRODUCT_JOURNEY_SET=nir1-entity-relation-review pnpm electron:product-journeys",
    "A2 Heavy must run against its one-entry subset catalog",
  );
  assert.match(
    executionPlan,
    /\| requestedBase \/ resolvedBase \| `master@68516b033f395f24f98c502c9fd2a715d7aec2af`/,
    "R0 base remains in the historical ledger",
  );
  assert.match(executionPlan, /#572の実装済み／未完了/);
  assert.match(
    executionPlan,
    /production runtime integration.*activation.*L6〜L9.*未完了/is,
  );

  const contractIds = [
    "scope-storage-authority",
    "caller-profile-egress",
    "typed-revision-material",
    "graph-limited-binding",
    "native-generation-receipt",
    "history-reauthorization",
  ];
  for (const contractId of contractIds) {
    assert.match(executionPlan, new RegExp(contractId));
  }
  assert.equal(
    (executionPlan.match(/blocked\(ref-unverified\)/g) ?? []).length,
    0,
    "no contract remains ref-unverified after the explicit typed ratification",
  );
  assert.doesNotMatch(
    executionPlan,
    /contract-delta-unresolved/,
    "the selected typed family must be concrete; no contract delta remains unresolved",
  );
  assert.match(executionPlan, /accepted ADR009/);
  assert.match(executionPlan, /accepted ADR010/);
  assert.match(executionPlan, /accepted ADR011/);
  assert.match(executionPlan, /nir1-plan\/1.*L0〜L5/);
  assert.match(executionPlan, /nir1-product-tm\/1.*L0〜L5/);
  assert.doesNotMatch(
    executionPlan,
    /none — ref-unverified|unconfirmed typed|typed-revision-material[^\n]*unconfirmed/i,
    "the explicitly ratified typed row must not retain stale unconfirmed state",
  );
  assert.doesNotMatch(
    executionPlan,
    /canonical_application_freshness/,
    "the typed ratification must not widen the Freshness authority",
  );
  assert.doesNotMatch(
    executionPlan,
    /typed-ratification candidate|ratification PR|ratification[- ]merge|pending-typed-revision-material-ratification-merge|effective only when this ratification PR merges|becomes effective only when this ratification PR merges/i,
    "the execution plan must not retain pre-merge typed-ratification state",
  );
  assert.doesNotMatch(executionPlan, /本書・既存計画のproducer/);
  for (const field of [
    "confirmedRef",
    "confirmedScope",
    "remainingDelta",
    "affectedLanes",
    "startStatus",
    "blockedReason",
    "unblockingEvidence",
  ]) {
    assert.match(executionPlan, new RegExp(field));
  }

  const proposal3Ref = "nir1-l6-l9-contract-proposal/3";
  const typedDraftRef = "nir1-l6-l9-contract-proposal/4";
  const graphDraftRef = "nir1-l6-l9-contract-proposal/5";
  const confirmedContractIds = [
    "scope-storage-authority",
    "caller-profile-egress",
    "typed-revision-material",
    "graph-limited-binding",
    "native-generation-receipt",
    "history-reauthorization",
  ];
  const confirmedRefFor = (contractId) =>
    `${contractId === "typed-revision-material" ? typedDraftRef : contractId === "graph-limited-binding" ? graphDraftRef : proposal3Ref}#${contractId}`;
  const ledgerSection = executionPlan
    .split("### 契約別の確認台帳\n", 2)[1]
    ?.split("\n### R0 security contract proposal (draft)", 1)[0];
  assert.ok(ledgerSection, "R0 contract ledger must be present");
  const ledgerRows = contractIds.map((contractId) => {
    const row = ledgerSection
      .split("\n")
      .find((line) => line.startsWith(`| \`${contractId}\` |`));
    assert.ok(row, `${contractId} must have a ledger row`);
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    assert.equal(cells.length, 9, `${contractId} ledger shape`);
    const draftRef = cells[1].replaceAll("`", "");
    const confirmedRef = cells[2].replaceAll("`", "");
    if (confirmedContractIds.includes(contractId)) {
      assert.equal(confirmedRef, confirmedRefFor(contractId));
      if (contractId === "graph-limited-binding") {
        assert.equal(draftRef, graphDraftRef);
        assert.match(
          cells[3],
          /proposal\/5 confirmed scope.*(?:three resource unit|三つのresource unit).*finalized P2 boundaries/,
        );
        assert.match(
          cells[4],
          /none.*proposal\/5 is explicitly confirmed.*B full-set numbers additionally ratified on 2026-09-22.*product activation is not ratified/,
        );
        assert.equal(cells[6], "b-close-complete");
        assert.match(
          cells[7],
          /exact confirmation is recorded.*B implementation and required focused evidence are complete.*C remains gated.*product activation/,
        );
        assert.match(
          cells[8],
          /I confirm draftRef nir1-l6-l9-contract-proposal\/5 for contractId graph-limited-binding\./,
        );
      } else if (contractId === "typed-revision-material") {
        assert.equal(draftRef, typedDraftRef);
        assert.match(
          cells[3],
          /proposal\/4 scope only.*Option B.*Entity／Relation-only.*nir1\.entity-relation@1/,
        );
        assert.match(
          cells[4],
          /none.*proposal\/4 Option B.*explicitly ratified and effective.*implementation／acceptance remains dependency-gated/,
        );
        assert.equal(cells[6], "ready-after-R0-merge");
        assert.match(
          cells[7],
          /exact user confirmation.*A1／D2a／normal dependencies.*implementation／acceptance/,
        );
        assert.match(
          cells[8],
          /I confirm draftRef nir1-l6-l9-contract-proposal\/4 for contractId typed-revision-material\./,
        );
        assert.match(cells[8], /independently ratifies only this row/);
      } else {
        assert.equal(draftRef, proposal3Ref);
        assert.match(cells[3], /proposal\/3 scope only/);
        assert.equal(cells[6], "ready-after-R0-merge");
      }
      if (
        contractId !== "typed-revision-material" &&
        contractId !== "graph-limited-binding"
      ) {
        assert.match(cells[7], /explicit user confirmation recorded/);
      }
      if (contractId !== "graph-limited-binding") {
        assert.match(cells[8], new RegExp(escapeRegExp(confirmedRefFor(contractId))));
      }
    } else {
      assert.fail(`${contractId} should be explicitly confirmed`);
    }
    return row;
  });
  assert.equal(ledgerRows.length, 6);
  assert.equal(
    ledgerRows.filter((row) => row.includes("ready-after-R0-merge")).length,
    5,
    "the five confirmed baseline/typed contract rows are effective after the R0 merge",
  );
  assert.equal(
    ledgerRows.filter((row) => row.includes("b-close-complete")).length,
    1,
    "the graph row records B-close completion without activating Graph consumers",
  );
  assert.match(
    executionPlan,
    /R0でmerge済みのproposal\/3五つ.*PR #579.*Option B.*明示批准済み.*契約として有効/is,
  );
  assert.match(executionPlan, /明示確認済み・契約として有効.*第六行.*A2はA1＋D2a/is);
  assert.doesNotMatch(executionPlan, /nir1-l6-l9-contract-proposal\/1/);
  assert.doesNotMatch(executionPlan, /nir1-l6-l9-contract-proposal\/2/);

  const proposalSection = executionPlan
    .split("### R0 security contract proposal (draft)\n", 2)[1]
    ?.split("\n### R0 lane開始判定と評価manifest", 1)[0];
  assert.ok(proposalSection, "R0 security contract proposal must be present");
  assert.match(
    proposalSection,
    /proposal\/3五つのcontract row.*PR #579.*Option Bのtyped row.*明示批准済み.*契約として有効/is,
  );
  for (const confirmationRule of [
    /Confirmation protocol.*only an explicit user statement naming the exact `draftRef` and one `contractId` confirms that one row/is,
    /stable ledger form is `draftRef#contractId`/,
    /four.*refs.*record separate confirmations.*exactly `scope-storage-authority`.*`caller-profile-egress`.*`native-generation-receipt`.*`history-reauthorization`/is,
    /Plan agreement.*not a ratification/is,
    /active goal.*not a ratification/is,
    /merge instruction.*not a ratification/is,
    /this proposal is fine.*not a ratification/is,
    /Confirming one row does not confirm its dependencies/i,
    /user-selected Option B family is concrete.*independently ratified.*typed-revision-material.*nir1-l6-l9-contract-proposal\/4/is,
    /proposal\/5 graph capacity delta requires the separate exact statement.*nir1-l6-l9-contract-proposal\/5.*graph-limited-binding/is,
    /confirmation is limited to the Entity／Relation-only family.*never widens to a generic consumer／authority/is,
  ]) {
    assert.match(proposalSection, confirmationRule);
  }
  assert.match(
    proposalSection,
    /I confirm draftRef nir1-l6-l9-contract-proposal\/4 for contractId typed-revision-material\./,
  );
  assert.match(
    proposalSection,
    /I confirm draftRef nir1-l6-l9-contract-proposal\/5 for contractId graph-limited-binding\./,
  );
  assert.match(
    proposalSection,
    /runtime(?:／consumer)? activation[^\n]*(?:追加しない|未完了)/i,
  );
  assert.doesNotMatch(
    proposalSection,
    /remains unconfirmed|ref-unverified|contract-delta-unresolved/i,
    "the exact typed ratification must clear stale pending markers",
  );
  assert.doesNotMatch(
    proposalSection,
    /canonical_application_freshness/,
    "the typed ratification must not introduce a second Freshness authority",
  );
  assert.doesNotMatch(
    proposalSection,
    /activation\s*[:：]\s*(?:enabled|active|on|有効)/i,
  );
  for (const contractId of contractIds) {
    const heading = `#### ${contractId}\n`;
    const headingOffset = proposalSection.indexOf(heading);
    assert.notEqual(headingOffset, -1, `${contractId} proposal must be present`);
    const bodyStart = headingOffset + heading.length;
    const nextHeadingOffset = proposalSection.indexOf("\n#### ", bodyStart);
    const proposal = proposalSection.slice(
      bodyStart,
      nextHeadingOffset === -1 ? proposalSection.length : nextHeadingOffset,
    );
    for (const category of [
      "Trusted actors",
      "Untrusted actors",
      "In-scope attacks",
      "Out-of-scope attacks",
      "Mandatory defenses",
    ]) {
      assert.match(
        proposal,
        new RegExp(`^- ${escapeRegExp(category)}:`, "m"),
        `${contractId} must define ${category}`,
      );
    }
    const acceptanceFields = [
      "Acceptance implications",
      "Positive",
      "Negative",
      "Recovery",
      contractId === "typed-revision-material"
        ? "Lane unlocked after normal dependencies"
        : contractId === "graph-limited-binding"
          ? "Lane unlocked only after exact proposal/5 confirmation"
          : "Lane unlocked if confirmed",
    ];
    for (const acceptanceField of acceptanceFields) {
      assert.match(
        proposal,
        new RegExp(
          `${escapeRegExp(acceptanceField)}${
            acceptanceField === "Lane unlocked only after exact proposal/5 confirmation"
              ? ""
              : ":"
          }`,
          "i",
        ),
        `${contractId} must define ${acceptanceField}`,
      );
    }
    if (contractId === "graph-limited-binding") {
      const graphBounds = [
        "admission `512`",
        "batch `16x32`",
        "SQL `100,000 VM steps`",
        "cancellation every `1,000` steps",
        "Graph `8ms`",
        "reader／busy wait `0`",
        "oversized row",
        "allocation前",
        "JSON／material processing中",
      ];
      for (const graphSection of [
        "In-scope attacks",
        "Mandatory defenses",
        "Acceptance implications",
      ]) {
        assert.match(
          proposal,
          new RegExp(`^- ${escapeRegExp(graphSection)}:`, "m"),
          `graph binding must state bounds in ${graphSection}`,
        );
        const sectionStart = proposal.indexOf(`- ${graphSection}:`);
        const sectionBodyStart = sectionStart + graphSection.length + 3;
        const nextSection = proposal.indexOf("\n- ", sectionBodyStart);
        const sectionBody = proposal.slice(
          sectionBodyStart,
          nextSection === -1 ? proposal.length : nextSection,
        );
        for (const bound of graphBounds) {
          assert.match(
            sectionBody,
            new RegExp(escapeRegExp(bound)),
            `graph binding ${graphSection} must preserve ${bound}`,
          );
        }
      }
      assert.match(proposal, /Threshold changes require reconfirmation/);
      validateGraphProposalContract(executionPlan);
      const mutateBoundedGraphProposal = (mutator) => {
        const graphStart = executionPlan.indexOf("#### graph-limited-binding\n");
        const graphEnd = executionPlan.indexOf(
          "\n#### native-generation-receipt",
          graphStart,
        );
        assert.ok(graphStart >= 0, "mutation target Graph proposal must be present");
        assert.ok(graphEnd > graphStart, "mutation target Graph proposal must be bounded");
        const boundedProposal = executionPlan.slice(graphStart, graphEnd);
        const mutatedProposal = mutator(boundedProposal);
        assert.notEqual(
          mutatedProposal,
          boundedProposal,
          "Graph mutation must change the bounded proposal section",
        );
        return `${executionPlan.slice(0, graphStart)}${mutatedProposal}${executionPlan.slice(graphEnd)}`;
      };
      const graphMutationCases = [
        {
          label: "numeric supported capacity",
          expected: "Graph proposal must not ratify a numeric whole-project build cap or deadline",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "\n##### Proposal/5 acceptance split (confirmed contract)",
              "\nsupported capacity = 2048 records\n##### Proposal/5 acceptance split (confirmed contract)",
            ),
        },
        {
          label: "numeric whole-project deadline",
          expected: "Graph proposal must not ratify a numeric whole-project build cap or deadline",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "\n##### Proposal/5 acceptance split (confirmed contract)",
              "\nwhole-project B build deadline is 8ms\n##### Proposal/5 acceptance split (confirmed contract)",
            ),
        },
        {
          label: "persistent staging",
          expected: "Graph lifecycle must not create or use persistent staging",
          mutate: (boundedProposal) =>
            boundedProposal.replace("persistent stagingは作らない", "persistent stagingを作る"),
        },
        {
          label: "persistent adjacency",
          expected: "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace("persistent adjacencyは追加しない", "persistent adjacencyを追加する"),
        },
        {
          label: "new authority",
          expected: "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "新しいauthority、schema、consumer、persistent adjacencyは追加しない",
              "新しいauthorityを追加する",
            ),
        },
        {
          label: "new schema",
          expected: "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "新しいauthority、schema、consumer、persistent adjacencyは追加しない",
              "新しいschemaを追加する",
            ),
        },
        {
          label: "new consumer",
          expected: "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "新しいauthority、schema、consumer、persistent adjacencyは追加しない",
              "新しいconsumerを追加する",
            ),
        },
        {
          label: "new framework",
          expected: "Graph lifecycle must not create a new framework",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "新しいframework、authority、schema、consumer、persistent adjacencyを作らない",
              "新しいframeworkを作る",
            ),
        },
        {
          label: "unowned Source full scan",
          expected: "Source re-resolution must reject unowned or unbounded scanning",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "Source re-resolution: maintenance entryのowner／caller connection／read transaction／progress hookでcurrent Sourceを再解決し、unowned／unbounded full-roster scanを開始しない",
              "Source re-resolution: maintenance entryのowner／caller connection／read transaction／progress hookでcurrent Sourceを再解決し、unowned／unbounded full-roster scanを開始する",
            ),
        },
        {
          label: "unowned coverage full scan",
          expected: "complete registration/coverage verification must reject unowned or unbounded scanning",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "complete registration/coverage verification (`is_complete_registered`): 同じowned validation attemptで全件registration／coverageを検証し、unowned／unbounded full-roster scanを開始しない",
              "complete registration/coverage verification (`is_complete_registered`): 同じowned validation attemptで全件registration／coverageを検証し、unowned／unbounded full-roster scanを開始する",
            ),
        },
        {
          label: "unowned reopen full scan",
          expected: "restore/cold reopen verification must reject unowned or unbounded scanning",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "restore/cold reopen verification: 同じowned validation attemptでsealed generation、Source、D1、complete rosterを再検証し、unowned／unbounded full-roster scanを開始しない",
              "restore/cold reopen verification: 同じowned validation attemptでsealed generation、Source、D1、complete rosterを再検証し、unowned／unbounded full-roster scanを開始する",
            ),
        },
        {
          label: "query synchronous full scan",
          expected: "query-triggered validation must be deferred to an owned maintenance entry",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "queryはvalidation read transactionへsynchronously入らない",
              "queryはvalidation read transactionへsynchronously入る",
            ),
        },
        {
          label: "optional whole-build peak",
          expected: "full build and maintenance memory accounting must cover every major retained structure",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "`mandatory end-to-end peak memory for the full build-through-publish interval`",
              "`optional end-to-end peak memory for the full build-through-publish interval`",
            ),
        },
        {
          label: "roster-only peak",
          expected: "full build and maintenance memory accounting must cover every major retained structure",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "roster bytesとRevision-ID overheadはcomponents onlyとして別に報告する",
              "roster bytes only are reported",
            ),
        },
        {
          label: "missing major structure accounting",
          expected: "full build and maintenance memory accounting must cover every major retained structure",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "snapshot roster＋dependency edges",
              "snapshot roster",
            ),
        },
        {
          label: "per-edge cancellation coercion",
          expected: "cancellation must terminate the whole maintenance attempt",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "cancel／timeout／closedはper-edge missing／diagnosticやsuccessful verificationへcoerceせずwhole attemptをterminateする",
              "cancel／timeout／closedをper-edge missing／diagnosticへcoerceしてscanを続ける",
            ),
        },
      ];
      for (const { label, expected, mutate } of graphMutationCases) {
        assert.throws(
          () => validateGraphProposalContract(mutateBoundedGraphProposal(mutate)),
          (error) => {
            assert.match(error.message, new RegExp(escapeRegExp(expected)));
            return true;
          },
          `${label} mutation must be rejected by the bounded Graph validator`,
        );
      }
      assert.match(
        proposal,
        /No cumulative build SQL cap is ratified\.?[^\n]*Every prepare／page／publish complete-rescan statement is owned by the builder's connection-level progress hook.*bounded `1,000` VM-step cadence and at Rust boundaries/is,
        "graph build SQL must remain uncapped while every statement observes bounded cancellation",
      );
      assert.match(
        proposal,
        /interruption／error／timeout／closed.*statement termination／error.*transaction rollback／close.*hook reset.*reader／handles／buffers release.*retry／reentrant admission/is,
        "graph interruption cleanup must complete before retry or reentrant admission",
      );
      const lifecycleStart = proposal.indexOf(
        "##### B build owner/lifecycle (proposal/5 confirmed contract)",
      );
      const acceptanceStart = proposal.indexOf(
        "##### Proposal/5 acceptance split (confirmed contract)",
      );
      assert.ok(lifecycleStart >= 0, "graph lifecycle matrix must be present");
      assert.ok(acceptanceStart > lifecycleStart, "graph acceptance split must follow lifecycle");
      const lifecycle = proposal.slice(lifecycleStart, acceptanceStart);
      assert.match(
        lifecycle,
        /\| lifecycle case \| entry／start \| admission closure \| pending-start work \| active handles \| cancellation／bounded wait \| actual terminal proof \| error／timeout／onClosed ownership \| persisted restart \|/,
        "graph lifecycle matrix must expose each finite ownership field",
      );
      for (const lifecycleCase of [
        "entry／start",
        "retry／reentrant",
        "admission closure",
        "cancellation",
        "error／timeout／onClosed",
        "reopen",
      ]) {
        assert.match(
          lifecycle,
          new RegExp(`\\| ${escapeRegExp(lifecycleCase)} \\|`),
          `graph lifecycle matrix must cover ${lifecycleCase}`,
        );
      }
      assert.match(
        lifecycle,
        /cancel ownerはbuilder.*statement termination／error.*transaction rollback／close.*hook reset.*reader／handles／buffers release.*retry／reentrant admission/,
        "graph cancellation row must prove owner and cleanup ordering",
      );
      assert.match(
        lifecycle,
        /cold reopen.*sealed generation.*persisted restart stateから再開しない/is,
        "graph reopen lifecycle must use sealed generation only",
      );
      assert.match(
        lifecycle,
        /actual terminal proof.*statement termination／error.*rollback／close/is,
        "graph lifecycle must require an observed terminal proof",
      );
      assert.match(
        lifecycle,
        /persisted restart state(?:なし|を作らず|は作らない).*sealed generation/is,
        "graph retry and reopen must not persist restart state",
      );
      assert.match(
        lifecycle,
        /statement termination／error.*transaction rollback／close.*hook reset.*reader／handles／buffers release.*retry／reentrant admission/,
        "phase cleanup must finish before retry or reentrant admission",
      );
      const acceptanceRows = acceptanceStart >= 0
        ? proposal.slice(acceptanceStart).split("\n")
        : [];
      const acceptanceRow = (label) => {
        const normalizedLabel = label.replaceAll("`", "");
        const row = acceptanceRows.find(
          (line) =>
            line.startsWith("|") &&
            line.split("|")[1]?.replaceAll("`", "").trim() === normalizedLabel,
        );
        assert.ok(row, `graph acceptance row must define ${label}`);
        return row;
      };
      const cancellationRow = acceptanceRow("cancellation recovery");
      assert.match(
        cancellationRow,
        /statement termination／error.*transaction rollback／close.*hook reset.*reader／handles／buffers release.*retry／reentrant admission/,
      );
      const reopenRow = acceptanceRow("cold reopen");
      assert.match(reopenRow, /完成したsealed generationだけ.*incomplete build state.*persisted restart state/);
      const atomicRow = acceptanceRow("atomic visibility");
      assert.match(atomicRow, /旧sealed generationまたは全件qualified.*partial／mixed generation/);
      assert.doesNotMatch(
        proposal,
        />512` valid candidates across multiple revisions/,
        "graph acceptance must use qualified material records rather than ambiguous candidates",
      );
      for (const [pattern, label] of [
        [/三つのresource unit/, "three resource units"],
        [/512 records.*2 MiB.*validation contract/, "Revision bundle validation limits"],
        [/read／admission `512`.*batch `16x32`.*SQL `100,000 VM steps`.*`2 MiB`.*Graph `8ms`.*reader／busy wait `0`/, "seed-local query limits"],
        [/whole-project B Index build.*現在の全候補.*qualified material.*atomic publish/, "whole-project build scope"],
        [/queryの合計値はbuildのcandidate count、compact roster count、cumulative bytes、cumulative SQLをcapしない/, "query totals must not cap build totals"],
        [/small／keyset pages.*一度に一つのA2 Revision/, "paged one-revision-at-a-time build"],
        [/allocation前にsizeを検査.*JSON／material processing中にもcancellation/, "pre-allocation and material cancellation guards"],
        [/publish直前にexact complete roster、Source、D1を再検証.*partial generationを残さず/, "publish barrier and no partial generation"],
        [/caller-ownedな単一read transaction.*pin/, "single caller-owned read transaction"],
        [/pinした同一read transaction内.*page間でtransaction／mutexを解放しない/, "page statements stay inside the pinned read transaction"],
        [/page途中のretryは行わず.*snapshot全体を破棄/, "retry restarts from a fresh snapshot"],
        [/source／decision／scope drift at barriers.*cancellation recovery.*cold reopen.*atomic visibility.*query independence/is, "deterministic semantic gates"],
        [/Capacity benchmark metricsは、compact full rosterとpublish-time complete rescanを含めて第1診断stage.*numeric build capacityの批准ではない.*mandatory end-to-end peak memory.*full-set maintenance path/is, "measurement precedes build capacity"],
        [/roster bytesとRevision-ID overheadはcomponents only.*snapshot roster＋dependency edges.*method／coverage／uncertainty/, "capacity benchmark memory accounting"],
        [/supported work size／build memory／SQL／deadlineはその結果から後で選ぶ/, "supported build values are selected after measurement"],
      ]) {
        assert.match(
          proposal,
          pattern,
          `graph binding must define ${label}`,
        );
      }
    }
    if (contractId === "native-generation-receipt") {
      for (const terminalCase of [
        "succeeded + parsed + required",
        "failed + invalid + required",
        "failed + not-attempted + null",
        "cancelled + not-attempted + null",
        "skipped + not-attempted + null",
      ]) {
        assert.match(
          proposal,
          new RegExp(escapeRegExp(terminalCase)),
          `receipt matrix must include ${terminalCase}`,
        );
      }
      assert.match(proposal, /queued \| running.*non-terminal execution state/);
      assert.doesNotMatch(proposal, /terminal matrix[^\n]*queued \| running/);
      for (const receiptRule of [
        /provider terminal/i,
        /parseStatus/i,
        /responseDigest/i,
        /message version/i,
        /raw text.*thinking.*分離/i,
        /raw body／thinkingを重複保存せず/,
        /既存body／artifactへの参照/,
        /domain-separatedなtext／thinking digest/,
        /versioned stable chunk-order digest.*chunk-boundary invariant.*order-sensitive/is,
        /trim.*Unicode normalization.*行わない/is,
        /provider terminalなしのEOF/i,
        /length truncation/i,
        /dispatch failure.*cancel path.*skip path/is,
        /exactly one terminal receipt.*durably persist/is,
        /successful generation qualification／publicationからのみreject/,
      ]) {
        assert.match(proposal, receiptRule);
      }
      assert.doesNotMatch(proposal, /terminal receiptを発行せずreject/);
      const mandatoryStart = proposal.indexOf("- Mandatory defenses:");
      const acceptanceStart = proposal.indexOf("- Acceptance implications:");
      assert.ok(
        mandatoryStart < acceptanceStart,
        "receipt mandatory defenses must precede acceptance implications",
      );
      const mandatory = proposal.slice(mandatoryStart, acceptanceStart);
      const acceptance = proposal.slice(acceptanceStart);
      assert.match(
        mandatory,
        /exactly one terminal receipt for every ineligible／EOF／length truncation／parse／dispatch／cancel／skip path/,
      );
      assert.match(
        mandatory,
        /rejection only from successful generation qualification／publication/,
      );
      assert.match(
        acceptance,
        /only `succeeded \+ parsed \+ required`.*qualifies for generation publication/is,
      );
      assert.match(
        acceptance,
        /各経路がexactly one `failed`／`cancelled`／`skipped` terminal receiptをmatrix通りにpersist/,
      );
    }
    if (contractId === "history-reauthorization") {
      const negativeMatch = proposal.match(/Negative:(.*?)(?=Recovery:)/is);
      assert.ok(negativeMatch, "history reauthorization needs a negative clause");
      const negative = negativeMatch[1];
      for (const historyField of [
        "`Source`",
        "`Revision`",
        "`Decision`",
        "`Freshness`",
        "`Index`",
        "purpose",
        "input-use",
        "send classification",
        "`readingOrder`",
        "`storyTime`",
        "`viewpoint`",
        "`knowledgeHolder`",
        "`audience`",
        "`timeline`",
        "`worldline`",
        "`narrativeLayer`",
        "`scene`",
      ]) {
        assert.match(
          negative,
          new RegExp(escapeRegExp(historyField)),
          `history negative must name ${historyField}`,
        );
      }
      assert.match(proposal, /full transitive dependency set/);
      assert.match(proposal, /full transitive dependency enumeration/);
      assert.match(proposal, /descendant-wide exclusion/);
      assert.match(proposal, /全descendant exclusion/);
    }
  }
  assert.match(
    executionPlan,
    /transport-observed raw textとthinkingはdigest前に分離.*versioned stable chunk-order digest.*chunk-boundary invariant.*order-sensitive/is,
  );
  assert.match(executionPlan, /trim、Unicode normalization、renderer加工はせず/);
  assert.doesNotMatch(
    executionPlan,
    /Native解析後のtextをtrim、Unicode正規化、renderer加工せずhashする/,
  );
  assert.match(
    proposalSection,
    /typed-revision-material[\s\S]*User-selected Option B defines.*independent Entity／Relation assertion family `nir1\.entity-relation@1`/,
  );
  assert.match(
    proposalSection,
    /typed-revision-material[\s\S]*same-project visible Codex entities／relations.*no scene／Chronicle／artifact／import／author-declared material/is,
  );
  assert.match(
    proposalSection,
    /typed-revision-material[\s\S]*do not copy full closure bodies or add an assertion table, Consumer, or authority/,
  );
  assert.match(
    proposalSection,
    /typed-revision-material[\s\S]*narrative_proposal_revisions\.id[\s\S]*narrative_proposal_decisions[\s\S]*narrative_consumer_freshness/is,
  );
  assert.doesNotMatch(
    proposalSection,
    /canonical_application_freshness/,
    "the typed proposal must retain the existing Freshness authority",
  );
  assert.match(executionPlan, /\| D2a \|[^|]*\| ready-after-R0-merge \|/);
  assert.match(executionPlan, /\| A1 \|[^|]*\| ready-after-R0-merge \|/);
  const a2LaneRow = executionPlan
    .split("\n")
    .find((line) => line.startsWith("| A2 |"));
  assert.ok(a2LaneRow, "A2 lane row must be present");
  const a2LaneCells = a2LaneRow
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  assert.equal(a2LaneCells.length, 4, "A2 lane row shape");
  for (const dependency of ["A1", "D2a"]) {
    assert.match(
      a2LaneCells[1],
      new RegExp(escapeRegExp(dependency)),
      `A2 lane table must include ${dependency}`,
    );
  }
  assert.match(
    a2LaneRow,
    /\| A2 \|[^|]*\| complete-limited \|/,
    "current A2 lane status must record PR #591's limited completion",
  );
  assert.match(executionPlan, /### Current lane snapshot \(2026-09-22\)/);
  assert.match(
    executionPlan,
    /\| A3 \| #598 A3 review remediation \| completed-foundation \|[^\n]*masterへmerged[^\n]*runtime／consumer activationは未完了/,
    "current A3 snapshot must record merged foundation without activation",
  );
  assert.match(
    executionPlan,
    /\| B \| #596 Graph foundation[^|]*\| b-close-complete \|[^\n]*proposal\/5のexact confirmation[^\n]*数値容量契約を明示確認[^\n]*必須focused証跡とN\/N\+1を完了[^\n]*Graph query／product activationとFull／merge readinessは未完了/,
    "current B snapshot must record ratified capacity and boundary evidence while preserving inactive product boundaries",
  );
  assert.match(
    executionPlan,
    /\| D1 \| #599 typed Packing review remediation \| completed-foundation \|[^\n]*review remediationはmasterへmerged[^\n]*Packing product dispatch／D1 activationは未完了/,
    "current D1 snapshot must record merged typed Packing foundation without product activation",
  );
  assert.match(
    executionPlan,
    /R0 lane開始判定と評価manifest \(historical\)[\s\S]*\| A2 \|[^|]*\| ready-after-A1＋D2a \|/,
    "R0's earlier A2 ready condition must remain historical",
  );
  const implementationOrder = executionPlan.split("## 実装順序と公開条件\n", 2)[1];
  assert.ok(implementationOrder, "implementation order must be present");
  const a2OrderRow = implementationOrder
    .split("\n")
    .find((line) => line.startsWith("| A2: L7-A |"));
  assert.ok(a2OrderRow, "A2 implementation-order row must be present");
  const a2OrderCells = a2OrderRow
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  assert.equal(a2OrderCells.length, 4, "A2 implementation-order row shape");
  for (const dependency of ["A1", "D2a"]) {
    assert.match(
      a2OrderCells[2],
      new RegExp(escapeRegExp(dependency)),
      `A2 implementation order must include ${dependency}`,
    );
  }
  const mermaidStart = executionPlan.indexOf("```mermaid\nflowchart LR\n");
  assert.notEqual(mermaidStart, -1, "canonical dependency graph must be present");
  const mermaidEnd = executionPlan.indexOf("\n```", mermaidStart);
  assert.notEqual(mermaidEnd, -1, "canonical dependency graph must close");
  const dependencyGraph = executionPlan.slice(mermaidStart, mermaidEnd);
  assert.match(
    dependencyGraph,
    /A1 --> A2/,
    "dependency graph must retain A1 as an A2 dependency",
  );
  for (const dependencyEdge of [/D2a --> A2/]) {
    assert.match(
      dependencyGraph,
      dependencyEdge,
      `A2 dependency graph must include ${dependencyEdge}`,
    );
  }
  assert.doesNotMatch(
    dependencyGraph,
    /TR|typed-revision-material ratification merge/,
    "dependency graph must not add a ratification merge dependency",
  );
  assert.match(
    executionPlan,
    /\| P \|[^|]*\| ready-independent（固定契約測定済み、Graph統合再確認待ち） \|/,
  );
  assert.match(
    executionPlan,
    /PR-P 固定検索性能測定結果[\s\S]*Raw p95=31\.5ms[\s\S]*Hybrid p95=60\.8ms[\s\S]*65\.04ms/is,
    "the fixed PR-P result must remain recorded against the approved limit",
  );
  assert.match(
    executionPlan,
    /PR-P 固定検索性能測定結果[\s\S]*720\/720[\s\S]*failed=0[\s\S]*timeout=0[\s\S]*paired-gates-passed/is,
    "the fixed PR-P availability and paired gate result must remain recorded",
  );
  assert.match(
    executionPlan,
    /PR-P 固定検索性能測定結果[\s\S]*3623\.8ms[\s\S]*2T=4289\.4ms[\s\S]*B=54\.2ms[\s\S]*D=10\.84ms[\s\S]*T=2144\.7ms/is,
    "the fixed PR-P build result and unchanged B/D/T must remain recorded",
  );
  assert.match(
    executionPlan,
    /contended run[\s\S]*診断専用[\s\S]*unattributed host contention/is,
    "host-contended measurements must remain diagnostic-only and unattributed",
  );
  assert.match(
    executionPlan,
    /standaloneのPR-P固定性能gateは解決済み[\s\S]*Graph-integrated recheck pending\/Hold[\s\S]*Graph完了は主張せず/is,
    "the Graph-integrated recheck must remain pending after standalone P passes",
  );
  for (const [lane, blockedBy] of [
    ["A3", "A1／A2"],
    ["B", "A1／A2"],
    ["C", "A3／B／D2a"],
    ["D1", "A2"],
    ["D2b-2", "C／D1／D2a／D2b-1"],
  ]) {
    assert.match(
      executionPlan,
      new RegExp(`\\| ${lane} \\|[^|]*\\| blocked\\(${blockedBy}\\) \\|`),
      `${lane} must remain blocked only on its normal dependencies`,
    );
  }
  assert.match(
    executionPlan,
    /R0で確認済み・merge後開始[\s\S]*五つのproposal\/3 contractId[\s\S]*明示確認済み・契約として有効[\s\S]*第六行[\s\S]*A2はA1＋D2aの通常依存が成立した後/is,
  );
  assert.doesNotMatch(
    executionPlan,
    /実装前に別途確認するdraft|別の明示確認があるまで[^\n]*blocked|typed \/4が別途確認されるまで/,
    "the typed row must not retain stale pending-decision language",
  );
  assert.doesNotMatch(
    executionPlan,
    /実装前に明示確認するdraft.*保存authority.*呼出主体.*Native生成元receipt.*履歴再認可.*profile egress/is,
    "the stale five-scope draft row must stay removed",
  );
  assert.match(
    executionPlan,
    /R0がmergeされ.*D2aとA1を開始できる.*proposal\/4 Option B.*typed-revision-material.*既に批准済み・契約として有効.*A2はA1＋D2a.*A3・B・C・D1.*blocked.*Pだけは独立/is,
  );

  assert.match(
    executionPlan,
    /Graph.*公開条件.*A3\s*\+\s*B\s*\+\s*C\s*\+\s*D2a/is,
  );
  assert.match(
    executionPlan,
    /Packing.*公開条件.*C\s*\+\s*D1\s*\+\s*D2a\s*\+\s*D2b-1\s*\+\s*D2b-2/is,
  );
  for (const phrase of [
    /24.*検索case/,
    /8.*Graph.*case/is,
    /12.*Packing.*task/is,
    /R\s*\/\s*R\+IR\s*\/\s*R\+IR\+Graph/,
    /seed-only/,
    /共通.*(?:seed|context)/is,
    /同一.*token budget/is,
    /事前指定.*改善/,
    /全PR.*merge gate M/is,
    /Graph統合再確認のHold/,
    /author-value:\s*not-measured/,
  ]) {
    assert.match(executionPlan, phrase);
  }
  assert.match(executionPlan, /evals\/nir1-retrieval\/manifest\.json/);
  assert.match(executionPlan, /ja\/en各12件/);
  assert.match(executionPlan, /G-07.*pre-S2.*at\/after-S2/is);
  assert.match(executionPlan, /事前指定改善.*G-01.*P-12/is);
  assert.match(
    executionPlan,
    /Scope設定の永続化.*既存L5移行ガード.*同一PR.*restricted plaintext.*D2a/is,
  );
  assert.match(
    executionPlan,
    /初回static draftの旧R0候補.*focused test／`verify:quality`／Quick＋verifyは無効.*旧receiptを流用しない/is,
  );
  assert.match(
    executionPlan,
    /候補commit前のfocused検証.*commitが依頼範囲に含まれる場合.*候補commit.*cleanな候補HEAD.*PR／releaseの証跡が依頼されCIが許可された場合だけQuickと直後verify.*候補commit後のPR用Quick.*candidate_base.*candidate_head.*ci:local:quick.*ci:local:verify/is,
  );
  assert.match(
    integrationValidationSection,
    /候補commit前のfocused検証.*commitが依頼範囲に含まれる場合.*候補commit.*cleanな候補HEAD.*PR／releaseの証跡が依頼されCIが許可された場合だけQuickと直後verify/is,
  );
  assert.match(
    integrationValidationSection,
    /候補commit後のPR用Quick.*candidate_base.*candidate_head.*ci:local:quick.*ci:local:verify/is,
  );
  assert.doesNotMatch(
    integrationValidationSection,
    /完成commit前[\s\S]*ci:local:quick -- --base origin\/master --head HEAD/,
    "NIR integration instructions must not run Quick against the pre-commit dirty HEAD",
  );
  assert.doesNotMatch(
    executionPlan,
    /現在(?:の)?(?:R0 )?候補[^\n]*(?:Full|verify)[^\n]*(?:実施していない|未実施|実施しない|不要|免除)/is,
    "historical no-run notes must not exempt the current candidate",
  );
  assert.match(
    executionPlan,
    /sceneIncarnationId.*Native-owned.*scene生存世代ID.*legacy-absent \| explicit \| unknown.*別フィールド.*Scope marker.*incarnation IDではない/is,
  );
  assert.match(
    executionPlan,
    /通常編集は同じ `sceneIncarnationId` を継続し、Source tokenを更新して旧Revision／Index／query／result／Evidence eligibilityをinvalidate/is,
  );
  assert.match(
    executionPlan,
    /本文・タイトル・順序等の通常更新.*同じ `sceneIncarnationId`.*Source tokenを更新.*Evidence eligibilityをinvalidate/is,
  );
  assert.match(
    executionPlan,
    /明示設定変更は同じ `sceneIncarnationId` を継続し、Scope markerを`explicit`に設定し、関連するSource tokenを更新して旧eligibilityをinvalidateする一方、新規、duplicate、import、削除後のID再利用だけが新しい `sceneIncarnationId` を発行し、`unknown` は未設定／unresolvedのScope markerに限り、新しいIDの代替にはしない/is,
    "explicit scope changes must preserve identity and unknown must remain a marker",
  );
  assert.match(
    executionPlan,
    /Scopeの明示設定.*同じ `sceneIncarnationId`.*Scope markerを`explicit`へ移行.*関連するSource tokenを更新.*旧資格をinvalidate/is,
  );
  assert.doesNotMatch(
    executionPlan,
    /明示設定変更.*(?:新しい `?sceneIncarnationId|新しいincarnation).*unknown.*とし/,
    "explicit scope changes must not allocate an alternate unknown incarnation",
  );
  assert.doesNotMatch(
    executionPlan,
    /`sceneIncarnationId` は `legacy-absent \| explicit \| unknown` のmarkerだけ/,
    "scene incarnation identity must not be conflated with the legacy marker",
  );
  for (const caseId of [
    "G-01",
    "G-02",
    "G-03",
    "G-04",
    "G-05",
    "G-06",
    "G-07",
    "G-08",
    "P-01",
    "P-02",
    "P-03",
    "P-04",
    "P-05",
    "P-06",
    "P-07",
    "P-08",
    "P-09",
    "P-10",
    "P-11",
    "P-12",
  ]) {
    assert.match(executionPlan, new RegExp(`\\| ${caseId} \\|`));
  }
  for (const command of [
    "pnpm verify:quality",
    "candidate_base=\"$(git rev-parse 'origin/master^{commit}')\"",
    "candidate_head=\"$(git rev-parse 'HEAD^{commit}')\"",
    "pnpm ci:local:quick -- --base \"$candidate_base\" --head \"$candidate_head\"",
    "pnpm ci:local:verify -- quick --base \"$candidate_base\" --head \"$candidate_head\"",
    "full_base=\"$(git rev-parse 'origin/master^{commit}')\"",
    "full_head=\"$(git rev-parse 'HEAD^{commit}')\"",
    "pnpm ci:local:full -- --base \"$full_base\" --head \"$full_head\"",
    "pnpm ci:local:verify -- full --base \"$full_base\" --head \"$full_head\"",
  ]) {
    assert.match(
      executionPlan,
      new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  assert.match(roadmap, /PR-R0/);
  assert.match(roadmap, /81d0390fe7a935191753b41e5673503f99d51d16/);
  assert.match(roadmap, /0decaab5470c2408be81856ac2373b28e078b945/);
  assert.match(roadmap, /PR #591.*A2.*Entity／Relation.*immutable Revision.*cold reopen/is);
  assert.match(roadmap, /Graph.*Packing.*AI.*(?:inactive|未activate)/is);
  assert.match(roadmap, /downstream threat model.*draft/is);
  assert.match(roadmap, /NIR-1 overall acceptance remains incomplete/);
  assert.match(integrationPlan, /PR-R0/);
  assert.match(
    integrationPlan,
    /proposal\/4.*Entity／Relation-only.*typed-revision-material.*(?:explicitly ratified|明示批准済み)/is,
  );
  assert.match(integrationPlan, /PR #591.*A2.*Entity／Relation.*immutable Revision.*cold reopen/is);
  assert.match(integrationPlan, /Graph.*Packing.*AI.*(?:inactive|未activate)/is);
  assert.match(integrationPlan, /downstream threat model.*draft/is);
  assert.match(integrationPlan, /NIR-1 overall acceptance remains incomplete/);
  for (const [name, narrative] of [
    ["roadmap", roadmap],
    ["integration plan", integrationPlan],
  ]) {
    assert.match(
      narrative,
      /(?:R0 confirmation state: five proposal\/3(?: contract)? rows|R0 merged with five proposal\/3(?: contract)? rows)[\s\S]*PR #579[\s\S]*records the sixth[\s\S]*proposal\/4 Option B Entity／Relation-only assertion family `typed-revision-material`[\s\S]*(?:explicitly ratified and effective|明示批准済み・契約として有効)[\s\S]*A2 (?:is|becomes) ready only after A1＋D2a[\s\S]*activate any runtime or consumer/is,
      `${name} must mirror R0's five rows and the effective typed-ratification state`,
    );
    assert.match(
      narrative,
      /exact (?:per-contract )?refs?.*execution-plan ledger/is,
      `${name} must point to the canonical per-contract ledger`,
    );
    assert.doesNotMatch(
      narrative,
      /(?:six downstream contract|6つの下流契約).*blocked\(ref-unverified\)/is,
      `${name} must not retain the stale all-six-blocked summary`,
    );
    assert.doesNotMatch(
      narrative,
      /R0 records six|typed row is ready after R0 merge|(?:現在の|The current )R0 merge candidate|typed-ratification candidate|ratification PR|ratification merge|search-performance Hold|検索性能Hold|性能Hold/i,
      `${name} must not retain stale current-state or generic performance wording`,
    );
    assert.doesNotMatch(
      narrative,
      /canonical_application_freshness/,
      `${name} must not introduce a second Freshness authority`,
    );
    assert.match(
      narrative,
      /Graph-integrated recheck pending\/Hold/,
      `${name} must name the remaining Graph-integrated recheck/Hold`,
    );
    assert.match(
      narrative,
      /(?:今後の実装候補は.*merge gate M.*merge前のclean HEADのFull＋直後verifyを必須|Future implementation candidates remain subject to the shared merge gate M.*clean candidate must pass Full and immediate verify before merge)/is,
      `${name} must keep future implementation candidates subject to merge gate M`,
    );
    assert.doesNotMatch(
      narrative,
      /(?:今後の実装候補は|Future implementation candidates remain)[^\n]*(?:Full|verify)[^\n]*(?:未実施|実施していない|not run)/is,
      `${name} must not exempt future implementation candidates with a historical no-run note`,
    );
  }
});

test("AI authoring delegates once to the conditional canonical quality gate", async () => {
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
  await assertLocalMarkdownLink(
    ".agents/skills/grimodex-author/SKILL.md",
    ".agents/skills/grimodex-impact-gate/SKILL.md",
  );
  assert.match(author, /grimodex-impact-gate.*verify:quality.*Light.*まとめて/is);
  assert.match(author, /成功済み command.*重ねて実行しない/);
  const authorCommands = [...author.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)]
    .map((match) => match[1]).join("\n");
  assert.doesNotMatch(authorCommands, /pnpm (?:verify:quality|eval:impact|ci:local:quick)/);
  assert.match(impact, /commit／PR.*依頼していない調査・レビュー.*gate.*CI.*自動起動しない/);
  assert.match(impact, /pnpm verify:quality/);
  assert.match(impact, /verify:quality.*Light suite.*同一の検証範囲ではない/);
  assert.match(impact, /成功が確認済みなら再実行しない/);

  const diagnostic = normalizeSection(
    sectionFromHeading(impact, "## 作業ツリー・限定範囲の Light 評価"),
  );
  assert.match(diagnostic, /候補証跡を作らない変更.*Quick.*開始せず/);
  assert.match(diagnostic, /pnpm eval:impact -- --run/);
  assert.match(diagnostic, /branch.*staged.*unstaged.*untracked/);
  assert.match(diagnostic, /ファイル集合を指定する場合だけ.*--changed-file.*対象外の既存差分/);
  assert.match(diagnostic, /限定範囲.*診断証拠.*candidate 全体.*Quick／Full receipt.*しない/);
  assert.match(diagnostic, /suite.*減らさず.*全 suite fallback.*変更しない/);

  const candidateRaw = sectionFromHeading(impact, "## PR／release の候補証跡");
  const candidate = normalizeSection(candidateRaw);
  assert.match(candidate, /PR／release の証跡が依頼範囲に含まれ.*CI が許可されている場合だけ.*focused 検証.*clean な候補 commit/);
  assert.match(candidate, /commit-only.*CI 明示除外.*開始しない/);
  assert.match(candidate, /base／head.*一度だけ解決.*Quick.*直後.*verify.*同じ値/);
  assert.match(candidate, /wrapper.*Light suite.*eval:impact -- --run.*別途重ねない/);
  const quick = commandBindings(candidateRaw, "pnpm ci:local:quick", "Quick");
  const verify = commandBindings(candidateRaw, "pnpm ci:local:verify -- quick", "Quick verify");
  assert.deepEqual(quick, [{ base: '"$candidate_base"', head: '"$candidate_head"' }]);
  assert.deepEqual(verify, quick);
  assert.deepEqual(commandBindings(impact, "pnpm ci:local:quick", "all Quick"), quick);
  assert.deepEqual(commandBindings(impact, "pnpm ci:local:verify -- quick", "all Quick verify"), verify);
  assert.ok(candidateRaw.indexOf("pnpm ci:local:quick") < candidateRaw.indexOf("pnpm ci:local:verify -- quick"));
  assert.match(impact, /deferred/i);
  assert.match(impact, /blocked/i);
  assert.match(impact, /どちらも passed に読み替えない/);
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
  assert.match(releaseDebug, /version.*(?:変更しない|増やさず|上げない)/is);

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
