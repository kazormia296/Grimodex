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

test("NIR-1 R0 records bounded contract confirmations and keeps runtime gated", async () => {
  const executionPlan = await read("docs/plans/nir1-l6-l9-execution-plan.md");
  const roadmap = await read("docs/plans/narrative-semantic-core-roadmap.md");
  const integrationPlan = await read(
    "docs/plans/narrative-ir-nir1-implementation-plan.md",
  );

  assert.match(executionPlan, /PR-R0.*現在地と評価契約の固定/is);
  assert.match(
    executionPlan,
    /master@68516b033f395f24f98c502c9fd2a715d7aec2af/,
  );
  assert.match(
    executionPlan,
    /Tree:\s*04c491c29627ecc840112ebe379a5363e16892ff/,
  );
  assert.match(executionPlan, /#572でtyped基盤runtime.*実装済み/is);
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
    "the selected typed family must be concrete; only its ratification remains",
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
  const confirmedContractIds = [
    "scope-storage-authority",
    "caller-profile-egress",
    "typed-revision-material",
    "graph-limited-binding",
    "native-generation-receipt",
    "history-reauthorization",
  ];
  const confirmedRefFor = (contractId) =>
    `${contractId === "typed-revision-material" ? typedDraftRef : proposal3Ref}#${contractId}`;
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
      if (contractId === "typed-revision-material") {
        assert.equal(draftRef, typedDraftRef);
        assert.match(
          cells[3],
          /proposal\/4 scope only.*Option B.*Entity／Relation-only.*nir1\.entity-relation@1/,
        );
        assert.match(cells[4], /proposal\/4 explicitly confirmed/);
        assert.equal(cells[6], "ready-after-R0-merge");
        assert.match(cells[7], /explicit user confirmation recorded.*A1／D2a/);
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
      assert.match(cells[7], /explicit user confirmation recorded/);
      assert.match(cells[8], new RegExp(escapeRegExp(confirmedRefFor(contractId))));
    } else {
      assert.fail(`${contractId} should be explicitly confirmed`);
    }
    return row;
  });
  assert.equal(ledgerRows.length, 6);
  assert.equal(
    ledgerRows.filter((row) => row.includes("ready-after-R0-merge")).length,
    6,
    "all five proposal/3 rows and the typed proposal/4 row are confirmed and ready after merge",
  );
  assert.match(
    executionPlan,
    /proposal\/3の五つのconfirmed row.*Option Bのtyped row.*それぞれのscopeだけを記録する/,
  );
  assert.doesNotMatch(executionPlan, /nir1-l6-l9-contract-proposal\/1/);
  assert.doesNotMatch(executionPlan, /nir1-l6-l9-contract-proposal\/2/);

  const proposalSection = executionPlan
    .split("### R0 security contract proposal (draft)\n", 2)[1]
    ?.split("\n### lane開始判定と評価manifest", 1)[0];
  assert.ok(proposalSection, "R0 security contract proposal must be present");
  assert.match(
    proposalSection,
    /proposal\/3の五つのconfirmed row[^\n]*Option Bのtyped row/,
  );
  for (const confirmationRule of [
    /Confirmation protocol.*only an explicit user statement naming the exact `draftRef` and one `contractId` confirms that one row/is,
    /stable ledger form is `draftRef#contractId`/,
    /five.*refs.*record separate confirmations.*exactly `scope-storage-authority`.*`caller-profile-egress`.*`graph-limited-binding`.*`native-generation-receipt`.*`history-reauthorization`/is,
    /Plan agreement.*not a ratification/is,
    /active goal.*not a ratification/is,
    /merge instruction.*not a ratification/is,
    /this proposal is fine.*not a ratification/is,
    /Confirming one row does not confirm its dependencies/i,
    /user-selected Option B family is concrete.*independently ratified.*typed-revision-material.*nir1-l6-l9-contract-proposal\/4/is,
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
    for (const acceptanceField of [
      "Acceptance implications",
      "Positive",
      "Negative",
      "Recovery",
      "Lane unlocked if confirmed",
    ]) {
      assert.match(
        proposal,
        new RegExp(`${escapeRegExp(acceptanceField)}:`, "i"),
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
  assert.match(
    executionPlan,
    /\| A2 \|[^|]*\| ready-after-A1＋D2a＋typed-revision-material-merge \|/,
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
    /standaloneのP固定性能gateは完了[\s\S]*Graph統合再確認だけ/is,
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
    /R0で確認済み・merge後開始.*五つのproposal\/3 contractId.*proposal\/4 Option B.*Entity／Relation-only.*ready/,
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
    /R0がmergeされ.*D2aとA1を開始できる.*typed \/4は明示確認済み.*A2はA1＋D2a.*ready.*A3・B・C・D1.*blocked.*Pだけは独立/is,
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
    /初回static draft.*focused contract testのみ.*Quick／verify／Full／verifyは実施しなかった.*現在候補の証跡または免除ではない.*現在のR0 merge candidate.*merge gate M.*Full＋直後のverify.*要求する/is,
  );
  assert.match(
    executionPlan,
    /初回static draft.*旧R0候補で実施済みだった.*verify:quality.*Quick.*無効化し.*再開候補で再実施する記録だった.*現在のR0 merge candidate.*merge gate M.*Full＋直後verify.*必須/is,
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
    "pnpm ci:local:quick -- --base origin/master --head HEAD",
    "pnpm ci:local:verify -- quick --base origin/master --head HEAD",
    "pnpm ci:local:full -- --base origin/master --head HEAD",
    "pnpm ci:local:verify -- full --base origin/master --head HEAD",
  ]) {
    assert.match(
      executionPlan,
      new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  assert.match(roadmap, /PR-R0/);
  assert.match(roadmap, /68516b033f395f24f98c502c9fd2a715d7aec2af/);
  assert.match(roadmap, /downstream.*blocked|blocked.*downstream/is);
  assert.match(integrationPlan, /PR-R0/);
  assert.match(
    integrationPlan,
    /typed-revision-material.*independently ratified.*proposal\/4.*Entity／Relation-only/is,
  );
  for (const [name, narrative] of [
    ["roadmap", roadmap],
    ["integration plan", integrationPlan],
  ]) {
    assert.match(
      narrative,
      /six contract rows (?:are|as) explicitly confirmed \(proposal scope only\): five proposal\/3 rows plus the independently ratified proposal\/4 Option B Entity／Relation-only assertion family `typed-revision-material`[\s\S]*typed row is ready after R0 merge.*A2 is ready only after A1＋D2a＋this row are merged[\s\S]*activate any runtime or consumer/is,
      `${name} must mirror the current R0 confirmation state`,
    );
    assert.match(
      narrative,
      /exact per-contract refs.*execution-plan ledger/is,
      `${name} must point to the canonical per-contract ledger`,
    );
    assert.doesNotMatch(
      narrative,
      /(?:six downstream contract|6つの下流契約).*blocked\(ref-unverified\)/is,
      `${name} must not retain the stale all-six-blocked summary`,
    );
    assert.doesNotMatch(
      narrative,
      /contract-delta-unresolved|ref-unverified|unconfirmed\/ref-unverified/,
      `${name} must not retain stale unconfirmed markers`,
    );
    assert.doesNotMatch(
      narrative,
      /canonical_application_freshness/,
      `${name} must not introduce a second Freshness authority`,
    );
    assert.match(
      narrative,
      /(?:現在のR0 merge candidateは.*merge gate M.*merge前のclean HEADのFull＋直後verifyを必須|The current R0 merge candidate.*merge gate M.*clean candidate must pass Full and immediate verify before merge)/is,
      `${name} must keep the current candidate subject to merge gate M`,
    );
    assert.doesNotMatch(
      narrative,
      /(?:現在のR0 merge candidate|The current R0 merge candidate)[^\n]*(?:Full|verify)[^\n]*(?:未実施|実施していない|not run)/is,
      `${name} must not exempt the current candidate with a historical no-run note`,
    );
  }
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
