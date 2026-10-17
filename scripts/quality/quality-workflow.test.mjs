import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  assert.ok(headingMatch, heading + " must exist as a level-two heading");

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
      path.resolve(repoRoot, path.dirname(sourcePath), destination) ===
        expectedPath &&
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
    section.match(new RegExp(`${escapeRegExp(command)}[^\\n]*`, "g")) ?? [];
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

// K1 (2026-10-12): proposal/6 was confirmed for `graph-limited-binding` and
// for the new `nir1-defensive-resource-limits` row. The draft stays
// byte-identical; its SHA-256 and the exact statements bind the ledger.
const PROPOSAL6_DRAFT_PATH =
  "docs/plans/nir1-l6-l9-contract-proposal-6-draft.md";
const PROPOSAL6_DRAFT_SHA256 =
  "5528f4e091ca087c0f1e071039c6bcede9d3d7cde1422ac1bfd852ee1d8d6b4b";
const PROPOSAL6_DRAFT_COMMIT = "ba7ceb46306ec48383a70e52951288ed8c7e960b";
const PROPOSAL6_GRAPH_STATEMENT =
  "I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId graph-limited-binding.";
const PROPOSAL6_RULE_STATEMENT =
  "I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId nir1-defensive-resource-limits.";
const PROPOSAL6_GRAPH_HEADING =
  "#### graph-limited-binding (proposal/6 confirmed contract)";
const PROPOSAL6_RULE_HEADING = "#### nir1-defensive-resource-limits";

function r0ProposalSection(executionPlan) {
  const proposalSection = executionPlan
    .split("### R0 security contract proposal (draft)\n", 2)[1]
    ?.split("\n### R0 lane開始判定と評価manifest", 1)[0];
  assert.ok(proposalSection, "R0 security contract proposal must be present");
  return proposalSection;
}

// A `#### ` section runs to the next `#### ` heading; `##### ` subsections
// stay inside it.
function headedSection(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `${heading} must be present`);
  const end = markdown.indexOf("\n#### ", start + 1);
  return markdown.slice(start, end === -1 ? markdown.length : end);
}

// A top-level `- Label:` bullet keeps its indented sub-bullets and ends at the
// next top-level bullet or blank line.
function bulletBody(section, label, description) {
  const marker = `\n- ${label}:`;
  const start = section.indexOf(marker);
  assert.ok(start >= 0, `${description} must define ${label}`);
  const bodyStart = start + marker.length;
  const ends = [
    section.indexOf("\n- ", bodyStart),
    section.indexOf("\n\n", bodyStart),
  ].filter((offset) => offset !== -1);
  return section.slice(
    bodyStart,
    ends.length === 0 ? section.length : Math.min(...ends),
  );
}

function tableRow(section, label, description) {
  const row = section
    .split("\n")
    .find(
      (line) => line.startsWith("|") && line.split("|")[1]?.trim() === label,
    );
  assert.ok(row, `${description} must define ${label}`);
  return row;
}

function mutateExecutionPlanSection(executionPlan, heading, mutator) {
  const start = executionPlan.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `mutation target ${heading} must be present`);
  const end = executionPlan.indexOf("\n#### ", start + 1);
  assert.ok(end > start, `mutation target ${heading} must be bounded`);
  const section = executionPlan.slice(start, end);
  const mutated = mutator(section);
  assert.notEqual(
    mutated,
    section,
    `${heading} mutation must change the bounded section`,
  );
  return `${executionPlan.slice(0, start)}${mutated}${executionPlan.slice(end)}`;
}

function validateProposal6Contract(executionPlan) {
  const proposalSection = r0ProposalSection(executionPlan);
  const graph = headedSection(proposalSection, PROPOSAL6_GRAPH_HEADING);
  const rule = headedSection(proposalSection, PROPOSAL6_RULE_HEADING);
  assert.ok(
    proposalSection.indexOf(`${PROPOSAL6_GRAPH_HEADING}\n`) <
      proposalSection.indexOf(`${PROPOSAL6_RULE_HEADING}\n`),
    "the proposal/6 rule section must follow the proposal/6 Graph section",
  );
  for (const [label, section, statement] of [
    ["proposal/6 Graph", graph, PROPOSAL6_GRAPH_STATEMENT],
    ["nir1-defensive-resource-limits", rule, PROPOSAL6_RULE_STATEMENT],
  ]) {
    assert.match(
      section,
      new RegExp(
        `^確認: 2026-10-12（JST 23:58受信、Session A）に、exact statement \`${escapeRegExp(statement)}\` で確認された。`,
        "m",
      ),
      `${label} must record its exact confirmation`,
    );
    assert.match(
      section,
      new RegExp(
        `^Required confirmation evidence is the exact statement: \`${escapeRegExp(statement)}\` 2026-10-12（JST 23:58受信、Session A）に記録した。draftのSHA-256は \`${PROPOSAL6_DRAFT_SHA256}\``,
        "m",
      ),
      `${label} must keep its required confirmation evidence and draft digest`,
    );
    assert.match(
      section,
      /\[proposal\/6 draft\]\(nir1-l6-l9-contract-proposal-6-draft\.md\)/,
      `${label} must link the byte-identical draft`,
    );
    assert.match(
      section,
      /本節とdraftが食い違うときはdraftに従う/,
      `${label} must defer to the confirmed draft`,
    );
  }
  assert.ok(
    graph.includes(PROPOSAL6_DRAFT_COMMIT),
    "the proposal/6 Graph section must name the confirmed draft commit",
  );

  const graphBullet = (label) => bulletBody(graph, label, "proposal/6 Graph");
  const baseline = graphBullet("Baseline (approved; limited)");
  assert.match(
    baseline,
    /`nir1-l6-l9-contract-proposal\/5#graph-limited-binding` の確認時点の本文/,
  );
  assert.match(
    baseline,
    /6 MiB・100 ms・aggregate capなしの文面は確認されていなかったので、baselineに含めない/,
    "#610's unconfirmed rewrite must not become the proposal/6 baseline",
  );
  assert.match(baseline, /Graphの製品activationは承認されていない/);
  const delta = graphBullet(
    "Delta (L6-L9 resource limits; proposal/6 confirmed)",
  );
  assert.match(delta, /資源の値と、それに伴う受入れだけを改訂する/);
  assert.match(
    delta,
    /新しいauthority、schema、consumer、persistent adjacencyは追加しない/,
  );
  assert.match(
    delta,
    /C-queryのper-Revision preflight（`2,097,152 B`）とPackingの入力上限（`2 MiB`）は変えない/,
  );
  for (const label of ["Trusted actors", "Untrusted actors"]) {
    graphBullet(label);
  }
  assert.match(
    graphBullet("Out-of-scope attacks"),
    /query全体の物理メモリ上限とその証明は求めない/,
  );
  const fixedBounds = [
    "`512 records`／`6,291,456 B`",
    "`2,097,152 B`",
    "admission `512`",
    "batch `16x32`",
    "SQL `100,000 VM steps`",
    "cancellation every `1,000` steps",
    "`100 ms`",
    "reader／busy wait `0`",
    "oversized row",
    "allocation前",
    "JSON／material processing中",
  ];
  for (const label of [
    "In-scope attacks",
    "Mandatory defenses",
    "Acceptance implications",
  ]) {
    const body = graphBullet(label);
    for (const bound of fixedBounds) {
      assert.ok(
        body.includes(bound),
        `proposal/6 Graph ${label} must preserve ${bound}`,
      );
    }
    assert.doesNotMatch(
      body,
      /`8ms`/,
      `proposal/6 Graph ${label} must not restore the retired \`8ms\` query bound`,
    );
  }
  const mandatory = graphBullet("Mandatory defenses");
  assert.match(
    mandatory,
    /固定値の変更（方向を問わない）と実装上の防御上限の緩和は、再確認なしに行わない。proposal\/5の「Threshold changes require reconfirmation」を保持する/,
    "proposal/6 threshold changes must require reconfirmation",
  );
  assert.match(
    mandatory,
    /超えたら全体を拒否し、部分Graph・partial generation・部分的なpackを出さない/,
  );
  assert.match(
    mandatory,
    /query全体の物理メモリ上限とその証明、Native fixed-area packing、B容量の再認定は求めない/,
  );
  const acceptance = graphBullet("Acceptance implications");
  assert.match(
    acceptance,
    /Positive:.*Negative:.*Recovery:.*Lane unlocked if confirmed:/s,
  );
  for (const [pattern, label] of [
    [
      /Revisionの513 recordsと `6,291,457 B` はwriterが保存しない/,
      "Revision N+1 refusal",
    ],
    [
      /per-Revision preflightが `2,097,153 B` 以上のRevision[^。]*そのquery全体を拒否し、Graphの寄与0でR\+IRに戻る/,
      "per-Revision preflight N+1 refusal",
    ],
    [
      /Packingの入力の合計が `2 MiB` を超えたら、保存サイズにかかわらず準備全体がtyped refusalになる/,
      "Packing total-input refusal",
    ],
    [/`100 ms` を過ぎた結果/, "late result refusal"],
    [
      /固定値の変更や防御上限の緩和を、再確認なしにmergeしない/,
      "no unconfirmed threshold change",
    ],
    [
      /Graphの製品公開には、A3 \+ B \+ C \+ D2aと公開時の承認がさらに要る/,
      "product activation stays gated",
    ],
  ]) {
    assert.match(acceptance, pattern, `proposal/6 acceptance: ${label}`);
  }
  const acceptanceImpact = graphBullet(
    "受入れへの影響（下の「非目標と再確認条件」）",
  );
  assert.match(
    acceptanceImpact,
    /品質閾値: queryの期限は `8ms` から `100 ms` に変わる/,
  );
  assert.match(
    acceptanceImpact,
    /変えないもの: Gold、P、既存の24件、G-01〜G-08の判定/,
  );

  const unitsStart = graph.indexOf(
    "##### Proposal/6 resource units (confirmed fixed values)\n",
  );
  const limitsStart = graph.indexOf(
    "##### Proposal/6 implementation defensive limits\n",
  );
  const removalsStart = graph.indexOf("##### Proposal/6 removals\n");
  assert.ok(
    unitsStart >= 0 && limitsStart > unitsStart && removalsStart > limitsStart,
    "proposal/6 resource units, defensive limits and removals must be ordered",
  );
  const units = graph.slice(unitsStart, limitsStart);
  const limits = graph.slice(limitsStart, removalsStart);
  const removals = graph.slice(removalsStart);
  assert.match(
    units,
    /^固定値の変更は、方向を問わず再確認を要する。/m,
    "proposal/6 fixed values must require reconfirmation in either direction",
  );
  const unitRow = (label) =>
    tableRow(units, label, "proposal/6 resource units");
  const revisionRow = unitRow("Entity／Relation Revision bundle");
  assert.match(
    revisionRow,
    /\| proposal\/5と同じ数え方で `512 records`、`6,291,456 B` \|/,
    "proposal/6 Revision bundle must stay at 512 records / 6,291,456 B",
  );
  assert.match(
    revisionRow,
    /writerは保存しない。readerは使わない。.*partial generationなし、旧sealedを維持/,
  );
  const preflightRow = unitRow("C-query per-Revision preflight");
  assert.match(
    preflightRow,
    /bytesの合計が `2,097,152 B` 以下。JSONの解析より前に検査する/,
    "proposal/6 per-Revision preflight must stay at 2,097,152 B",
  );
  assert.match(
    preflightRow,
    /そのquery全体を拒否する。部分Graphを出さず、Graphの寄与は0/,
  );
  const queryRow = unitRow("seed-local Graph query");
  for (const bound of [
    "read／admission `512`（513件目は拒否",
    "batch `16x32`",
    "SQL `100,000 VM steps`",
    "`1,000` stepsごと",
    "parent admission→valid Native result lease `100 ms`",
    "reader／busy wait `0`",
    "2hop／Entity 12／edge展開 144／Scene 8",
    "query全体の物理メモリ上限とその証明は求めない",
  ]) {
    assert.ok(
      queryRow.includes(bound),
      `proposal/6 seed-local query row must keep ${bound}`,
    );
  }
  assert.doesNotMatch(queryRow, /8ms|`2 MiB`/);
  const buildRow = unitRow("whole-project B Index build");
  for (const value of [
    "qualified material `8,192`",
    "current Revision `1,024`",
    "scan候補 `2,064`",
    "Source入力 `16 MiB`",
    "roster `4 MiB`",
    "`8,193` 行・`16 MiB`",
    "SQL `600,000,000` progress counts",
    "期限 `180 s`",
  ]) {
    assert.ok(
      buildRow.includes(value),
      `proposal/6 whole-project build must keep the B-close value ${value}`,
    );
  }
  assert.match(buildRow, /容量は再認定しない/);
  assert.match(
    buildRow,
    /typed capacity refusal。partial generationを公開せず、旧sealed generationを残す/,
  );
  const packingRow = unitRow("Packing（参考。この行では変えない）");
  assert.match(packingRow, /`MAX_PACKING_INPUT_BYTES`（`2 MiB`）/);
  assert.match(packingRow, /保存されたRevisionのbytesでは検査しない/);
  const limitRow = (label) =>
    tableRow(limits, label, "proposal/6 implementation defensive limits");
  for (const [label, value] of [
    ["C-queryのrequest", "| `8,192 B` |"],
    ["workerから受け取るframe（NQG1）", "（`FRAME_BYTES`）"],
    ["query全体の入力と保持見積り（論理会計）", "| それぞれ `6,291,456 B` |"],
    [
      "workerの固定allocator",
      "| query `4,718,592 B`、registration scratch `64 MiB` |",
    ],
    ["Native領域", "| `1,572,864 B` |"],
    ["同時に動くquery", "| process全体で1。使用中なら待たずにunavailable |"],
    ["startupとcleanup", "| startup `30 s`、cleanup `500 ms`。"],
  ]) {
    assert.ok(
      limitRow(label).includes(value),
      `proposal/6 implementation defensive limit must keep ${label} at ${value}`,
    );
  }
  assert.match(
    limits,
    /これらは現行値のまま維持する。緩める変更（容量を増やす、期限を延ばす、同時に動く数を増やす、上限を外す）は再確認を要する。/,
    "relaxing an implementation defensive limit must require reconfirmation",
  );
  assert.match(
    limits,
    /どの容量もquery全体の物理メモリ上限の保証とは読まず、その証明も求めない/,
  );
  for (const removal of [
    /^- query全体のメモリ上限とその証明/m,
    /^- Native fixed-area packing/m,
    /^- B容量の再認定/m,
    /^- `graph-query-memory-accounting\/1`[^\n]*退役させる/m,
    /^- `8ms` は契約値から外す（U2）/m,
  ]) {
    assert.match(removals, removal, "proposal/6 removals must stay recorded");
  }

  const ruleBullet = (label) =>
    bulletBody(rule, label, "nir1-defensive-resource-limits");
  const ruleDelta = ruleBullet(
    "Delta (L6-L9 resource rule; proposal/6 confirmed)",
  );
  assert.match(
    ruleDelta,
    /上限ごとの確認を、この規則への適合と記録に置き換える/,
  );
  assert.match(
    ruleDelta,
    /何を読む・保存する・送るか（authority、保存範囲、送信先、同意、開示）は決めない。それらは各契約で確認する/,
    "nir1-defensive-resource-limits must not decide authority, storage scope or recipients",
  );
  for (const label of [
    "Baseline (approved; limited)",
    "Trusted actors",
    "Untrusted actors",
    "In-scope attacks",
    "Out-of-scope attacks",
    "Mandatory defenses",
  ]) {
    ruleBullet(label);
  }
  const ruleAcceptance = ruleBullet("Acceptance implications");
  assert.match(
    ruleAcceptance,
    /Positive:.*Negative:.*Recovery:.*Lane unlocked if confirmed: C-body、C-product、H-store／H-current、D-transport/s,
  );
  assert.match(
    ruleAcceptance,
    /値や実測の記録がない上限と、再確認のない緩和はmergeしない/,
  );
  const targetsStart = rule.indexOf("##### 対象と超えたときの扱い\n");
  const rulesStart = rule.indexOf("##### 規則\n");
  const exclusionsStart = rule.indexOf("##### 対象外\n");
  assert.ok(
    targetsStart >= 0 &&
      rulesStart > targetsStart &&
      exclusionsStart > rulesStart,
    "nir1-defensive-resource-limits targets, rules and exclusions must be ordered",
  );
  const targets = rule.slice(targetsStart, rulesStart);
  const rules = rule.slice(rulesStart, exclusionsStart);
  const exclusions = rule.slice(exclusionsStart);
  for (const lane of [
    "C-body",
    "C-product",
    "H-store／H-current",
    "D-transport",
  ]) {
    assert.match(
      targets,
      new RegExp(`^\\| [^|\\n]+ \\| ${escapeRegExp(lane)} \\|`, "m"),
      `nir1-defensive-resource-limits must name the ${lane} target`,
    );
  }
  for (const [index, rulePattern] of [
    [1, /^1\. 有限: [^\n]*無期限の待ちや無制限の再試行を作らない/m],
    [2, /^2\. 取消できる: [^\n]*待っている間も取消を観測する/m],
    [3, /^3\. allocationの前に検査する: [^\n]*checked arithmetic/m],
    [
      4,
      /^4\. fail-safe: [^\n]*打ち切った途中までの結果を完全な結果として使わず、その場で自動に再送・再試行しない/m,
    ],
    [
      5,
      /^5\. 数値の決め方: integratorが実測から選ぶ。[^\n]*PR本文と作業記録に残す/m,
    ],
    [
      6,
      /^6\. 厳しくする: 確認なしで行える。ただし、そのlaneの正例の受入れ[^\n]*を保つ範囲に限る/m,
    ],
    [7, /^7\. 緩める: mergeの後に[^\n]*ユーザーの再確認を得る/m],
    [8, /^8\. 物理的な証明は求めない: [^\n]*論理的な会計/m],
  ]) {
    assert.match(
      rules,
      rulePattern,
      `nir1-defensive-resource-limits rule ${index} must stay recorded`,
    );
  }
  for (const fixedValue of [
    "P（B=54.2 ms、D=10.84 ms、上限65.04 ms、T=2144.7 ms）",
    "Gold",
    "`graph-limited-binding` の固定値",
    "Packingの `2 MiB`",
    "B-closeの数値",
  ]) {
    assert.ok(
      exclusions.includes(fixedValue),
      `nir1-defensive-resource-limits must exclude ${fixedValue}`,
    );
  }
  assert.match(exclusions, /これらを変えるには、従来どおり個別の確認を要する/);
  assert.match(exclusions, /確定値を広げる根拠にならない/);
  return true;
}

function extractGraphProposalSections(executionPlan) {
  const proposalSection = r0ProposalSection(executionPlan);
  // The plain heading holds the proposal/5 text restored to its confirmed
  // wording (`13e3f6c6^`) as history; proposal/6 follows as its own section.
  const graphStart = proposalSection.indexOf("#### graph-limited-binding\n");
  const graphEnd = proposalSection.indexOf("\n#### ", graphStart + 1);
  assert.ok(graphStart >= 0, "bounded Graph proposal must be present");
  assert.ok(graphEnd > graphStart, "bounded Graph proposal must have an end");
  assert.equal(
    proposalSection.slice(graphEnd + 1).split("\n", 1)[0],
    PROPOSAL6_GRAPH_HEADING,
    "the proposal/6 Graph section must directly follow the proposal/5 history",
  );
  const proposal = proposalSection.slice(graphStart, graphEnd);
  const lifecycleStart = proposal.indexOf(
    "##### B build owner/lifecycle (proposal/5 confirmed contract)",
  );
  const acceptanceStart = proposal.indexOf(
    "##### Proposal/5 acceptance split (confirmed contract)",
  );
  assert.ok(lifecycleStart >= 0, "Graph lifecycle matrix must be present");
  assert.ok(
    acceptanceStart > lifecycleStart,
    "Graph acceptance split must follow lifecycle",
  );
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
  assert.ok(
    resourceEnd > resourceStart,
    "Graph resource-unit table must have a bounded end",
  );
  const resourceSection = l7Graph.slice(resourceStart, resourceEnd);
  const resourceRows = resourceSection.split("\n");

  const l9Start = executionPlan.indexOf("## L9: 受入れと完了判定\n");
  const completionStart = executionPlan.indexOf("\n### 完了区分", l9Start);
  assert.ok(l9Start >= 0, "L9 acceptance section must be present");
  assert.ok(
    completionStart > l9Start,
    "L9 acceptance section must have a bounded end",
  );
  const l9Acceptance = executionPlan.slice(l9Start, completionStart);
  const l9GraphAcceptanceStart = l9Acceptance.indexOf(
    "whole-project B buildは",
  );
  assert.ok(
    l9GraphAcceptanceStart >= 0,
    "Graph acceptance narrative must cover the whole-project build",
  );

  return {
    proposal,
    lifecycle,
    outsideValidation,
    acceptanceRows,
    resourceSection,
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
    resourceSection,
    resourceRows,
    graphAcceptanceNarrative,
  } = extractGraphProposalSections(executionPlan);
  // K1 (2026-10-12): the proposal/5 section and the L7 resource-unit table are
  // the confirmed `13e3f6c6^` wording kept as history; proposal/6 replaces
  // their resource values. #610's unconfirmed rewrite must not come back.
  assert.match(
    proposal,
    /^履歴（2026-10-12、K1）: この節（下の「Required confirmation evidence」の文まで）は、`nir1-l6-l9-contract-proposal\/5#graph-limited-binding` の確認時点（`13e3f6c6\^`）の文面に戻した履歴である。[^\n]*「graph-limited-binding \(proposal\/6 confirmed contract\)」の節が置き換える。[^\n]*現行のconfirmedRefは `nir1-l6-l9-contract-proposal\/6#graph-limited-binding`。$/m,
    "the proposal/5 section must be marked as restored history",
  );
  assert.match(
    resourceSection,
    /^履歴（2026-10-12、K1）: 上表はproposal\/5の確認時点（`13e3f6c6\^`）の文面に戻した履歴で、Revision bundleの `2 MiB` とseed-local queryの `2 MiB`／Graph `8ms` は現行の値ではない。[^\n]*「graph-limited-binding \(proposal\/6 confirmed contract\)」節のresource unit表[^\n]*を正本とする。/m,
    "the L7 resource-unit table must be marked as restored history",
  );
  const resourceRow = (label) => {
    const row = resourceRows.find(
      (line) => line.startsWith("|") && line.split("|")[1]?.trim() === label,
    );
    assert.ok(row, `Graph resource-unit row must define ${label}`);
    return row;
  };
  const revisionResourceRow = resourceRow("Entity／Relation Revision bundle");
  assert.match(revisionResourceRow, /512 records.*2 MiB.*validation contract/);
  assert.doesNotMatch(
    revisionResourceRow,
    /whole-project|query totals|deadline/i,
  );
  assert.doesNotMatch(
    revisionResourceRow,
    /6 MiB|6,291,456/,
    "the historical Revision row keeps the confirmed proposal/5 wording",
  );
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
  assert.doesNotMatch(
    queryResourceRow,
    /100\s?ms|6 MiB|4\.5 MiB|1\.5 MiB|aggregate physical-memory/,
    "the historical query row keeps the confirmed proposal/5 wording",
  );
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
  assert.match(
    buildResourceRow,
    /supported capacityの数値は第1診断stage後まで未批准/,
  );
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
  assert.match(
    proposal,
    /新しいauthority、schema、consumer、persistent adjacencyは追加しない/,
  );
  assert.match(lifecycle, /persistent stagingは作らない/);
  assert.match(
    lifecycle,
    /新しいframework、authority、schema、consumer、persistent adjacencyを作らない/,
  );

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
    proposal,
    /supported work size／build memory／SQL／deadlineはその結果から後で選ぶ/,
    "whole-project capacity values remain unratified",
  );
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

  const phaseTableStart = lifecycle.indexOf(
    "| phase | statement / read transaction |",
  );
  const phaseTableEnd = lifecycle.indexOf("\nこの表は有限", phaseTableStart);
  assert.ok(
    phaseTableStart >= 0,
    "Graph phase lifecycle table must be present",
  );
  assert.ok(
    phaseTableEnd > phaseTableStart,
    "Graph phase lifecycle table must have a bounded end",
  );
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
    [
      "source/coverage",
      /Source re-resolution.*complete registration\/coverage verification/,
    ],
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
  assert.match(
    materialRow,
    /entities\.len \+ relations\.len \+ material_basis\.evidence_set\.len/,
  );
  assert.match(
    materialRow,
    /各 Entity／Relation／Evidence entryを各1件として数える/,
  );
  assert.match(materialRow, /Entity-only bundleもvalid/);
  assert.doesNotMatch(
    materialRow,
    /Entity \+ Relation \+ Evidence|record\s*=\s*|組|tuple/i,
  );
  assert.match(
    materialRow,
    /exact complete roster.*Entity／Relation／Evidenceの全record.*no missing／no duplicates/,
  );
  const decoyRow = acceptanceRow(
    ">512 unrelated/ineligible candidate Revisions",
  );
  assert.match(
    decoyRow,
    /Source／Decision／Freshness／Scope不一致.*qualificationから除外/,
  );
  assert.match(decoyRow, /exact roster.*不変/);
  const rosterRow = acceptanceRow("exact roster invariance");
  assert.match(
    rosterRow,
    /Entity／Relation／Evidenceの各recordを全件・同一順序.*missing／duplicateなし/,
  );
  assert.match(
    graphAcceptanceNarrative,
    /qualified material record count = `entities\.len \+ relations\.len \+ material_basis\.evidence_set\.len`.*各 Entity／Relation／Evidence entryを各1件.*Entity-only bundleもvalid.*exact complete roster.*no missing／no duplicates/,
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
  assert.equal(yaml.load(workflow).jobs.quality["timeout-minutes"], 30);
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
    [
      "AGENTS.md",
      [
        "agent-validation",
        "GDX-PRECHECK-001",
        "GDX-TRACE-001",
        "immutable-identity",
      ],
    ],
    [
      ".agents/skills/debug-issue/SKILL.md",
      ["agent-validation", "GDX-PRECHECK-001", "GDX-TRACE-001"],
    ],
    [
      ".agents/skills/implement-feature/SKILL.md",
      [
        "agent-validation",
        "GDX-PRECHECK-001",
        "GDX-TRACE-001",
        "immutable-identity",
      ],
    ],
    [
      ".agents/skills/review-code/SKILL.md",
      [
        "agent-validation",
        "GDX-PRECHECK-001",
        "GDX-TRACE-001",
        "immutable-identity",
      ],
    ],
    [
      ".agents/skills/refactor-cross-boundaries/SKILL.md",
      [
        "agent-validation",
        "GDX-PRECHECK-001",
        "GDX-TRACE-001",
        "immutable-identity",
      ],
    ],
    [
      ".agents/skills/test-feature/SKILL.md",
      ["agent-validation", "immutable-identity"],
    ],
    [".agents/skills/explore-codebase/SKILL.md", ["agent-validation"]],
    [
      ".agents/skills/grimodex-author/SKILL.md",
      ["agent-validation", "GDX-PRECHECK-001"],
    ],
    [
      ".agents/skills/grimodex-impact-gate/SKILL.md",
      ["agent-validation", "GDX-TRACE-001", "immutable-identity"],
    ],
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
    const route = agents
      .split("\n")
      .find((line) => line.includes(`#${anchor}`));
    assert.match(route, scope, `${anchor} must declare when it applies`);
  }

  const claude = await read("CLAUDE.md");
  assert.match(
    claude,
    /^@AGENTS\.md$/m,
    "Claude must import the shared instruction entrypoint",
  );
  await assertLocalMarkdownLink("README.md", "AGENTS.md");
  for (const skill of [
    "add-electron-command",
    "bump-version",
    "debug-issue",
    "explore-codebase",
    "implement-feature",
    "polish-motion",
    "review-code",
    "ship-branch",
    "test-feature",
  ]) {
    await assertLocalMarkdownLink(
      `.claude/skills/${skill}/SKILL.md`,
      `.agents/skills/${skill}/SKILL.md`,
    );
  }
});

test("validation scope preserves instruction gates and conditional CI without routine overtesting", async () => {
  const policy = await read("policies/quality/iron-laws.md");
  const validation = normalizeSection(
    sectionFromAnchor(policy, "agent-validation"),
  );
  assert.match(
    validation,
    /Investigation.*review only.*Read-only.*no Quick\/Full/i,
  );
  assert.match(validation, /Ordinary prose.*formatting.*diff.*link checks/i);
  assert.match(
    validation,
    /Implementation or bug fix.*Focused checks.*affected boundaries/i,
  );
  assert.match(
    validation,
    /AI instructions.*skills.*policy.*contract tests.*grimodex-impact-gate.*Light/i,
  );
  assert.match(
    validation,
    /Commit only.*requested candidate commit.*no Quick.*merge-readiness/i,
  );
  assert.match(
    validation,
    /PR\/release evidence with CI allowed.*Clean candidate Quick.*immediate verify/i,
  );
  // U7 (2026-10-13): an ordinary PR merges on a rebased Quick and the same-head
  // PR checks; only a release PR and the release tag keep the Full requirement.
  const validationBullets = sectionFromAnchor(policy, "agent-validation")
    .split(/^- /m)
    .slice(1)
    .map(normalizeSection);
  const ordinaryMerge = validationBullets.find((bullet) =>
    bullet.startsWith("Ordinary PR merge"),
  );
  const releaseMerge = validationBullets.find((bullet) =>
    bullet.startsWith("Release PR merge"),
  );
  assert.ok(
    ordinaryMerge,
    "the validation scope must list the ordinary PR merge",
  );
  assert.ok(
    releaseMerge,
    "the validation scope must list the release PR merge",
  );
  assert.match(
    ordinaryMerge,
    /with CI allowed: Rebased clean candidate Quick plus immediate verify, and success of the same-head PR checks, under GDX-TRACE-001; the canonical Full runs on master after the merge/i,
  );
  assert.doesNotMatch(
    ordinaryMerge,
    /Full and verify|release tag/i,
    "an ordinary PR merge must not require Full and verify",
  );
  assert.match(
    releaseMerge,
    /^Release PR merge or release tag with CI allowed: Full and verify under GDX-TRACE-001, including applicable preflight/i,
  );
  assert.ok(
    !validationBullets.some((bullet) =>
      bullet.startsWith("Merge or release tag"),
    ),
    "the old unconditional merge-requires-Full row must be gone",
  );
  assert.match(
    validation,
    /Instruction and policy changes are behavior changes.*Markdown/i,
  );
  assert.match(
    validation,
    /successful command result.*same candidate, environment, and command.*rerun when those inputs change/i,
  );
  assert.match(
    validation,
    /all-suite fallback.*empty, unavailable, or unclassified diffs.*required acceptance receipt/i,
  );

  const agents = await read("AGENTS.md");
  assert.match(agents, /承認済み.*可逆.*修正・検証.*再承認を求めない/s);
  assert.match(agents, /調査・レビューだけ.*read-only/s);
  assert.match(agents, /commit、push、merge、公開.*依頼範囲/s);

  // U3 (2026-10-12): the entrypoint mirrors the bounded NIR-1 delegation.
  const scope = normalizeSection(
    sectionFromHeading(agents, "## 作業範囲と完了"),
  );
  assert.match(
    scope,
    /NIR-1 の残レーン（C-resource、C-body、C-product、D-final 追補、D-transport、D-dispatch、 ?H-store／H-current、DI-1、E）/,
  );
  assert.match(
    scope,
    /worker／owner／終了処理／lifecycle の技術判断と、 ?確認済みの actor・防御・受信先・受入れの範囲内での技術的脅威モデルの改訂/,
  );
  for (const exclusion of [
    "秘密・データの新しい送信先",
    "保存範囲の拡大",
    "閾値の緩和",
    "確認台帳の現行閾値と Gold の緩和・黙示変更",
    "製品公開",
    "製品認可の削除",
    "新しい契約・authority",
  ]) {
    assert.ok(
      scope.includes(exclusion),
      `AGENTS.md delegation exclusion: ${exclusion}`,
    );
  }
  // Same record structure as GDX-PRECHECK-001 and the work record's §3.2.
  assert.match(
    scope,
    /mutation の前に判断と信頼境界をレーンの decisions 文書と PR 本文に残し、判断の ID と記録先を ?\[作業記録\]\(docs\/plans\/nir1-continuation-2026-10\.md\) に載せる/,
  );
  assert.match(scope, /この委任は NIR-1 の残レーンの外には適用しない/);
  assert.doesNotMatch(scope, /8 ms|2 MiB|#610 の C-query 作業では/);
  await assertLocalMarkdownLink(
    "AGENTS.md",
    "docs/plans/nir1-continuation-2026-10.md",
  );
});

test("agent operation contracts keep candidate evidence and bounded identity checks aligned", async () => {
  const ironLaws = await read("policies/quality/iron-laws.md");
  const trace = normalizeSection(sectionFromAnchor(ironLaws, "GDX-TRACE-001"));
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
      assert.ok(
        index > previous,
        `${label} must follow the preceding operation`,
      );
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
  assert.match(
    trace,
    /Quick is immediately verified with the same fixed base\/head values/i,
  );
  assert.match(
    trace,
    /Commit-only or CI-excluded work.*without starting Quick.*does not claim merge\/release readiness/i,
  );
  assert.match(
    trace,
    /without a requested commit or PR.*does not create a commit or start PR-bound CI solely for Quick/i,
  );
  assert.match(
    trace,
    /Pull requests.*`master` pushes.*nightly schedule run the ordinary `ci\.yml` checks automatically/i,
  );
  assert.doesNotMatch(
    trace,
    /do not start hosted GitHub Actions runners/i,
    "GDX-TRACE-001 must describe the automatic ordinary CI added by #627",
  );
  assert.match(
    trace,
    /Ordinary checks are not a canonical Quick\/Full receipt/i,
  );
  assert.match(
    trace,
    /absence of hosted PR checks is not evidence of a passing gate/i,
  );
  assert.match(
    trace,
    /Canonical Quick and Full run as a hosted `canonical-ci\.yml` `workflow_dispatch` with `profile`, `candidate_base`, and `candidate_head`; the dispatched ref's head must equal `candidate_head`/i,
  );
  assert.match(
    trace,
    /hosted Quick runs its immediate verify in the same job/i,
  );
  assert.match(
    trace,
    /`full-aggregate` job, which assembles the single receipt and runs the immediate verify with the same tuple; a re-run re-runs all jobs, never only failed ones/i,
  );
  assert.match(
    trace,
    /Full admission refuses a local `pnpm ci:local:full` outside a standard GitHub-hosted job, so a local Full is never merge evidence/i,
  );
  assert.match(
    trace,
    /hosted Full, Full admission observes.*fresh part VM.*no other canonical Full for the same target ref/i,
  );
  assert.match(
    trace,
    /squash merge through `gh` uses `gh pr merge --squash --match-head-commit` with the candidate head/i,
  );
  assert.match(
    trace,
    /Windows NSIS final compilation.*separate manual Full CI.*tag-release obligation.*unavailable release-only check is never passed/i,
  );

  // U7 (2026-10-13), A: an ordinary PR merges on a rebased, complete Quick and
  // the same-head PR checks; canonical Full is not an ordinary merge condition.
  assert.match(
    trace,
    /An ordinary PR is every PR that is not a release PR; it merges on the complete Quick of a rebased candidate and the same-head ordinary checks/i,
  );
  assert.match(
    trace,
    /After `git fetch origin master`, the current `origin\/master` must be an ancestor of the candidate HEAD \(rebased\); otherwise rebase and take the candidate again/i,
  );
  // Review P3: the condition is the ancestry, and rebasing a pushed branch needs
  // a force push that requires the user's explicit permission.
  assert.match(
    trace,
    /The condition is the ancestry, not the method: where a force push is not allowed \(it needs the user's explicit permission\), merge `origin\/master` into the branch instead of rebasing/i,
  );
  assert.match(
    trace,
    /Resolve immutable `candidate_base` and `candidate_head` values once as expanded shell-local strings, pass those same strings to the canonical Quick \(local, or hosted with `profile=quick`\) and every verify of that receipt, and obtain a complete Quick receipt/i,
  );
  // Review P2: the receipt itself must prove the candidate was rebased when the
  // Quick was taken. The local Quick does not check ancestry, so the merge
  // re-checks it from the receipt's own pair (a PR-only Quick on a stale branch
  // must not become merge evidence just because the candidate is unchanged).
  // Review P3: the base must also be on origin/master. A base taken from the
  // branch passes the head ancestry check, yet the impact selection sees only
  // base..head and narrows the Quick to part of the PR diff.
  assert.match(
    trace,
    /Before merge, after `git fetch origin master`, `candidate_base` must be an ancestor of both `candidate_head` and `origin\/master` \(`git merge-base --is-ancestor "\$candidate_base" "\$candidate_head"` and `git merge-base --is-ancestor "\$candidate_base" origin\/master`\), where `candidate_base` is the `origin\/master` fetched just before that Quick; it stays an ancestor after `origin\/master` advances, so freshness is not asked/i,
  );
  assert.match(
    trace,
    /The local Quick checks neither and the hosted Quick checks only the first; a base that is not on `origin\/master`, such as a commit on the branch, narrows the Quick's changed-path selection to part of the PR diff/i,
  );
  assert.match(
    trace,
    /A Quick whose pair fails either check \(for example one taken for a PR-only goal on a branch that had fallen behind\) is not merge evidence even when the candidate is unchanged, and the Quick is taken again after the branch is brought up to date/i,
  );
  assert.match(
    trace,
    /The ordinary `ci\.yml` PR checks must have succeeded on the same head with none pending or failing, and the review gate must hold \(no requested changes, no unresolved thread, no P2\+ finding\)/i,
  );
  assert.match(
    trace,
    /Merge with `gh pr merge --squash --match-head-commit` and the candidate head\. The current base is not required to equal a recorded base immediately before merge/i,
    "the ordinary path keeps the expected-head merge",
  );
  assert.match(
    trace,
    /The current base is not required to equal a recorded base immediately before merge, and this path does not use `approved_merge_base`/i,
  );
  assert.match(
    trace,
    /PR HEAD still equals `candidate_head`, neither the rebase nor the Quick is repeated; only a conflict or a needed candidate change restarts from the rebase/i,
  );
  assert.match(
    trace,
    /a squash merge commit whose first parent \(`<merge-sha>\^1`\) differs from `candidate_base` may be recorded but is not a failure on this path/i,
  );
  assert.match(
    trace,
    /Canonical Full is not an ordinary PR merge condition, and no Full is dispatched for an ordinary PR/i,
  );

  // B: the master Full compensates operationally after the merge.
  assert.match(
    trace,
    /The party that merged an ordinary PR then dispatches a hosted canonical Full on the `origin\/master` head \(`--ref master`, `candidate_head` the master head, `candidate_base` the master commit that last passed a complete Full, or the merge commit's first parent when that is unknown\), and the next merge does not wait for it/i,
  );
  assert.match(
    trace,
    /If a canonical Full for `master` is already running, dispatch nothing now; after it finishes, dispatch one Full on the latest master head, so that several merges share one Full/i,
  );
  // Review P3: who dispatches the one coalesced Full when the merging party
  // cannot wait for the running one.
  assert.match(
    trace,
    /A party that cannot wait for that one dispatch reports it as pending and hands it to its caller \(the integrator, or the user who requested the work\), who first checks that no Full already covers the latest master head/i,
  );
  // Review P3: the party that dispatched the master Full owns watching it, or
  // hands the run id to its caller; nobody else reverts for it.
  assert.match(
    trace,
    /The party that dispatched a Full watches it to completion and starts the red handling below if it fails; a party that cannot wait reports the run id and hands the watching to its caller/i,
  );
  assert.match(
    trace,
    /A master Full follows the same Full rules as any other Full: the resource-isolation preflight, all part jobs plus `full-aggregate`, re-running all jobs, and no local Full as evidence/i,
  );
  // Review P2: red is judged per attempt. A re-run of all jobs shows no
  // conclusion for hours, so "the latest completed Full" would reopen merging
  // while a failed Full is being re-run (fail-open). The red persists through the
  // re-run and clears only by a success or by the fix/revert landing.
  assert.match(
    trace,
    /A failed master Full takes priority over other work\. Master is red when the last concluded attempt of the newest master Full run that has a concluded attempt \(not counting a run stopped at the selection validation\) did not succeed \(it failed, was cancelled, or timed out\)/i,
  );
  assert.match(
    trace,
    /A run whose jobs are being re-run is judged by the attempt before the re-run, and a first attempt that is still running is skipped, so a re-run in progress does not reopen merging/i,
  );
  assert.match(
    trace,
    /While master is red, merge only the fix or the revert: before the next merge, re-run all jobs to see whether it reproduces and find which merge introduced it, then merge the fix or the revert ahead of other PRs/i,
  );
  assert.match(
    trace,
    /Red clears only when a re-run or a later master Full completes successfully, or when the fix or the revert is on `origin\/master`/i,
  );
  assert.match(
    trace,
    /The one exception is a failure shown to be an unrelated flake and recorded where the merging party can read it: other merges are not blocked while all jobs are re-run, a red whose record cannot be found is not treated as a flake, and a failed re-run ends the exception/i,
  );
  assert.match(
    trace,
    /A party that only has merge authority and finds master red stops merging and reports to its caller, who decides whether to revert/i,
  );
  assert.doesNotMatch(
    trace,
    /latest (?:completed|finished) (?:master )?(?:canonical )?Full/i,
    "master red is judged per attempt, not by the latest completed Full",
  );
  // Review P3: a run stopped by the dispatch's own selection validation (master
  // advanced between resolving candidate_head and the dispatch) never ran the
  // Full, so it is not a red master Full that would block the next merge.
  assert.match(
    trace,
    /A run that stopped at the dispatch's selection validation \(for example because `master` advanced between resolving `candidate_head` and the dispatch, so that it no longer equals the head of the dispatched ref\) never ran the Full: it is neither a green nor a red master Full, it is not re-run, and a new dispatch with a fresh `candidate_head` replaces it/i,
  );

  // C: a release PR keeps the Full-based merge evidence, the base check right
  // before merge, the first-parent comparison and the narrow exception; the
  // release tag keeps its own complete Full on the merged commit.
  // Review P3: a release PR is decided by the content of the change, not by
  // whether bump-version prepared it; an unclear case takes the release path.
  assert.match(
    trace,
    /A release PR is any PR that changes the `package\.json` `version`, including the version-bump PR prepared by `bump-version`; when it is unclear whether a PR is one, treat it as a release PR\. A release PR keeps a complete hosted Full as merge evidence/i,
  );
  assert.doesNotMatch(
    trace,
    /A release PR is the version-bump PR prepared by/i,
    "a release PR is not defined by who prepared it",
  );
  assert.match(
    trace,
    /A release PR's initial merge Full first confirms the fetched current `origin\/master` is an ancestor of the candidate HEAD, then resolves immutable `candidate_base` and `candidate_head` values once/i,
  );
  assert.match(
    trace,
    /A release merge precheck fetches `origin\/master` before base comparison or classification and records exactly one `approved_merge_base`/i,
  );
  assert.match(
    trace,
    /On the release path only, immediately before merge, fetch `origin\/master` and confirm the current base equals the recorded `approved_merge_base`/i,
  );
  assert.match(
    trace,
    /For a release PR's squash merge only, after merge and fetch, compare the actual squash merge commit's first parent \(`<merge-sha>\^1`\) once with the recorded `approved_merge_base`/i,
  );
  assert.match(
    trace,
    /On the release path, an upstream-base change is exempt from a Full rerun only when/i,
  );
  assert.match(
    trace,
    /A release tag requires a new complete Full run on the merged release commit itself/i,
  );
  // The stale unscoped wording must not come back.
  assert.doesNotMatch(
    trace,
    /The initial merge Full first confirms|Immediately before merge, fetch|\. An upstream-base change is exempt from a Full rerun only when/,
    "the merge-time Full and base rules must be scoped to the release path",
  );
  assert.doesNotMatch(
    trace,
    /same merge queue/i,
    "a master Full is coordinated per target ref, not per merge queue",
  );
  assert.match(
    trace,
    /no other canonical Full for the same target ref \(`master`, or the release PR branch\) is in progress/i,
  );

  for (const contract of [identity, matrix]) {
    assert.match(
      contract,
      /immutable child.*revision|immutable.*child.*revision/i,
    );
    assert.match(
      contract,
      /親`runId`だけ.*再選択|parent.*runId.*reselect|reselect.*parent.*runId.*alone/is,
    );
    assert.match(
      contract,
      /limit.*順序.*cursor.*N\/N\+1|limit.*order.*cursor.*N\/N\+1/i,
    );
    assert.match(
      contract,
      /(?:操作対象外|対象外)Decision.*不変|non-target.*Decision.*unchanged/i,
    );
  }
  assert.match(
    identity,
    /restor.*Decision.*reread.*display.*receipt.*same.*(?:child|revision).*ID/i,
  );
  assert.match(
    identity,
    /(?:limit.*filter|filter.*limit|limit.*不存在|limit.*absence)/i,
  );
  assert.match(
    identity,
    /durable ID.*corresponding UI.*projection.*before editing/i,
  );
  assert.match(identity, /selector.*(?:ready|readiness)/i);
  assert.match(
    runbook,
    /durable ID.*corresponding UI\s*projection before editing/is,
  );
  assert.match(runbook, /selector.*ready signal/);
  assert.match(runbook, /33 catalog entries as 11\/11\/11 shards/);
  // U7 (2026-10-13): the runbook and the setup guide point to GDX-TRACE-001
  // instead of treating Full as the ordinary merge evidence.
  assert.match(
    normalizeSection(runbook),
    /An ordinary PR merges on its rebased clean candidate's complete Quick plus the same-head `ci\.yml` checks, so canonical Full is not an ordinary-PR merge condition\. Full runs on `master` after such a merge, and it remains the merge evidence for a release PR and the release tag/,
  );
  await assertLocalMarkdownLink(
    "docs/local-ci-runner.md",
    "policies/quality/iron-laws.md",
    "GDX-TRACE-001",
  );
  const setupGuide = await read("docs/DEVELOPMENT_SETUP.md");
  assert.match(
    normalizeSection(setupGuide),
    /通常のPRのmerge前は、最新の`origin\/master`へrebaseしたcleanかつcommit済みの現在HEADで ?Quickと直後のverifyを実行し、同じheadの`ci\.yml` checksが成功していればmergeできます。 ?canonical Fullは通常のPRのmerge条件ではなく、merge後にmasterのheadで実行します/,
  );
  assert.match(
    normalizeSection(setupGuide),
    /release PRのmerge前と、release tag前.*には、cleanな現在HEADでFullを最初のstageから実行します/,
  );
  assert.doesNotMatch(
    setupGuide,
    /merge前は、最新の`origin\/master`を含むcleanかつcommit済みの現在HEADで、ローカルで/,
    "the setup guide must not keep Full as the ordinary merge evidence",
  );
  // Review P3: the same section must not contradict itself. ci.yml runs on PRs,
  // master pushes and the schedule (scripts/ci-pause.test.mjs binds the
  // triggers), and Full admission refuses a Full that is not a GitHub-hosted
  // job, so the guide dispatches the hosted workflow instead of showing a local
  // Full that is no evidence.
  assert.match(
    normalizeSection(setupGuide),
    /`\.github\/workflows\/ci\.yml` は、通常のPR、`master`へのpush、nightlyで自動実行されます ?（手動実行とtag releaseからの再利用呼び出しも受け付けます）。この通常checksは、 ?canonical Quick／Fullのreceiptの代わりにはなりません/,
  );
  assert.doesNotMatch(
    setupGuide,
    /通常のPR、branch push、scheduleからGitHub Actionsの|明示的な手動実行とtag releaseからの/,
    "the setup guide must not say that ci.yml is not started by PRs, pushes or the schedule",
  );
  const ciOn = yaml.load(await read(".github/workflows/ci.yml")).on;
  assert.ok(
    ciOn.pull_request && ciOn.push && ciOn.schedule,
    "the setup guide states that ci.yml runs on PRs, master pushes and the schedule",
  );
  assert.match(
    normalizeSection(setupGuide),
    /Fullを証跡にできるのは、GitHub-hostedの ?`canonical-ci\.yml`で実行したものだけです。Full admissionが標準のGitHub-hosted job以外を拒否するため、 ?手元で`pnpm ci:local:full`を実行してもmerge／releaseの証跡になりません。dispatchの手順は ?`ship-branch`に従います/,
  );
  assert.match(
    setupGuide,
    /gh workflow run canonical-ci\.yml --ref <branch> -f profile=full -f candidate_base=<base-sha> -f candidate_head=<head-sha>/,
  );
  assert.doesNotMatch(
    setupGuide,
    /^pnpm ci:local:full -- --(?:base|from)/m,
    "the setup guide must not show a local Full that Full admission refuses",
  );
  await assertLocalMarkdownLink(
    "docs/DEVELOPMENT_SETUP.md",
    "policies/quality/iron-laws.md",
    "GDX-TRACE-001",
  );
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
  assert.match(
    bump,
    /上記のPR／release条件を満たす場合だけ.*Quickと直後のverifyを実行/is,
  );
  assert.match(createBranch, /git worktree add -b/);
  assert.match(createBranch, /保存先とbranch名の衝突/);
  assert.match(
    createBranch,
    /明示された新worktreeでは元checkoutのdirty状態は停止条件にせず/,
  );
  assert.match(
    ship,
    /依頼が push のみ、PR 作成まで、マージまで.*依頼文から確定/,
  );
  assert.match(
    ship,
    /push のみでは.*PR／merge 用 Quick／Full.*開始せず.*remote HEAD 確認で完了/,
  );
  assert.match(
    ship,
    /PR 作成までなら.*Quick gate.*完了し.*merge 用 gate へ進まない/,
  );
  assert.match(
    ship,
    /auto-merge が有効.*push のみまたは PR 作成だけ.*push せず停止/,
  );
  assert.match(ship, /candidate_base.*candidate_head.*Quick.*verify/is);
  assert.match(
    ship,
    /PR／releaseの証跡が依頼範囲に含まれ.*CIが許可されている場合に限り.*Quick/is,
  );
  assert.match(
    ship,
    /CI明示除外の作業ではQuickを開始せず.*merge／release readiness/is,
  );
  assert.match(
    ship,
    /上記のPR／release／CI条件を満たす場合だけ.*Quickと直後のverify/is,
  );
  // U7 (2026-10-13): the default path is a rebased Quick plus the same-head PR
  // checks; Full is required only on the release path.
  const shipFlat = normalizeSection(ship);
  assert.match(
    shipFlat,
    /マージまでがゴールなら、通常のPRでは merge 後の master の Full の dispatch（§8）まで含む/,
    "a merge goal includes the post-merge master Full for an ordinary PR",
  );
  assert.match(
    shipFlat,
    /本文の「手順N」と「§N」は節 N（`## N\.`）を、「§N\.M」はその節の項目 M を指す/,
  );
  assert.doesNotMatch(
    shipFlat,
    /手順[678]/,
    "references to the sections 6-8 use §N, because §2 has items numbered 6-8 too",
  );
  // Review P3: the kind of PR is decided by the content of the change.
  assert.match(
    shipFlat,
    /release PR（`package\.json` の `version` を変える PR。`\/bump-version` が作るものを含む。以下 release path。判定は §1\.9）/,
  );
  assert.match(
    shipFlat,
    /通常のPRか release PR かを決める。作り方ではなく内容で決め、`package\.json` の `version` を変える PR（`\/bump-version` が作るものを含む）を release PR、それ以外を通常のPRとする。 ?`git diff origin\/master\.\.\.HEAD -- package\.json` の差分に `"version"` の行があるかで確かめ、迷う場合は release PR として release path に倒す/,
  );
  assert.doesNotMatch(
    shipFlat,
    /`\/bump-version` が作る、`package\.json` の `version` を上げる PR だけが release PR/,
    "a release PR is not defined by who prepared it",
  );
  assert.match(
    shipFlat,
    /通常のPRでQuickを取る場合（CIが許可されているとき。PR作成だけがゴールの場合も含む）は、Quickの前に`git fetch origin master`を実行し、 ?current `origin\/master`がcandidate HEADの祖先（rebase済み）であることを`git merge-base --is-ancestor origin\/master HEAD`で確認する。 ?ローカルのQuickは祖先関係を検証しない（hostedの`canonical-ci\.yml`は検証する）。祖先でなければ、branchを同期してレビュー対象を取り直し、 ?cleanなcommit済みHEADで最初のstageからやり直す。条件は「`origin\/master`がHEADの祖先であること」で、同期の方法は問わない/,
  );
  // Review P3: rebasing a pushed branch needs a force push, which section 3.4
  // forbids without the user's explicit word, so merging origin/master is the
  // fallback; the expected-head lease is used only when the user allowed it.
  assert.match(
    shipFlat,
    /未pushのbranchは`origin\/master`へrebaseする。 ?- push済みのbranchをrebaseするとforce pushが必要になる。§3\.4のとおり、ユーザーがforce pushを明示した場合に限り、 ?リモートの現在のheadを期待値にした`git push --force-with-lease=<branch>:<リモートの現在のhead SHA> origin <branch>`で更新する。 ?- force pushが明示されていないpush済みのbranchは、`origin\/master`をbranchへmergeして取り込む。通常のPRはsquash mergeなので、branch上のmerge commitは残らない/,
  );
  assert.match(
    sectionFromHeading(ship, "## 3. Branch を push する"),
    /force push、base branch push、wildcard refspec は、ユーザーが明示しない限り使用しない/,
    "the sync methods above must keep section 3.4 as the force-push gate",
  );
  assert.match(
    shipFlat,
    /通常のPRのmerge証跡は、上記のcompleteなQuick receipt（`candidate_base`が`candidate_head`と`origin\/master`の両方の祖先であるもの。確認は§6）と、同じheadの通常PR checks（`ci\.yml`）の成功である。 ?その祖先条件を満たさないQuick（PR作成だけがゴールのときに祖先確認なしで取ったQuickなど）は、候補が変わっていなくてもmerge証跡にせず、 ?branchを同期して§2\.3から取り直す。 ?canonical Fullは通常のPRの ?merge条件ではなく、通常のPRのためにFullをdispatchしない/,
  );
  assert.match(
    shipFlat,
    /通常のPRではmerge直前にcurrent baseが`candidate_base`と一致することを要求せず、 ?`approved_merge_base`も使わない/,
  );
  assert.match(
    shipFlat,
    /GitHubが衝突なしでmergeableと判定し、PR HEADが`candidate_head`と ?一致していれば、rebaseとQuickのやり直しは不要。衝突がある、または候補を変える必要がある場合だけ、branchを同期（§2\.3）して ?祖先確認からやり直す/,
  );
  assert.match(
    shipFlat,
    /通常のPRのmergeまでが依頼されていてもCIが明示的に除外されている場合は、 ?Quickとmergeを開始せず、merge readinessを主張しない/,
  );
  assert.match(
    shipFlat,
    /release PRでmergeまでがゴールでCIが許可されている場合だけ、Fullを要求する/,
  );
  assert.match(
    shipFlat,
    /release PRのmergeまでが依頼されていてもCIが明示的に除外されている場合はFullとmergeを開始せず/,
  );
  assert.match(
    shipFlat,
    /上記のrelease／CI条件を満たす場合だけ.*Fullと直後のverify/,
  );
  assert.doesNotMatch(
    shipFlat,
    /上記のmerge／CI条件を満たす場合だけ|mergeまでがゴールでCIが許可されている場合、初回Fullの前提/,
    "the Full requirement must be scoped to the release path",
  );
  assert.match(bump, /release commit後.*cleanなHEAD.*Quick.*verify/is);
  assert.match(
    bump,
    /release_base.*release_head.*ci:local:full.*ci:local:verify/is,
  );
  assert.match(
    bump,
    /tag／Draft Releaseが依頼範囲に含まれ.*CIが許可され.*mergeが完了した場合だけ.*Full/is,
  );
  assert.match(
    bump,
    /local／commit-only／PR-only.*CI明示除外.*Step 9.*Full／verify／tag／Draft Releaseを開始せず.*release readiness/is,
  );
  assert.match(
    bump,
    /上記のrelease／CI／merge条件を満たす場合だけ.*release Fullと直後のverify/is,
  );
  // U7 (2026-10-13): a release PR merges through ship-branch's release path
  // (hosted Full, approved_merge_base, first-parent check), never the ordinary
  // Quick path and never a local Full.
  assert.match(
    bump,
    /`\/ship-branch` のrelease path（completeなhosted Fullと直後のverify、`approved_merge_base`による直前のbase照合、mergeability、レビュー、HEAD固定、squashのfirst-parent照合）を満たす。通常のPR用のQuick経路は使わない/,
  );
  assert.doesNotMatch(bump, /completeなローカルFull/);

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
    "## 2. canonical CI gateを固定する",
  );
  const shipCiSection = normalizeSection(shipCiRawSection);
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
  assert.match(
    policySection,
    /acceptance reviewer\(s\).*must not edit the candidate/i,
  );
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
  // U7 (2026-10-13), review P3: the P2+ review convergence gates the merge on
  // both paths (a release PR also before the expensive Full), and after the
  // canonical Quick or Full the acceptance only confirms an unchanged candidate.
  assert.match(
    policySection,
    /High-effort review and candidate-untouched independent acceptance must resolve P2\+ findings before freeze and merge \(for a release PR, before the expensive Full as well\); after the canonical Quick or Full, acceptance confirms the unchanged candidate and does not reopen semantics without a candidate change/i,
  );
  assert.match(
    shipCiSection,
    /高リスク作業では、merge（release PR ではexpensive Fullも）より前に high-effort review と candidate-untouched independent acceptance review を収束させ、P2\+ findingを解消する。acceptance reviewerはread-onlyで候補を編集しない。 ?focused gatesを通過してcandidateをfreezeした後、QuickまたはFull完了後のacceptanceはcandidateが不変であることだけを確認し/,
  );
  assert.match(
    policySection,
    /any fixed capacity\/quota threshold.*percentage.*inode.*numeric.*host-specific cache deletion list.*deletion automation/i,
  );
  assert.match(
    policySection,
    /thresholds.*risk, workload, and filesystem state.*hardcoding/i,
  );
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
  assert.match(
    policySection,
    /Do not infer environment or product status from touched paths/i,
  );

  for (const phrase of [
    /data categories.*permission/i,
    /claude-fable-5-1/i,
    /effort.*high/i,
    /Fast/i,
  ]) {
    assertPolicyContract("external-review model contract", phrase);
  }
  assert.match(
    policySection,
    /external Claude review.*start-of-work precheck/i,
  );
  assert.match(policySection, /requested and effective model/i);
  assert.match(policySection, /never silently substitute/i);
  assert.match(policySection, /not blanket.*all repositories or logs/i);

  // U3 (2026-10-12): the technical delegation covers only the remaining NIR-1
  // lanes, keeps the six exclusions, and refers to the confirmation ledger
  // instead of restating retired 8 ms / 2 MiB values.
  assert.match(
    policySection,
    /remaining NIR-1 lanes \(C-resource, C-body, C-product, the D-final addendum, D-transport, D-dispatch, H-store\/H-current, DI-1 and E\)/,
  );
  assert.match(
    policySection,
    /delegated technical decisions on worker, owner, termination and lifecycle, and technical threat-model revisions within the already confirmed actors, defenses, recipients and acceptance/i,
  );
  // The decision itself lives in the lane's decision record and PR body; the
  // work record only indexes it (same structure as the work record's §3.2).
  assert.match(
    policySection,
    /records each decision and its trust boundary in the lane's decision record and the PR body, and indexes the decision ID and record location in the \[NIR-1 work record\]\(\.\.\/\.\.\/docs\/plans\/nir1-continuation-2026-10\.md\)/,
  );
  await assertLocalMarkdownLink(
    "policies/quality/iron-laws.md",
    "docs/plans/nir1-continuation-2026-10.md",
  );
  assert.match(
    policySection,
    /hard decision, obtain read-only advisor input and decide explicitly/i,
  );
  assert.match(
    policySection,
    /delegated technical decision, not a claim of individual user approval/i,
  );
  for (const exclusion of [
    /New recipients of secrets or data/,
    /expanded storage scope/,
    /relaxed thresholds \(including any relaxation or silent change of the current confirmation-ledger thresholds and Gold\)/,
    /product publication/,
    /deleting product authorization/,
    /new contracts or authorities fall outside this delegation and still fail the precheck/,
  ]) {
    assertPolicyContract("NIR-1 delegation exclusion", exclusion);
  }
  assert.match(
    policySection,
    /delegation does not apply outside the remaining NIR-1 lanes/i,
  );
  assert.doesNotMatch(
    policySection,
    /8 ms|2 MiB|PR #610's C-query worker|Astra Max/,
    "the delegation must cite the confirmation ledger, not retired #610-only values",
  );

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
  assert.ok(
    fetchBeforeApproval >= 0,
    "merge precheck must fetch before approval",
  );
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
  }
  // U7 (2026-10-13): only the release path records one approved_merge_base and
  // compares the squash first parent; the ordinary path does neither as a gate.
  // GDX-PRECHECK-001 points to GDX-TRACE-001 instead of restating the rule.
  assert.match(
    policySection,
    /defined in \[GDX-TRACE-001\]\(#GDX-TRACE-001\); only the release path records an `approved_merge_base` and compares the squash merge commit's first parent \(`<merge-sha>\^1`\) with it after merge/i,
  );
  assert.doesNotMatch(
    policySection,
    /A merge precheck fetches before comparing|either the verified candidate base on the normal path/i,
    "GDX-PRECHECK-001 must not restate the merge precheck",
  );
  assert.match(
    traceSection,
    /records exactly one `approved_merge_base`: the verified candidate base when no exception applies, or the current base only after the narrow editorial docs\/ADR-only exception is approved/i,
    "one approved merge base must be recorded on the release path",
  );
  assert.doesNotMatch(
    traceSection,
    /on the normal path/i,
    "the release path wording must not say 'normal path', which reads as the ordinary path",
  );
  assert.match(
    traceSection,
    /first parent.*<merge-sha>\^1.*approved_merge_base/i,
  );
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
  // #627 / #610 reality: ordinary ci.yml checks are automatic, and the
  // canonical Full is a hosted canonical-ci.yml dispatch of the same tuple.
  assert.match(
    shipCiSection,
    /通常の PR／`master` push では `ci\.yml` の checks が自動で走るが、canonical Quick／Full receipt の代わりにはならない/,
  );
  assert.match(
    shipCiSection,
    /gh workflow run canonical-ci\.yml --ref "\$\(git branch --show-current\)" -f profile=full -f candidate_base="\$candidate_base" -f candidate_head="\$candidate_head"/,
  );
  assert.match(
    shipCiSection,
    /Full admissionは標準のGitHub-hosted job以外を拒否するため、 ?ローカル実行のFullはmerge証跡にならない/,
  );
  assert.match(
    shipCiSection,
    /全part jobと`full-aggregate`が成功したrunだけをcompleteなFull receiptとする。失敗したrunは失敗jobだけでなく全jobを再実行する/,
  );
  assert.doesNotMatch(
    shipCiRawSection,
    /^\s*pnpm ci:local:full -- --base/m,
    "ship-branch must not run a local Full that Full admission refuses",
  );
  for (const binding of commandBindings(
    shipCiRawSection,
    "pnpm ci:local:full",
    "Full aggregate",
  )) {
    assert.deepEqual(binding, {
      base: '"$candidate_base"',
      head: '"$candidate_head"',
    });
  }
  assert.match(
    shipCiRawSection,
    /pnpm ci:local:full -- --aggregate --base "\$candidate_base"/,
  );
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

  // U7 (2026-10-13): the pre-merge snapshot has a common part, an ordinary-path
  // part (Quick receipt, no base equality, no approved_merge_base) and a
  // release-path part that keeps the hosted Full and the approved base.
  const shipMergePrecheck = normalizeSection(shipMergePrecheckRawSection);
  const ordinaryPrecheck = shipMergePrecheck.indexOf(
    "通常path（通常のPR）では、さらに次を確認する",
  );
  const releasePrecheck = shipMergePrecheck.indexOf(
    "release path（release PR）では、上の通常path固有の確認の代わりに次を確認する",
  );
  assert.ok(ordinaryPrecheck >= 0, "the ordinary-path checks must exist");
  assert.ok(
    releasePrecheck > ordinaryPrecheck,
    "the release-path checks must follow the ordinary-path checks",
  );
  const commonPrecheck = shipMergePrecheck.slice(0, ordinaryPrecheck);
  const ordinaryChecks = shipMergePrecheck.slice(
    ordinaryPrecheck,
    releasePrecheck,
  );
  const releaseChecks = shipMergePrecheck.slice(releasePrecheck);
  assert.match(
    commonPrecheck,
    /同じ head の通常 PR checks（`ci\.yml`）が成功している/,
  );
  // Review P3: the pending/failed bullet is pinned in sequence with its
  // neighbours, so deleting any one of the gate bullets fails the test.
  assert.match(
    commonPrecheck,
    /- 設定されている全required checksがsuccess - 同じ head の通常 PR checks（`ci\.yml`）が成功している - pending／failed checks がない - requested changes と未解決 review thread がない/,
  );
  // Review P2: red is judged per attempt (§8.5). A run whose jobs are being
  // re-run has no conclusion for hours, so "the latest completed Full" would let
  // other merges through while the re-run of a failed Full is in flight.
  assert.match(
    commonPrecheck,
    /master の Full が赤でない（判定は §8\.5。run の結論ではなく attempt の結論で見るので、全 job を再実行している間も、直前の attempt が赤なら赤のままである）。 ?赤ならその修正または revert 以外の PR を merge しない（§8\.6）/,
  );
  assert.doesNotMatch(
    commonPrecheck,
    /最新の完了した canonical Full/,
    "the pre-merge red check must not look only at completed Full runs",
  );
  assert.match(
    ordinaryChecks,
    /手順2で固定した`candidate_base`／`candidate_head`のcompleteなQuick receiptがある。ローカルのQuickは、直後の ?`pnpm ci:local:verify -- quick --base "\$candidate_base" --head "\$candidate_head"`が成功している。hosted Quickは ?dispatchしたrunの`headSha`が`candidate_head`と一致し、同じjobのverifyまで成功している/,
  );
  // Review P2: the receipt's own pair must prove the Quick was taken on a
  // rebased candidate; the local Quick does not check ancestry by itself.
  // Review P3: the base must also be on origin/master, or a base taken from the
  // branch would still pass the head ancestry check while the Quick covers only
  // part of the PR diff.
  assert.match(
    ordinaryChecks,
    /そのreceiptの`candidate_base`が`candidate_head`と`origin\/master`の両方の祖先である。 ?上の`git fetch origin master`の後に ?`git merge-base --is-ancestor "\$candidate_base" "\$candidate_head"`と`git merge-base --is-ancestor "\$candidate_base" origin\/master`の両方が成功する/,
  );
  assert.match(
    ordinaryChecks,
    /（`candidate_base`は、そのQuickの直前に`git fetch origin master`で取った`origin\/master`のはずで、その後に`origin\/master`が進んでいても祖先のままである。鮮度は問わない）/,
  );
  assert.match(
    ordinaryChecks,
    /hostedのQuickは前者をjob内で確認するが、ローカルのQuickはどちらも確認しない。branch上のcommitのようにmasterにないcommitを`candidate_base`にしたQuickは、 ?`candidate_head`の祖先であってもPRの差分の一部しか対象に選ばないので、後者で拒否する/,
  );
  assert.match(
    ordinaryChecks,
    /どちらかが成功しないQuick receipt（PR作成だけがゴールのときに祖先確認なしで取ったQuickなど）は、候補が変わっていなくてもmerge証跡にしない。 ?branchを同期（§2\.3）して、§2\.3の祖先確認からQuickを取り直す/,
  );
  assert.match(
    ordinaryChecks,
    /current fetched baseが`candidate_base`と一致することは要求せず、 ?`approved_merge_base`も使わない/,
  );
  assert.match(
    ordinaryChecks,
    /Quickの後に`origin\/master`が進んでいても、mergeableで衝突がなくPR HEADが`candidate_head`のままなら、rebaseとQuickのやり直しは不要/,
  );
  assert.match(
    ordinaryChecks,
    /衝突がある、または候補を変える必要があるときだけ、branchを同期（§2\.3）して§2\.3の祖先確認からやり直す/,
  );
  assert.doesNotMatch(
    ordinaryChecks,
    /pnpm ci:local:verify -- full|full-aggregate/,
    "the ordinary path must not require a Full receipt",
  );
  assert.match(
    releaseChecks,
    /exactly oneの`approved_merge_base` commitを記録する/,
  );
  assert.match(
    releaseChecks,
    /`full-aggregate` jobで`pnpm ci:local:verify -- full --base "\$candidate_base" --head "\$candidate_head"`が成功している/,
  );
  assert.match(
    releaseChecks,
    /exception pathでは.*狭いdocs\/ADR-only exception/,
  );

  // Section 7: both paths use the expected-head merge; only the release path
  // compares the squash first parent with the approved base.
  assert.match(
    shipMergeSection,
    /`gh pr merge --squash --match-head-commit "\$candidate_head"` のように ?`--match-head-commit <sha>` を使う。通常pathもrelease pathも同じである/,
  );
  assert.match(
    shipMergeSection,
    /通常pathでは、squash merge commitのfirst parent（`<merge-sha>\^1`）が`candidate_base`と違っても失敗にしない。報告に記録してよい/,
  );
  assert.match(
    shipMergeSection,
    /release pathのsquash mergeの場合だけ、実際のsquash merge commitのfirst parent（`<merge-sha>\^1`）を`approved_merge_base`と一度だけ比較する/,
  );

  // Section 5: the wait gate names the Quick receipt (ordinary) and adds the
  // hosted Full receipt only for a release PR.
  const shipWait = normalizeSection(
    sectionFromHeading(ship, "## 5. CI とレビュー gate を待つ"),
  );
  assert.match(
    shipWait,
    /required check が設定されていない場合も、同じ head の通常 PR checks（`ci\.yml`）の成功（pending や failure がない）と、 ?手順2のcompleteなQuick receiptが有効であることを確認してから次へ進む。release PR では、これに加えて ?手順2のcompleteなhosted Full receipt（同じtupleの`full-aggregate`成功）が有効であることを確認する/,
  );

  // Section 8 (new): after an ordinary merge, dispatch one hosted Full on
  // master, coalesce while one is running, and handle a red result first.
  const shipMasterFull = normalizeSection(
    sectionFromHeading(
      ship,
      "## 8. merge 後に master の Full を走らせ、赤は優先して直す",
    ),
  );
  assert.match(
    shipMasterFull,
    /通常のPRをmergeした場合に実行する（マージまでがゴールの通常のPRでは依頼範囲に含まれる）。canonical Fullは通常のPRのmerge条件ではなく、 ?merge後に運用で補う証跡である/,
  );
  assert.match(
    shipMasterFull,
    /release PRはmerge前にcompleteなhosted Fullを通しているため、master のFullを重ねてdispatchしなくてよい/,
  );
  assert.match(
    shipMasterFull,
    /dispatch の `candidate_base` 入力（下の `master_base`）には、直前にcompleteなFull ?（全part jobと`full-aggregate`が成功）を通した master の commit を使う.*分からなければ ?merge commit のfirst parent（`<merge-sha>\^1`）を使う/,
  );
  // Review P3: queued runs have no jobs yet, so a run that cannot be proven to
  // be something else is treated as a Full; a Full on the latest master head
  // (running, queued or successful) already covers it.
  assert.match(
    shipMasterFull,
    /master のcanonical Fullの状況をread-onlyで確認する。`gh run list --workflow canonical-ci\.yml --branch master --event workflow_dispatch --limit 20 --json databaseId,attempt,headSha,status,conclusion,createdAt`のrunのうち、 ?`gh run view <run-id> --json jobs` のjob名が`full-<part>`のものがFullである/,
  );
  assert.match(
    shipMasterFull,
    /queuedのrunはjobsがまだ無く、job名ではFullと判別できないことがある。 ?Fullでないと確かめられないrunは、Fullとして扱う。`status`と`conclusion`は最後のattempt（`attempt`）のものである/,
  );
  assert.match(
    shipMasterFull,
    /`headSha`が最新の`origin\/master`と一致するFullが実行中・queued（全jobの再実行中を含む）・成功のいずれかなら、最新のmaster HEADはすでに覆われているのでdispatchしない ?（本節4のとおり`Validate canonical selection`で止まったrunは、Fullとして走っていないので覆っていない）。 ?失敗・cancelled・timed outで終わったrunは覆っていないので、§8\.5の判定と§8\.6の対応に従う/,
  );
  assert.match(
    shipMasterFull,
    /別のheadのFullが実行中・queuedなら、今回はdispatchしない。終わった後に最新の master HEAD で1本だけdispatchする（複数のmergeを1本のFullに合流させる）/,
  );
  // Review P3: who dispatches the coalesced one when the merging party cannot
  // wait (the caller, or the next merging party), and what is reported.
  assert.match(
    shipMasterFull,
    /その1本を出すのは、終わるまで待てる担当ならこの担当、待てない担当（短命のsubagentなど）なら呼び出し元（integratorまたは依頼したユーザー）である。 ?待てない場合は、完了報告に「masterのFullが実行中のため未dispatch。終了後に最新のmaster HEADで1本のdispatchが必要」と書いて引き継ぎ、dispatch済みとは報告しない/,
  );
  assert.match(
    shipMasterFull,
    /引き継ぎの前に次のmergeがあれば、その担当が本節の手順で最新のmaster HEADに対する1本をdispatchする。 ?引き継いだ呼び出し元も、dispatchの前にこの項で最新のmaster HEADが覆われているかを確かめる/,
  );
  assert.match(
    shipMasterFull,
    /実行中のFullがなく、最新のmaster HEADも覆われていなければ、§2\.2のresource-isolation preflightを記録した後、次の固定値でhosted Fullをdispatchする/,
  );
  assert.match(
    shipMasterFull,
    /gh workflow run canonical-ci\.yml --ref master -f profile=full -f candidate_base="\$master_base" -f candidate_head="\$master_head"/,
  );
  assert.match(shipMasterFull, /次のmergeをこのFullの完了まで待たせない/);
  // Review P3: nobody is left to watch a dispatched master Full; the party that
  // can wait does, otherwise the caller gets the run id and starts the red
  // handling.
  assert.match(
    shipMasterFull,
    /次のmergeをこのFullの完了まで待たせない。 ?dispatchしたrunの完了を見届け、赤なら本節6を始めるのは、終わるまで待てる担当ならこの担当、待てない担当（短命のsubagentなど）なら呼び出し元（integratorまたは依頼したユーザー）である。 ?待てない場合は、記録したrun idを完了報告に書いて引き継ぐ/,
  );
  // Review P3: the dispatch can race with another merge. Such a run stops at the
  // workflow's own selection validation; it is neither green nor red and is
  // replaced by a new dispatch, never re-run.
  assert.match(
    shipMasterFull,
    /dispatchしたrunが一覧に現れたら、`gh run list --workflow canonical-ci\.yml --branch master --event workflow_dispatch --limit 5 --json databaseId,headSha,status,createdAt`で ?今回のrunを特定してrun idを記録し、その`headSha`が`master_head`と一致することを確認する。dispatch時点のmasterの先頭が`master_head`と違うrunは、 ?`Validate canonical selection`（`candidate_head`と`GITHUB_SHA`の一致確認）で全part jobが失敗する。このrunは検証で止まっただけで、masterのFullの結果に ?数えない（緑でも赤でもない）。全jobを再実行しても同じ入力で同じく失敗するので再実行せず、`git fetch origin master`で`master_head`を取り直して ?dispatchし直す/,
  );
  assert.match(
    shipMasterFull,
    /全part jobと`full-aggregate`が成功したrunだけをcompleteなFull receiptとする。失敗したrunは失敗jobだけでなく全jobを再実行する。 ?ただし、失敗が`Validate canonical selection`のstepだけのrun（本節3）は、masterのFullの失敗に数えず再実行もしない（`gh run view <run-id> --json jobs`で失敗したstepを確かめる）。 ?ローカルのFullは証跡にならない/,
  );
  // The skill names the workflow's own validation step; keep the two bound.
  const canonicalWorkflow = await read(".github/workflows/canonical-ci.yml");
  assert.match(
    canonicalWorkflow,
    /- name: Validate canonical selection\n[\s\S]*?\[\[ "\$EXPECTED_HEAD" == "\$GITHUB_SHA" \]\]/,
    "the master Full procedure relies on the dispatch's EXPECTED_HEAD == GITHUB_SHA validation step",
  );
  // The skill also says the hosted canonical job checks ancestry itself while
  // the local Quick does not; keep that statement bound to the workflow.
  assert.match(
    canonicalWorkflow,
    /git merge-base --is-ancestor "\$candidate_base" "\$candidate_head"/,
    "the hosted canonical job verifies ancestry, as ship-branch states",
  );
  // Review P2: red is judged per attempt, not by the latest completed run. A
  // re-run of all jobs bumps the run's attempt and leaves `conclusion` empty
  // until it ends, so a "completed Full" test would see the previous green Full
  // for the hours the re-run takes and let other merges through (fail-open).
  // Sections 6, 8.2 and the stop condition cite these item numbers, so the
  // numbering is pinned: 5 is the judgement and 6 the handling.
  assert.match(
    shipMasterFull,
    /ローカルのFullは証跡にならない。 ?5\. master のFullが赤かどうかは、runの結論ではなくattemptの結論で判定する。全jobを再実行するとrunの`attempt`が増え、再実行が終わるまで一覧の`conclusion`は空になる。 ?再実行中のrunを「完了していない」として飛ばすと、赤のrunを見落としてmergeが通ってしまう/,
  );
  assert.match(
    shipMasterFull,
    /§8\.2の一覧のFull（本節4のとおり、`Validate canonical selection`のstepだけで失敗したrunは除く）を`createdAt`の新しい順に見て、 ?結論の出たattemptを持つ最初のrunの、最後に結論が出たattemptの結論で判定する/,
  );
  assert.match(
    shipMasterFull,
    /`status`が完了のrunは、一覧の`conclusion`が最後のattemptの結論である。`attempt`が2以上で`status`が実行中・queuedのrun（全jobを再実行中）は、 ?一覧の`conclusion`が空なので、直前のattemptの結論を`gh run view <run-id> --attempt <直前のattempt番号> --json attempt,status,conclusion` ?（`gh api repos\/\{owner\}\/\{repo\}\/actions\/runs\/<run-id>\/attempts\/<直前のattempt番号>`でもよい）で確かめて判定する/,
  );
  assert.match(
    shipMasterFull,
    /`attempt`が1で実行中・queuedのrunは、結論の出たattemptがないので飛ばして、次に新しいrunを見る/,
  );
  assert.match(
    shipMasterFull,
    /判定がsuccess以外（失敗・cancelled・timed outなど）なら赤である。全jobを再実行している間も赤のままで、再実行中であることを赤でない根拠にしない/,
  );
  assert.match(
    shipMasterFull,
    /赤が解けるのは、次のどちらかのときだけである。上の判定がcompleteな成功（全part jobと`full-aggregate`が成功）に変わったとき ?（そのrunの再実行の成功も、より新しいmasterのFullの成功も含む）。または、原因の修正かrevertが`origin\/master`に入ったとき/,
  );
  assert.match(
    shipMasterFull,
    /例外は、無関係なflakeと確かめ、そのrun idと根拠を、mergeする担当が確認できる場所に記録した赤である。全jobを再実行している間は、他のPRのmergeを止めない。 ?記録を確認できない赤は、flakeとして扱わない。再実行が失敗で終わったら例外は終わり、通常の赤として扱う/,
  );
  assert.match(
    shipMasterFull,
    /通常の赤として扱う。 ?6\. master のFullが赤になったら、他の作業より優先して対応する。次のmergeの前に、全jobの再実行で再現するか、どのmergeが持ち込んだかを切り分け、 ?修正またはrevertを他のPRより先にmergeする。その修正またはrevertのmergeが済むまで、それ以外のPRはmergeしない（§6）。 ?無関係なflakeと確かめたものは、記録して全jobを再実行する（本節5の例外）/,
  );
  // Review P3: a party that only has merge authority stops and reports; whether
  // to revert another lane's PR is the caller's decision.
  assert.match(
    shipMasterFull,
    /赤を見つけた担当が、その修正またはrevertを担当する指示を受けていない場合（merge権限しか持たない担当など）は、mergeを止めて呼び出し元へ報告する。 ?他のレーンのPRをrevertするかどうかは、呼び出し元が判断する/,
  );
  assert.doesNotMatch(
    shipMasterFull,
    /最新の完了した/,
    "master red is not judged by the latest completed run",
  );
  assert.doesNotMatch(
    shipMasterFull,
    /pnpm ci:local:full/,
    "the master Full is a hosted dispatch, never a local Full",
  );
  const shipStops = normalizeSection(sectionFromHeading(ship, "## 停止条件"));
  assert.match(
    shipStops,
    /master の Full が未解決の赤（判定は§8\.5）: その修正またはrevertだけを先にmergeし、それ以外のPRはmergeせず停止する（§8\.6）/,
  );
  assert.match(
    normalizeSection(sectionFromHeading(ship, "## 完了報告")),
    /Quick／Full receiptの結果（通常のPRはQuickと同じheadのPR checks、release PRはFull）.*master Fullの扱い（dispatchしたrunのidとその見届け先、実行中のため未dispatchとその引き継ぎ先、判定済みの赤とその対応）/,
  );
  assert.match(
    ship,
    /\[GDX-TRACE-001\]\(\.\.\/\.\.\/\.\.\/policies\/quality\/iron-laws\.md#GDX-TRACE-001\)/,
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
    "add-electron-command",
    "bump-version",
    "debug-issue",
    "explore-codebase",
    "implement-feature",
    "polish-motion",
    "review-code",
    "ship-branch",
    "test-feature",
    "update-licenses",
  ]) {
    const adapter = `.claude/skills/${skill}/SKILL.md`;
    assert.ok(
      trace.implementedBy.includes(adapter),
      `${adapter} must preserve traceability`,
    );
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
  assert.match(executionPlan, /基点:\s*master@9f6aba5f/);
  assert.match(
    executionPlan,
    /Tree:\s*b7f97fc7dbbb5243da090b41dbc884ecfdc0ec2b/,
  );
  assert.match(
    executionPlan,
    /2026-09-17現在.*#596\/\#597 foundations.*#598 A3 review remediation.*masterにある.*Graph.*Packing.*AI dispatch.*未activate.*B.*capacity-remediation-in-progress.*proposal\/5.*確認済み/is,
  );
  assert.match(
    executionPlan,
    /Graph.*Packing.*未activate.*downstream threat model.*draft/is,
  );
  assert.match(executionPlan, /NIR-1全体.*未完了/);
  const a2Heavy = qualityManifest.heavyEvaluations.find(
    (evaluation) =>
      evaluation.id === "heavy-nir1-entity-relation-product-journey",
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
    "nir1-defensive-resource-limits",
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
  // K1 (2026-10-12): the Graph row moved from proposal/5 to proposal/6, and
  // proposal/6 added the common resource rule as a seventh row.
  const graphHistoryRef = "nir1-l6-l9-contract-proposal/5";
  const proposal6Ref = "nir1-l6-l9-contract-proposal/6";
  const proposal6ContractIds = [
    "graph-limited-binding",
    "nir1-defensive-resource-limits",
  ];
  const confirmedContractIds = [
    "scope-storage-authority",
    "caller-profile-egress",
    "typed-revision-material",
    "graph-limited-binding",
    "nir1-defensive-resource-limits",
    "native-generation-receipt",
    "history-reauthorization",
  ];
  const confirmedRefFor = (contractId) =>
    `${contractId === "typed-revision-material" ? typedDraftRef : proposal6ContractIds.includes(contractId) ? proposal6Ref : proposal3Ref}#${contractId}`;
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
      if (proposal6ContractIds.includes(contractId)) {
        assert.equal(draftRef, proposal6Ref);
        // Each proposal/6 row carries its own verbatim statement, the
        // confirmation date and the digest of the byte-identical draft.
        const statement =
          contractId === "graph-limited-binding"
            ? PROPOSAL6_GRAPH_STATEMENT
            : PROPOSAL6_RULE_STATEMENT;
        for (const evidence of [
          `\`confirmedRef=${confirmedRefFor(contractId)}\``,
          `exact statement: \`${statement}\``,
          "confirmed 2026-10-12 (Session A, received 23:58 JST)",
          `draft \`${PROPOSAL6_DRAFT_PATH}\` at commit \`${PROPOSAL6_DRAFT_COMMIT}\`, SHA-256 \`${PROPOSAL6_DRAFT_SHA256}\``,
          "this independently ratifies only this row",
        ]) {
          assert.ok(
            cells[8].includes(evidence),
            `${contractId} unblockingEvidence must record ${evidence}`,
          );
        }
        assert.match(
          cells[4],
          /^none — proposal\/6 is explicitly confirmed;.*product activation is not ratified$/,
        );
      }
      if (contractId === "graph-limited-binding") {
        assert.match(
          cells[3],
          /^proposal\/6 confirmed scope: proposal\/5の資源の値と受入れだけを改訂し、proposal\/5のその他の条項（三つのresource unit、whole-project build lifecycle、measurement／acceptance split、finalized P2 boundaries）とproposal\/3のGraph binding／query protectionsを保持する。/,
        );
        for (const fixedValue of [
          "Revision `512 records`／`6,291,456 B`",
          "C-query per-Revision preflight `2,097,152 B`",
          "read／admission `512`",
          "batch `16x32`",
          "SQL `100,000 VM steps`",
          "parent admission→valid Native result lease `100 ms`",
          "reader／busy wait `0`",
          "2hop／12／144／8",
        ]) {
          assert.ok(
            cells[3].includes(fixedValue),
            `graph-limited-binding confirmedScope must record ${fixedValue}`,
          );
        }
        assert.match(
          cells[3],
          /query全体の物理メモリ上限とその証明、Native fixed-area packing、B容量の再認定は求めない/,
        );
        assert.doesNotMatch(cells[3], /`8ms`|Graph `100ms`/);
        assert.match(
          cells[4],
          /B full-set numbers ratified on 2026-09-22 stay unchanged.*implementation defensive limits stay at their current values and relaxing them requires reconfirmation/,
        );
        assert.equal(cells[5], "B、C");
        assert.equal(cells[6], "b-close-complete");
        assert.match(
          cells[7],
          /exact confirmation is recorded.*B implementation and required focused evidence are complete.*C-resource acceptance remains HOLD until CR-REC binds the CQ-1〜3 evidence and independent acceptance.*C remains gated.*product activation/,
        );
        assert.ok(
          cells[8].includes("the proposal/5 record above is history"),
          "the proposal/5 confirmation must stay recorded as history",
        );
        assert.doesNotMatch(
          cells[8],
          /contract-proposal\/5 for contractId|confirmedRef=nir1-l6-l9-contract-proposal\/5/,
          "the current Graph row must not cite proposal/5 as its confirmation",
        );
      } else if (contractId === "nir1-defensive-resource-limits") {
        assert.match(
          cells[3],
          /^proposal\/6 scope only: NIR-1の残レーンで今後追加する資源の上限（どれだけ読む・待つ・保持するか）に共通の規則1〜8/,
        );
        assert.match(
          cells[3],
          /何を読む・保存する・送るか（authority、保存範囲、送信先、同意、開示）は決めない/,
          "the common rule must not decide authority, storage scope or recipients",
        );
        assert.match(
          cells[4],
          /existing fixed values \(P, Gold, the `graph-limited-binding` fixed values, Packing `2 MiB`, B-close numbers\) are outside this rule and still need individual confirmation to change/,
        );
        assert.equal(
          cells[5],
          "C-body、C-product、H-store／H-current、D-transport",
        );
        assert.equal(cells[6], "rule-effective");
        assert.match(
          cells[7],
          /each affected lane remains gated by its own contracts \(K2〜K5 are not confirmed\).*each new limit needs boundary tests and a recorded value／measurement in the PR body and the work record/,
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
        !proposal6ContractIds.includes(contractId)
      ) {
        assert.match(cells[7], /explicit user confirmation recorded/);
      }
      assert.match(
        cells[8],
        new RegExp(escapeRegExp(confirmedRefFor(contractId))),
      );
    } else {
      assert.fail(`${contractId} should be explicitly confirmed`);
    }
    return row;
  });
  assert.equal(ledgerRows.length, 7);
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
  assert.equal(
    ledgerRows.filter((row) => row.includes("| rule-effective |")).length,
    1,
    "only the common resource rule is effective as a rule without a lane of its own",
  );
  // The proposal/5 confirmation stays in the ledger narrative as history.
  for (const historyRecord of [
    `\`confirmedRef=${graphHistoryRef}#graph-limited-binding\``,
    "exact statement: `I confirm draftRef nir1-l6-l9-contract-proposal/5 for contractId graph-limited-binding.`",
    "は履歴としてここに残す",
  ]) {
    assert.ok(
      ledgerSection.includes(historyRecord),
      `the ledger must keep the proposal/5 record as history: ${historyRecord}`,
    );
  }
  assert.match(
    ledgerSection,
    /^2026-10-12補足（K1、proposal\/6）: `graph-limited-binding` の行を、proposal\/5からproposal\/6へ更新し、`nir1-defensive-resource-limits` の行を加えた。どちらも2026-10-12（JST 23:58受信、Session A）に、contractIdごとのユーザーのexact statementで確認された。/m,
  );
  assert.ok(
    ledgerSection.includes(
      `byte同一で取り込んだ [proposal/6 draft](nir1-l6-l9-contract-proposal-6-draft.md) のSHA-256は \`${PROPOSAL6_DRAFT_SHA256}\``,
    ),
    "the ledger must bind the byte-identical proposal/6 draft digest",
  );
  assert.match(
    ledgerSection,
    /`nir1-l6-l9-contract-proposal\/6` の `graph-limited-binding` row（proposal\/5の資源の値と受入れの改訂）と、新しい `nir1-defensive-resource-limits` rowも、ユーザーのexact statementにより `draftRef#contractId` の形式で明示確認済みとして記録する。proposal\/6の確認は固定値、削除する要件、今後の上限に共通の規則を契約化するが、Graphの製品公開、local送信、新しいauthority・保存先・送信先を許可しない。/,
  );
  // The confirmed draft is imported byte-identically; its "Status: draft"
  // line stays and the ledger, not the draft, carries the confirmation.
  const proposal6Draft = await readFile(
    path.join(repoRoot, PROPOSAL6_DRAFT_PATH),
  );
  assert.equal(
    createHash("sha256").update(proposal6Draft).digest("hex"),
    PROPOSAL6_DRAFT_SHA256,
    "the confirmed proposal/6 draft must stay byte-identical",
  );
  const proposal6DraftText = proposal6Draft.toString("utf8");
  assert.match(
    proposal6DraftText,
    /^Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない$/m,
  );
  for (const statement of [
    PROPOSAL6_GRAPH_STATEMENT,
    PROPOSAL6_RULE_STATEMENT,
  ]) {
    assert.match(
      proposal6DraftText,
      new RegExp(`^- ${escapeRegExp(statement)}$`, "m"),
      `the confirmed draft must carry the statement: ${statement}`,
    );
  }
  await assertLocalMarkdownLink(
    "docs/plans/nir1-l6-l9-execution-plan.md",
    PROPOSAL6_DRAFT_PATH,
  );
  assert.match(
    executionPlan,
    /R0でmerge済みのproposal\/3五つ.*PR #579.*Option B.*明示批准済み.*契約として有効/is,
  );
  assert.match(
    executionPlan,
    /明示確認済み・契約として有効.*第六行.*A2はA1＋D2a/is,
  );
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
    /The proposal\/6 resource delta and the new common resource rule were each confirmed on 2026-10-12 by a separate exact statement, recorded here: `I confirm draftRef nir1-l6-l9-contract-proposal\/6 for contractId graph-limited-binding\.` and `I confirm draftRef nir1-l6-l9-contract-proposal\/6 for contractId nir1-defensive-resource-limits\.`/,
    /The first confirms only the proposal\/6 resource values, removals and acceptance changes while preserving the other proposal\/5 clauses and the proposal\/3 Graph protections; the proposal\/5 statement above is kept as history/,
    /The second confirms only the common rule for limits that the remaining lanes add later and changes no existing fixed value/,
    /Both bind the byte-identical draft `docs\/plans\/nir1-l6-l9-contract-proposal-6-draft\.md` with SHA-256 `5528f4e091ca087c0f1e071039c6bcede9d3d7cde1422ac1bfd852ee1d8d6b4b`; neither activates Graph or local send, nor adds an authority, a storage scope or a recipient/,
    /confirmation is limited to the Entity／Relation-only family.*never widens to a generic consumer／authority/is,
  ]) {
    assert.match(proposalSection, confirmationRule);
  }
  assert.match(
    proposalSection,
    /I confirm draftRef nir1-l6-l9-contract-proposal\/4 for contractId typed-revision-material\./,
  );
  for (const statement of [
    "I confirm draftRef nir1-l6-l9-contract-proposal/5 for contractId graph-limited-binding.",
    PROPOSAL6_GRAPH_STATEMENT,
    PROPOSAL6_RULE_STATEMENT,
  ]) {
    assert.ok(
      proposalSection.includes(statement),
      `the R0 proposal must keep the verbatim statement: ${statement}`,
    );
  }
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
    assert.notEqual(
      headingOffset,
      -1,
      `${contractId} proposal must be present`,
    );
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
            acceptanceField ===
            "Lane unlocked only after exact proposal/5 confirmation"
              ? ""
              : ":"
          }`,
          "i",
        ),
        `${contractId} must define ${acceptanceField}`,
      );
    }
    if (contractId === "graph-limited-binding") {
      // K1 (2026-10-12): this plain section is the proposal/5 text restored
      // to its confirmed `13e3f6c6^` wording. Its bounds are history; the
      // current fixed values live in the proposal/6 section validated below.
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
        if (graphSection !== "In-scope attacks") {
          assert.match(
            sectionBody,
            /`2 MiB`/,
            `proposal/5 history ${graphSection} must keep the confirmed query \`2 MiB\``,
          );
        }
      }
      assert.doesNotMatch(
        proposal,
        /6 MiB|6,291,456|100\s?ms|aggregate physical-memory/,
        "the proposal/5 history must not carry #610's unconfirmed rewrite",
      );
      assert.match(proposal, /Threshold changes require reconfirmation/);
      validateGraphProposalContract(executionPlan);
      validateProposal6Contract(executionPlan);
      const mutateBoundedGraphProposal = (mutator) =>
        mutateExecutionPlanSection(
          executionPlan,
          "#### graph-limited-binding",
          mutator,
        );
      const graphMutationCases = [
        {
          label: "numeric supported capacity",
          expected:
            "Graph proposal must not ratify a numeric whole-project build cap or deadline",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "\n##### Proposal/5 acceptance split (confirmed contract)",
              "\nsupported capacity = 2048 records\n##### Proposal/5 acceptance split (confirmed contract)",
            ),
        },
        {
          label: "numeric whole-project deadline",
          expected:
            "Graph proposal must not ratify a numeric whole-project build cap or deadline",
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
            boundedProposal.replace(
              "persistent stagingは作らない",
              "persistent stagingを作る",
            ),
        },
        {
          label: "persistent adjacency",
          expected:
            "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "persistent adjacencyは追加しない",
              "persistent adjacencyを追加する",
            ),
        },
        {
          label: "new authority",
          expected:
            "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "新しいauthority、schema、consumer、persistent adjacencyは追加しない",
              "新しいauthorityを追加する",
            ),
        },
        {
          label: "new schema",
          expected:
            "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "新しいauthority、schema、consumer、persistent adjacencyは追加しない",
              "新しいschemaを追加する",
            ),
        },
        {
          label: "new consumer",
          expected:
            "Graph proposal must not add persistent adjacency, authority, schema, or consumer",
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
          expected:
            "Source re-resolution must reject unowned or unbounded scanning",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "Source re-resolution: maintenance entryのowner／caller connection／read transaction／progress hookでcurrent Sourceを再解決し、unowned／unbounded full-roster scanを開始しない",
              "Source re-resolution: maintenance entryのowner／caller connection／read transaction／progress hookでcurrent Sourceを再解決し、unowned／unbounded full-roster scanを開始する",
            ),
        },
        {
          label: "unowned coverage full scan",
          expected:
            "complete registration/coverage verification must reject unowned or unbounded scanning",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "complete registration/coverage verification (`is_complete_registered`): 同じowned validation attemptで全件registration／coverageを検証し、unowned／unbounded full-roster scanを開始しない",
              "complete registration/coverage verification (`is_complete_registered`): 同じowned validation attemptで全件registration／coverageを検証し、unowned／unbounded full-roster scanを開始する",
            ),
        },
        {
          label: "unowned reopen full scan",
          expected:
            "restore/cold reopen verification must reject unowned or unbounded scanning",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "restore/cold reopen verification: 同じowned validation attemptでsealed generation、Source、D1、complete rosterを再検証し、unowned／unbounded full-roster scanを開始しない",
              "restore/cold reopen verification: 同じowned validation attemptでsealed generation、Source、D1、complete rosterを再検証し、unowned／unbounded full-roster scanを開始する",
            ),
        },
        {
          label: "query synchronous full scan",
          expected:
            "query-triggered validation must be deferred to an owned maintenance entry",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "queryはvalidation read transactionへsynchronously入らない",
              "queryはvalidation read transactionへsynchronously入る",
            ),
        },
        {
          label: "optional whole-build peak",
          expected:
            "full build and maintenance memory accounting must cover every major retained structure",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "mandatory end-to-end peak memory for the full build-through-publish interval",
              "optional end-to-end peak memory for the full build-through-publish interval",
            ),
        },
        {
          label: "roster-only peak",
          expected:
            "full build and maintenance memory accounting must cover every major retained structure",
          mutate: (boundedProposal) =>
            boundedProposal.replace(
              "roster bytesとRevision-ID overheadはcomponents onlyとして別に報告する",
              "roster bytes only are reported",
            ),
        },
        {
          label: "missing major structure accounting",
          expected:
            "full build and maintenance memory accounting must cover every major retained structure",
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
          () =>
            validateGraphProposalContract(mutateBoundedGraphProposal(mutate)),
          (error) => {
            assert.match(error.message, new RegExp(escapeRegExp(expected)));
            return true;
          },
          `${label} mutation must be rejected by the bounded Graph validator`,
        );
      }
      // The restored proposal/5 history must not drift back to #610's
      // unconfirmed wording.
      for (const { label, expected, mutate } of [
        {
          label: "unconfirmed 6 MiB in the proposal/5 Revision row",
          expected:
            "the historical Revision row keeps the confirmed proposal/5 wording",
          mutate: (l7) =>
            l7.replace(
              "object／edge／revision／evidence合計 `512 records`、`2 MiB`。",
              "object／edge／revision／evidence合計 `512 records`、`2 MiB`（#610後は `6 MiB`）。",
            ),
        },
        {
          label: "unconfirmed 100ms in the proposal/5 query row",
          expected:
            "the historical query row keeps the confirmed proposal/5 wording",
          mutate: (l7) =>
            l7.replace(
              "`2 MiB`、Graph `8ms`、reader／busy wait `0`。不適格行も",
              "`2 MiB`、Graph `8ms`、Graph `100ms`、reader／busy wait `0`。不適格行も",
            ),
        },
      ]) {
        const start = executionPlan.indexOf(
          "## L7: Entity/Relation入力とGraph\n",
        );
        const end = executionPlan.indexOf("\n## L8:", start);
        assert.ok(start >= 0 && end > start, `${label}: L7 must be bounded`);
        const l7 = executionPlan.slice(start, end);
        const mutatedL7 = mutate(l7);
        assert.notEqual(mutatedL7, l7, `${label} mutation must change L7`);
        assert.throws(
          () =>
            validateGraphProposalContract(
              `${executionPlan.slice(0, start)}${mutatedL7}${executionPlan.slice(end)}`,
            ),
          (error) => {
            assert.match(error.message, new RegExp(escapeRegExp(expected)));
            return true;
          },
          `${label} mutation must be rejected by the bounded Graph validator`,
        );
      }
      // proposal/6: the confirmed fixed values, defensive limits and common
      // rule must keep their bounds in every section, and any change or
      // relaxation must stay behind a reconfirmation.
      const proposal6MutationCases = [
        {
          label: "relaxed proposal/6 Revision bound",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 Revision bundle must stay at 512 records / 6,291,456 B",
          mutate: (section) =>
            section.replace(
              "proposal/5と同じ数え方で `512 records`、`6,291,456 B` |",
              "proposal/5と同じ数え方で `512 records`、`8,388,608 B` |",
            ),
        },
        {
          label: "relaxed proposal/6 per-Revision preflight",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 per-Revision preflight must stay at 2,097,152 B",
          mutate: (section) =>
            section.replace(
              "bytesの合計が `2,097,152 B` 以下。JSONの解析より前に検査する",
              "bytesの合計が `6,291,456 B` 以下。JSONの解析より前に検査する",
            ),
        },
        {
          label: "relaxed proposal/6 result lease",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 seed-local query row must keep parent admission→valid Native result lease `100 ms`",
          mutate: (section) =>
            section.replace(
              "parent admission→valid Native result lease `100 ms`（registration",
              "parent admission→valid Native result lease `250 ms`（registration",
            ),
        },
        {
          label: "aggregate physical-memory proof required again",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 seed-local query row must keep query全体の物理メモリ上限とその証明は求めない",
          mutate: (section) =>
            section.replace(
              "Scene 8。query全体の物理メモリ上限とその証明は求めない |",
              "Scene 8。query全体の物理メモリ上限 `6,291,456 B` を証明する |",
            ),
        },
        {
          label: "preflight bound dropped from the attacks",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 Graph In-scope attacks must preserve `2,097,152 B`",
          mutate: (section) =>
            section.replace(
              "per-Revision preflight `2,097,152 B`、read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、cancellation every `1,000` steps、result lease `100 ms`、reader／busy wait `0`、2hop／12／144／8（whole-project B buildはB-closeの数値）",
              "read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、cancellation every `1,000` steps、result lease `100 ms`、reader／busy wait `0`、2hop／12／144／8（whole-project B buildはB-closeの数値）",
            ),
        },
        {
          label: "retired 8ms restored in the acceptance",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 Graph Acceptance implications must not restore the retired `8ms` query bound",
          mutate: (section) =>
            section.replace(
              "parent admissionから `100 ms` の内にvalidなresult leaseを返し",
              "parent admissionから `100 ms` の内にvalidなresult leaseを返し、Graph `8ms` の内に完了し",
            ),
        },
        {
          label: "fixed values adjusted without reconfirmation",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 fixed values must require reconfirmation in either direction",
          mutate: (section) =>
            section.replace(
              "固定値の変更は、方向を問わず再確認を要する。",
              "固定値は実測に合わせて調整してよい。",
            ),
        },
        {
          label: "threshold reconfirmation dropped from the defenses",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected: "proposal/6 threshold changes must require reconfirmation",
          mutate: (section) =>
            section.replace(
              "固定値の変更（方向を問わない）と実装上の防御上限の緩和は、再確認なしに行わない。",
              "固定値の変更と実装上の防御上限の緩和は、integratorが判断する。",
            ),
        },
        {
          label: "relaxed implementation request limit",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "proposal/6 implementation defensive limit must keep C-queryのrequest at | `8,192 B` |",
          mutate: (section) =>
            section.replace(
              "| C-queryのrequest | `8,192 B` |",
              "| C-queryのrequest | `65,536 B` |",
            ),
        },
        {
          label: "defensive limits relaxed without reconfirmation",
          heading: PROPOSAL6_GRAPH_HEADING,
          expected:
            "relaxing an implementation defensive limit must require reconfirmation",
          mutate: (section) =>
            section.replace(
              "上限を外す）は再確認を要する。厳しくする変更と",
              "上限を外す）はintegratorが判断する。厳しくする変更と",
            ),
        },
        {
          label: "common rule relaxed without user reconfirmation",
          heading: PROPOSAL6_RULE_HEADING,
          expected: "nir1-defensive-resource-limits rule 7 must stay recorded",
          mutate: (section) =>
            section.replace(
              "理由、実測を示してユーザーの再確認を得る。",
              "理由、実測を作業記録に残す。",
            ),
        },
        {
          label: "common rule widened to authority and recipients",
          heading: PROPOSAL6_RULE_HEADING,
          expected:
            "nir1-defensive-resource-limits must not decide authority, storage scope or recipients",
          mutate: (section) =>
            section.replace(
              "（authority、保存範囲、送信先、同意、開示）は決めない。それらは各契約で確認する。",
              "（authority、保存範囲、送信先、同意、開示）もintegratorが決める。",
            ),
        },
        {
          label: "existing fixed value brought under the common rule",
          heading: PROPOSAL6_RULE_HEADING,
          expected:
            "nir1-defensive-resource-limits must exclude Packingの `2 MiB`",
          mutate: (section) =>
            section.replace(
              "、Packingの `2 MiB`、B-closeの数値。",
              "、B-closeの数値。",
            ),
        },
      ];
      for (const {
        label,
        heading,
        expected,
        mutate,
      } of proposal6MutationCases) {
        assert.throws(
          () =>
            validateProposal6Contract(
              mutateExecutionPlanSection(executionPlan, heading, mutate),
            ),
          (error) => {
            assert.match(error.message, new RegExp(escapeRegExp(expected)));
            return true;
          },
          `${label} mutation must be rejected by the proposal/6 validator`,
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
      assert.ok(
        acceptanceStart > lifecycleStart,
        "graph acceptance split must follow lifecycle",
      );
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
      const acceptanceRows =
        acceptanceStart >= 0 ? proposal.slice(acceptanceStart).split("\n") : [];
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
      assert.match(
        reopenRow,
        /完成したsealed generationだけ.*incomplete build state.*persisted restart state/,
      );
      const atomicRow = acceptanceRow("atomic visibility");
      assert.match(
        atomicRow,
        /旧sealed generationまたは全件qualified.*partial／mixed generation/,
      );
      assert.doesNotMatch(
        proposal,
        />512` valid candidates across multiple revisions/,
        "graph acceptance must use qualified material records rather than ambiguous candidates",
      );
      for (const [pattern, label] of [
        [/三つのresource unit/, "three resource units"],
        // proposal/5 history values (`13e3f6c6^`); proposal/6 replaces them.
        [
          /512 records.*2 MiB.*validation contract/,
          "historical Revision bundle validation limits",
        ],
        [
          /read／admission `512`.*batch `16x32`.*SQL `100,000 VM steps`.*`2 MiB`.*Graph `8ms`.*reader／busy wait `0`/,
          "historical seed-local query limits",
        ],
        [
          /whole-project B Index build.*現在の全候補.*qualified material.*atomic publish/,
          "whole-project build scope",
        ],
        [
          /queryの合計値はbuildのcandidate count、compact roster count、cumulative bytes、cumulative SQLをcapしない/,
          "query totals must not cap build totals",
        ],
        [
          /small／keyset pages.*一度に一つのA2 Revision/,
          "paged one-revision-at-a-time build",
        ],
        [
          /allocation前にsizeを検査.*JSON／material processing中にもcancellation/,
          "pre-allocation and material cancellation guards",
        ],
        [
          /publish直前にexact complete roster、Source、D1を再検証.*partial generationを残さず/,
          "publish barrier and no partial generation",
        ],
        [
          /caller-ownedな単一read transaction.*pin/,
          "single caller-owned read transaction",
        ],
        [
          /pinした同一read transaction内.*page間でtransaction／mutexを解放しない/,
          "page statements stay inside the pinned read transaction",
        ],
        [
          /page途中のretryは行わず.*snapshot全体を破棄/,
          "retry restarts from a fresh snapshot",
        ],
        [
          /source／decision／scope drift at barriers.*cancellation recovery.*cold reopen.*atomic visibility.*query independence/is,
          "deterministic semantic gates",
        ],
        [
          /Capacity benchmark metricsは、compact full rosterとpublish-time complete rescanを含めて第1診断stage.*numeric build capacityの批准ではない.*mandatory end-to-end peak memory.*full-set maintenance path/is,
          "measurement precedes build capacity",
        ],
        [
          /roster bytesとRevision-ID overheadはcomponents only.*snapshot roster＋dependency edges.*method／coverage／uncertainty/,
          "capacity benchmark memory accounting",
        ],
        [
          /supported work size／build memory／SQL／deadlineはその結果から後で選ぶ/,
          "supported build values are selected after measurement",
        ],
      ]) {
        assert.match(proposal, pattern, `graph binding must define ${label}`);
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
      assert.ok(
        negativeMatch,
        "history reauthorization needs a negative clause",
      );
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
  assert.match(
    executionPlan,
    /trim、Unicode normalization、renderer加工はせず/,
  );
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
  const implementationOrder = executionPlan.split(
    "## 実装順序と公開条件\n",
    2,
  )[1];
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
  assert.notEqual(
    mermaidStart,
    -1,
    "canonical dependency graph must be present",
  );
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
    'pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"',
    'pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"',
    'gh pr merge --squash --match-head-commit "$candidate_head"',
  ]) {
    assert.match(
      executionPlan,
      new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  // U7 (2026-10-13): merge gate M is the ordinary path (a rebased complete
  // Quick plus the same-head PR checks). Canonical Full runs on master after
  // the merge and stays a merge requirement only for a release PR; the plans
  // refer to GDX-TRACE-001 and /ship-branch instead of restating the commands,
  // and none of them may run a local Full that Full admission refuses.
  const postBPlan = await read("docs/plans/nir1-post-b-execution-plan.md");
  const gateM = normalizeSection(
    executionPlan
      .split("### 全PR共通 merge gate M\n", 2)[1]
      ?.split("\n### PR-P 固定検索性能測定結果", 1)[0] ?? "",
  );
  assert.ok(gateM, "merge gate M must be present");
  assert.match(
    gateM,
    /全PR（R0、途中の機能PR、E、Pを含む）の通常のmergeには、\[GDX-TRACE-001\]\(\.\.\/\.\.\/policies\/quality\/iron-laws\.md#GDX-TRACE-001\)の通常PRの経路を適用する/,
  );
  assert.match(
    gateM,
    /最新 `origin\/master` へrebaseしたcleanなcommit済みcandidate、そのcandidateのcanonical Quickと直後のverify、同じheadの`ci\.yml` checksの成功を要求する/,
  );
  assert.match(
    gateM,
    /canonical Fullは通常のPRのmerge条件ではなく、merge後にmasterのheadでhostedに走らせる（2026-10-13のU7/,
  );
  assert.match(
    gateM,
    /release PRだけが、従来どおりcompleteなhosted Fullと直後のverifyを要求する/,
  );
  assert.match(
    gateM,
    /R0もmerge gate Mの対象であり、merge前にはQuick＋verifyを実行する/,
  );
  assert.match(
    gateM,
    /mergeは`gh pr merge --squash --match-head-commit "\$candidate_head"`で行い、merge直前のbase一致と`approved_merge_base`は通常のPRに要求しない/,
  );
  assert.match(
    gateM,
    /merge後のmasterのFull（dispatch、実行中は1本に合流、赤は次のmergeの前に切り分けて修正かrevertを先にmerge）と、release PRおよびrelease tagのFullは、GDX-TRACE-001と`\/ship-branch`の手順に従う/,
  );
  assert.doesNotMatch(
    gateM,
    /full_base|full_head|profile=full|merge前にはFull＋verifyを実行する|現在のbaseが`full_base`と一致/,
    "merge gate M must not keep the pre-merge Full commands or base-equality rule",
  );
  assert.match(
    normalizeSection(sectionFromHeading(executionPlan, "## 実装時の検証手順")),
    /L9受入れ（E-2）に必要なFull／verifyは、最後のPRのmerge後にmasterのheadで走らせたhostedのcanonical Fullで満たす。ローカルの`pnpm ci:local:full`はFull admissionで拒否される。全part jobと`full-aggregate`が成功したrunだけを証跡とし、dispatchと赤のときの扱いはGDX-TRACE-001と`\/ship-branch`に従う。通常のPRのmerge前に求めるのは上のQuickと同じheadのPR checksで/,
  );
  assert.match(
    normalizeSection(postBPlan),
    /rebase済みのclean candidateでQuick→直後verify、独立受け入れ、同じheadの`ci\.yml` checksの成功を経てmergeする。すべてのPRに既存merge gate Mを適用する。canonical Fullは通常のPRのmerge条件ではなく、merge後にmasterのheadで走らせる。release PRとrelease tagだけが、従来どおりFullを要求する/,
  );
  assert.match(
    normalizeSection(postBPlan),
    /mergeは`gh pr merge --squash --match-head-commit "\$candidate_head"`で行い、merge直前のbase一致と`approved_merge_base`は通常のPRに要求しない/,
  );
  assert.match(
    normalizeSection(postBPlan),
    /最終候補のFull\/verifyは、最後のPRのmerge後にmasterのheadで走らせるhostedのcanonical Fullの成功で満たす/,
  );
  const integrationGate = normalizeSection(
    sectionFromHeading(
      integrationPlan,
      "## 8. 独立受入れ・候補管理・Quick / Full / verify",
    ),
  );
  assert.match(
    integrationGate,
    /最終NIR-1受入れのFull\/verifyは、最後のPRのmerge後にmasterのheadで走らせたhostedのcanonical Fullで確認する/,
  );
  assert.match(
    integrationGate,
    /通常のPRのmerge前に求めるのは、上のQuickと直後verify、同じheadの`ci\.yml` checksの成功で/,
  );
  assert.match(
    integrationGate,
    /release PRのmerge前と、release tagが別途承認された場合のmerge後release commit自身には、従来どおりcompleteなhosted Full\/verifyを要求する/,
  );
  for (const [name, plan] of [
    ["execution plan", executionPlan],
    ["post-B plan", postBPlan],
    ["integration plan", integrationPlan],
  ]) {
    assert.doesNotMatch(
      plan,
      /^\s*pnpm ci:local:full -- --base "\$full_base" --head "\$full_head"\s*$/m,
      `${name} must not run a local Full that Full admission refuses`,
    );
    assert.doesNotMatch(
      plan,
      /full_base="\$\(git rev-parse|candidate_base="\$full_base"|merge直前に ?`git fetch origin master` でbaseが`full_base`と一致/,
      `${name} must not keep the pre-merge Full dispatch for ordinary PRs`,
    );
  }
  for (const planPath of [
    "docs/plans/nir1-l6-l9-execution-plan.md",
    "docs/plans/nir1-post-b-execution-plan.md",
    "docs/plans/narrative-ir-nir1-implementation-plan.md",
    "docs/plans/nir1-continuation-2026-10.md",
  ]) {
    await assertLocalMarkdownLink(
      planPath,
      "policies/quality/iron-laws.md",
      "GDX-TRACE-001",
    );
  }
  assert.match(
    executionPlan,
    /\| post-#608の残HOLD \| 閉じる実装スライス・受入れ境界 \| 状態（2026-10-12） \|/,
    "the remaining HOLD table must carry its current status",
  );
  for (const holdRow of [
    "D2a activation",
    "A3 consumer activation",
    "AttemptBinding v2",
    "D-final追補",
    "DI-1（3分割）",
    "P-12の最終request baseline",
  ]) {
    assert.match(
      executionPlan,
      new RegExp(`^\\| ${escapeRegExp(holdRow)} \\|[^\\n]*\\| HOLD`, "m"),
      `${holdRow} must be tracked as an open HOLD`,
    );
  }
  // #610's dated revisions stay as history; K1 records that proposal/6
  // formalized them through the confirmation ledger.
  for (const historyNote of [
    /^2026-10-01 #610数値契約の明示改訂（当時の履歴）: /m,
    /^2026-10-02 #610期限の明示改訂（当時の履歴）: /m,
    /^2026-10-04 post-B current contract: /m,
  ]) {
    assert.match(executionPlan, historyNote);
  }
  assert.match(
    executionPlan,
    /^2026-10-12 K1追記（上の2026-10-01／10-02／10-04の改訂は当時の履歴としてそのまま残す）: [^\n]*`nir1-l6-l9-contract-proposal\/6` の `graph-limited-binding` と `nir1-defensive-resource-limits` が確認され[^\n]*次がproposal\/6で正式化された。単一Revision validationの `512 records`／`6,291,456 B`[^\n]*parent admission→valid Native result leaseの `100 ms`[^\n]*query全体の物理メモリ上限とその証明[^\n]*の削除/m,
    "the K1 note must record what proposal/6 formalized from #610's revisions",
  );
  assert.match(
    executionPlan,
    /^2026-10-12追記（K1）: NIR-1の残レーン（C-body、C-product、H-store／H-current、D-transport）で今後追加する資源の上限は、確認済みの `nir1-l6-l9-contract-proposal\/6#nir1-defensive-resource-limits` の規則1〜8に適合し、値と実測をPR本文と作業記録に残せば、上限ごとの確認なしにmergeできる。merge後に緩める変更、既存の確定値[^\n]*の変更[^\n]*には、引き続き上の確認を要する。$/m,
    "the reconfirmation conditions must carry the confirmed common resource rule",
  );
  // K1 bookkeeping outside the ledger: the B-close note, and the retirement
  // of the never-ratified `graph-query-memory-accounting/1`.
  const bClose = await read("docs/plans/nir1-b-close-completion-2026-09-22.md");
  assert.match(
    bClose,
    /K1（`nir1-l6-l9-contract-proposal\/6`）で確認済み（2026-10-12）/,
  );
  assert.doesNotMatch(bClose, /K1[^\n]*で確認する予定/);
  assert.match(
    bClose,
    /^> \*\*2026-10-12 注記（K1。上の段落は確認時のまま）:\*\* 上の「Revision limit \(512 records \/ 2 MiB\)」[^\n]*`512 records`／`6,291,456 B`（6 MiB）に正式化され/m,
  );
  assert.match(
    bClose,
    /The request-local\nRevision limit \(512 records \/ 2 MiB\) and seed-local query contract are unchanged\./,
    "the B-close text itself stays as confirmed",
  );
  for (const retiredIn of [
    "docs/plans/nir1-c-query-memory-enforcement-v1-draft.md",
    "docs/plans/nir1-c-query-linux-resource-probe-draft.md",
  ]) {
    assert.match(
      await read(retiredIn),
      /^> \*\*2026-10-12 注記（K1[^\n]*`graph-query-memory-accounting\/1`[^\n]*`nir1-l6-l9-contract-proposal\/6#graph-limited-binding` で退役した/m,
      `${retiredIn} must record the retirement of graph-query-memory-accounting/1`,
    );
  }
  // K1 (2026-10-12) resolved the Revision limit. CR-REC (2026-10-13) released
  // the C-resource acceptance HOLD on the CR-1 lane evidence recorded in the
  // acceptance ledger. The release condition is the CR-1 merge and the green
  // final-head Quick, PR checks and lanes; by U7 (2026-10-13) Full is no longer
  // a merge condition and runs on master after the merge. CR-2 (2026-10-14)
  // added the tests for the ledger's unmet items (G-1 to G-4) and released
  // what they close; its release condition is the CR-2 merge and the green
  // final-head PR checks. Two items stay open as separate [precheck] HOLD rows,
  // because the confirmed contract and the implementation disagree (G-1: the B
  // publish near the writer limit; G-2: the positive case on the real worker
  // with its fixed allocator). Scene 8 moves to the CP-1 acceptance. CQ-MEM
  // (2026-10-14) narrowed G-2: the decision and envelope shapes pass N / N+1 on
  // the real worker and run in the lifecycle lane; only the product shape (a
  // Japanese summary held in the payload, the envelope and the live Source)
  // stays an open [precheck].
  assert.match(
    executionPlan,
    /^\| Revision上限の整合 \|[^\n]*\| 解消（K1 確認）。2026-10-12に `nir1-l6-l9-contract-proposal\/6#graph-limited-binding` で `512 records`／`6,291,456 B` を確認し、確認台帳に記録した \|$/m,
    "the Revision limit HOLD must be resolved by the K1 confirmation",
  );
  assert.match(
    executionPlan,
    /^\| C-queryのfunctional\/resource-safety・100 ms lease、SQL・cleanup \|[^\n]*\| 解除済み（CR-REC、2026-10-13）。[^\n]*資源の固定値はK1（proposal\/6）で確認済み[^\n]*\]\(nir1-c-query-acceptance-2026-10\.md\)[^\n]*条件：CR-1（#636）のmergeと最終headのQuick・PR checks・lane 6本のgreen（CR-1 の squash commit：750741183cf4d75ccf18b3904a5751b762284bda）。U7（2026-10-13のユーザー決定）により Full は merge 後の master で走らせる。[^\n]*A-1） \|$/m,
    "the C-resource acceptance HOLD is released by CR-REC under the CR-1 merge and the green final-head Quick, PR checks and lanes",
  );
  assert.match(
    executionPlan,
    /^\| C-resourceの境界試験（台帳§7のG-1〜G-4） \|[^\n]*\| 解除（CR-2、2026-10-14）。[^\n]*\]\(nir1-c-query-acceptance-2026-10\.md\)[^\n]*条件：CR-2のmergeと最終headのPR checksのgreen。[^\n]*残る部分は次の3行のとおり、2点は\[precheck\]でHOLDのまま、Scene 8はCP-1の受入れに移す \|$/m,
    "the tested part of the ledger's unmet C-resource items is released by CR-2 under the CR-2 merge and the green final-head PR checks",
  );
  assert.match(
    executionPlan,
    /^\| C-resourceのBの上限近傍のpublish（台帳§7\.1のG-1） \|[^\n]*\| HOLD（\[precheck\]）。試験を足しても満たせない。[^\n]*単位が違う[^\n]*build全体を止める[^\n]*ユーザーの確認が要る[^\n]*\|$/m,
    "the B publish near the writer limit stays an open [precheck] HOLD",
  );
  assert.match(
    executionPlan,
    /^\| C-resourceの実workerでの上限近傍の候補（台帳§7\.2のG-2） \|[^\n]*\| HOLD（\[precheck\]）。製品形で確認済みの固定値が両立しない。[^\n]*SIGABRT[^\n]*CQ-MEM[^\n]*lifecycle laneに4 caseを配線した[^\n]*製品形[^\n]*2,097,152 Bに届かない[^\n]*registrationはper-Revision preflightを使わず[^\n]*下書きや却下の製品形[^\n]*preflightの値を下げる案\(a\)は[^\n]*起動時の終了を防がない[^\n]*ユーザーの確認が要る[^\n]*\|$/m,
    "the real-worker positive case stays an open [precheck] HOLD for the product shape after CQ-MEM, and says the preflight value alone does not stop the startup exit",
  );
  const cqMemNote = executionPlan.match(/^2026-10-14 CQ-MEM追記: [^\n]*$/m);
  assert.ok(cqMemNote, "the execution plan must carry the CQ-MEM note");
  for (const [pattern, why] of [
    [/Q（4,718,592 B）、S（64 MiB）、per-Revision preflight（2,097,152 B）、whole-set（16 MiB）の値は変えていない。/, "no fixed value changes"],
    [/decisionの形とenvelopeの形は、実workerで2,097,152 Bの正例と2,097,153 Bの全体拒否が通り、lifecycle laneに4 caseを配線した/, "the decision and envelope shapes pass on the real worker"],
    [/製品形[^\n]*2,097,152 Bに届かず、下の残HOLD表のG-2の行に\[precheck\]として残る。/, "the product shape stays an open [precheck]"],
    [/このNOMEMはregistrationで起き、per-Revision preflightの外にあって承認状態に関わらない/, "the product-shape NOMEM is in registration, outside the preflight and independent of approval"],
    [/製品のGraph入口（A-1）/, "the product Graph entrance stays closed"],
  ]) {
    assert.match(cqMemNote[0], pattern, `the CQ-MEM note: ${why}`);
  }
  assert.match(
    executionPlan,
    /^\| Scene 8の上限（台帳§7\.3のG-4） \|[^\n]*\| 移管。C-resourceのHOLDからは外し、CP-1の受入れ（C-product）で確かめる。[^\n]*\|$/m,
    "Scene 8 moves from the C-resource HOLD to the CP-1 acceptance",
  );
  // Every place that records the release names its condition (the CR-1 merge
  // and the green final-head Quick, PR checks and lanes), the CR-1 squash
  // commit, and that Full runs on master after the merge (U7). Full is not a
  // release condition, no field is left unfilled, and no stale "stays until
  // CR-REC" remains.
  const CR1_SQUASH_COMMIT = "750741183cf4d75ccf18b3904a5751b762284bda";
  const crRelease =
    /CR-1（#636）の ?merge ?と、? ?最終 ?head ?の ?Quick・PR checks・lane 6本の ?green/;
  const crSquash = new RegExp(`（CR-1 の squash commit：${CR1_SQUASH_COMMIT}）`);
  const crFullOnMaster =
    /U7（2026-10-13 ?のユーザー決定）により ?Full ?は ?merge ?後の ?master ?で走らせる/;
  const crRecDocs = {
    "execution plan": executionPlan,
    "post-B plan": postBPlan,
    "integration plan": integrationPlan,
    roadmap,
    "memory enforcement draft": await read(
      "docs/plans/nir1-c-query-memory-enforcement-v1-draft.md",
    ),
    "continuation record": await read("docs/plans/nir1-continuation-2026-10.md"),
    "acceptance ledger": await read(
      "docs/plans/nir1-c-query-acceptance-2026-10.md",
    ),
  };
  for (const [name, text] of Object.entries(crRecDocs)) {
    assert.match(text, crRelease, `${name} must name the release condition`);
    assert.match(text, crSquash, `${name} must carry the CR-1 squash commit`);
    assert.match(
      text,
      crFullOnMaster,
      `${name} must say that Full runs on master after the merge (U7)`,
    );
    assert.doesNotMatch(
      text,
      /lane・Full ?の ?green/,
      `${name} must not keep Full as a release condition`,
    );
    assert.doesNotMatch(
      text,
      /integrator が記入/,
      `${name} must not leave a field for the integrator unfilled`,
    );
    assert.doesNotMatch(
      text,
      /で解除するまで残る/,
      `${name} must not keep the HOLD open until CR-REC`,
    );
    if (name !== "acceptance ledger") {
      assert.match(
        text,
        /\]\((?:\.\/)?nir1-c-query-acceptance-2026-10\.md\)/,
        `${name} must link the acceptance ledger`,
      );
    }
  }
  const ledger = crRecDocs["acceptance ledger"];
  for (const id of ["CQ-1", "CQ-2", "CQ-3", "A-1", "G-1", "G-2", "G-3", "G-4"]) {
    assert.match(
      ledger,
      new RegExp(`^\\| ${id} \\|`, "m"),
      `the acceptance ledger must keep a row for ${id}`,
    );
  }
  assert.match(
    ledger,
    /製品の Graph 入口は閉じたまま（A-1）/,
    "the acceptance ledger must keep the product Graph entrance closed",
  );
  assert.match(
    ledger,
    /CR-2（branch `claude\/nir1-cr2`、試験と本台帳の更新）/,
    "the acceptance ledger must name CR-2 as the change that added the tests for its unmet items",
  );
  for (const [id, state] of [
    [
      "G-1",
      /一部充足。writer の N／N\+1、上限ちょうどの保存、A2 の読取は充足。B の上限近傍の publish は \[precheck\]（§7\.1）で、HOLD のまま \|$/,
    ],
    [
      "G-2",
      /一部充足。[^\n]*固定 allocator の実 worker での正例は \[precheck\]（§7\.2）で、HOLD のまま \|$/,
    ],
    [
      "G-3",
      /充足。rollback journal での注入で、WAL 固有の busy は対象外。[^\n]*HOLD を解除する \|$/,
    ],
    [
      "G-4",
      /一部充足。[^\n]*Scene 8 は CP-1 の受入れに移す（§7\.3）。Scene 8 以外は HOLD を解除する \|$/,
    ],
  ]) {
    const row = ledger.match(new RegExp(`^\\| ${id} \\|[^\\n]*$`, "m"));
    assert.ok(row, `the acceptance ledger must keep a row for ${id}`);
    assert.match(
      row[0],
      state,
      `the acceptance ledger's ${id} row must carry its state after CR-2`,
    );
  }
  for (const heading of [
    /^### 7\.1\. \[precheck\] G-1：B の上限近傍の publish$/m,
    /^### 7\.2\. \[precheck\] G-2：実 worker での正例$/m,
    /^### 7\.3\. G-4：Scene 8 は CP-1 の受入れに移す$/m,
  ]) {
    assert.match(
      ledger,
      heading,
      "the acceptance ledger must keep the record of each open or moved item",
    );
  }
  // CQ-MEM (2026-10-14): section 7.2 keeps the CR-2 facts as the "before" and
  // records the measured "after" for each shape. The decision and envelope
  // shapes pass on the real worker; the product shape does not, and stays open.
  const g2 = ledger.match(
    /^### 7\.2\. \[precheck\] G-2：実 worker での正例$[\s\S]*?(?=^### 7\.3\.)/m,
  );
  assert.ok(g2, "the acceptance ledger must keep the G-2 section");
  for (const [pattern, why] of [
    [/^#### CQ-MEM の前（CR-2 の測定）$/m, "the CR-2 measurement stays as the before"],
    [/^#### CQ-MEM の後（2026-10-14、branch `claude\/nir1-cqmem`）$/m, "the CQ-MEM measurement is the after"],
    [/READY の前に SIGABRT（2,085,141 B の確保失敗）/, "the baseline abort at N stays recorded"],
    [/成功（1,224,291／3,241,811）/, "the decision shape at N is recorded with its high-water"],
    [/成功（3,166,524／3,254,671）/, "the envelope shape at N is recorded with its high-water"],
    [/registration が SQLite の NOMEM[^\n]*で終了/, "the product shape's failure is recorded"],
    [/2,097,152 B の正例に届かないので、\[precheck\] である。/, "the product shape stays an open [precheck]"],
    [/Q、S、preflight、whole-set の値は変えていない。/, "CQ-MEM must say it changed no fixed value"],
    // Review of CQ-MEM: registration is outside the per-Revision preflight and
    // does not gate its SQLite JSON on approval, so lowering the preflight (a)
    // alone cannot stop the worker from exiting at startup.
    [/registration は per-Revision preflight（`nir1_graph\/input\.rs` の 2,097,152 B）を使わない（コードの読みと、表 5 の実測）。/, "registration is outside the per-Revision preflight"],
    [/承認で gate しているのは `verify_complete_source_index`（D15）だけで、registration のこの 2 つの SQL は gate していない。/, "registration's own JSON is not gated on approval"],
    [/^\*\*表 5：下書きと却下の製品形/m, "the draft and rejected product shapes are measured"],
    [/`pd-380000`（下書き）[^\n]*NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX/, "a draft product shape ends registration with a NOMEM"],
    [/`pr-380000`（却下）[^\n]*NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX/, "a rejected product shape ends registration with a NOMEM"],
    [/- \(a\) per-Revision preflight を[^\n]*これだけでは起動時の終了を防がない。[^\n]*registration 側の扱い[^\n]*\(b\)／\(c\) と組み合わせる必要がある。/, "option (a) alone does not stop the startup exit"],
  ]) {
    assert.match(g2[0], pattern, `G-2 section: ${why}`);
  }
  // The envelope shape's N+1 is a lifecycle case of its own, in RB-2 and in the
  // G-2 row, and carries the recorded refusal reason.
  assert.match(
    ledger,
    /`native_worker_refuses_the_whole_graph_when_a_candidate_envelope_is_one_byte_over`：envelope の末尾の空白 padding で 2,097,153 B。[^\n]*query-worker-work-other-pre-cleanup-work-failed-other/,
    "RB-2 must record the envelope shape's N+1 on the real worker",
  );
  assert.match(
    ledger,
    /^\| G-2 \|[^\n]*`native_worker_refuses_the_whole_graph_when_a_candidate_envelope_is_one_byte_over`[^\n]*lifecycle lane に 4 case を配線した/m,
    "the G-2 row must name the envelope shape's N+1 case",
  );
  // D13 and D14 describe what registration reads and where its roster lives.
  assert.match(
    ledger,
    /^\| D13 \|[^\n]*却下・保留と非 current の Revision の本文は、どの読取でも読まない。下書き[^\n]*`allow_draft` の読取だけが読む。Graph の registration の A2[^\n]*下書きの payload と envelope を読んで parse し[^\n]*\|$/m,
    "D13 must say that the registration's A2 reads a draft's body",
  );
  assert.match(
    ledger,
    /^\| D14 \|[^\n]*roster の buffer と行の文字列は例外で、最初の push で S に確保され、source を破棄するまで S に残る[^\n]*roster は scope の外で伸ばさない[^\n]*\|$/m,
    "D14 must say that the roster stays in S until the source is dropped",
  );
  assert.match(
    ledger,
    /^### 6\.2\. CQ-MEM の判断（D12〜D18）$/m,
    "the acceptance ledger must record the CQ-MEM decisions",
  );
  assert.match(
    ledger,
    /^### 3\.5\. CQ-MEM のローカルの検証$/m,
    "the acceptance ledger must record the CQ-MEM local verification",
  );
  // Review corrections to the CR-2 record (2026-10-14). The Scene 8 row names
  // the old CR-2 base, which predates the Scene join. Section 7.1 separates the
  // product shape of a Revision from the shape only the create IPC can build,
  // and says CR-2 changed neither the B values nor the B implementation. RB-7
  // records B-ROUTE (#643) as wired, with the product start closed until PUB-G.
  // RB-8 says which reader paths the G-4 logic tests run on.
  assert.match(
    executionPlan,
    /^\| Scene 8の上限（台帳§7\.3のG-4） \|[^\n]*CR-2の旧基点`fbdc8588`ではreaderの応答にSceneが無く[^\n]*\|$/m,
    "the Scene 8 row must name the old CR-2 base, which predates the Scene join",
  );
  assert.match(
    ledger,
    /製品形（UI の prepare で作る形）の単独 Revision は、counted 約 5\.4〜5\.8 MB から whole-set で、約 6\.15 MB から成分 guard で止まる/,
    "the ledger must give the thresholds of the product shape for the B build",
  );
  assert.match(
    ledger,
    /envelope が counted の約 2 倍になる形（試験形）は、counted 約 3 MiB 超で成分 guard が止める。[^\n]*create IPC[^\n]*でだけ作れる/,
    "the ledger must say the doubled-envelope shape is only reachable through the create IPC",
  );
  assert.match(
    ledger,
    /CR-2 は B の値も実装も変えていない。/,
    "the ledger must say that CR-2 changed neither the B values nor the B implementation",
  );
  assert.doesNotMatch(
    ledger,
    /CR-2 は値も実装も変えていない/,
    "the ledger must not say that CR-2 changed no implementation at all (D9 closed the ordinary reader)",
  );
  const rb7 = ledger.match(/^#### RB-7：[\s\S]*?(?=^#### RB-8：)/m);
  assert.ok(rb7, "the acceptance ledger must keep the RB-7 section");
  assert.match(
    rb7[0],
    /B-ROUTE（#643）で maintenance の経路[^\n]*に配線済み[^\n]*製品の自動実行は PUB-G まで閉じたまま/,
    "RB-7 must record B-ROUTE as wired and the product start as closed until PUB-G",
  );
  assert.doesNotMatch(
    rb7[0],
    /まだ配線されておらず/,
    "RB-7 must not call the B build route unwired after B-ROUTE merged",
  );
  const rb8 = ledger.match(/^#### RB-8：[\s\S]*?(?=^### 2\.7\.)/m);
  assert.ok(rb8, "the acceptance ledger must keep the RB-8 section");
  assert.match(
    rb8[0],
    /3 hop と Entity 12／13 の試験は、ordinary reader[^\n]*論理を確かめる試験で、同じ fixture を本番の worker 構成[^\n]*でも確かめる/,
    "RB-8 must say the 3 hop and Entity 12 / 13 tests are ordinary-reader logic tests that also run on the production worker configuration",
  );
  assert.match(
    executionPlan,
    /\| Open／Restoreの回復起動[^\n]*\| 完了（#609）/,
  );
  assert.match(
    executionPlan,
    /2026-10-12追記: DF-01／DF-04のP2 HOLDは、#611[^\n]*解消済み/,
  );
  assert.match(
    executionPlan,
    /#609（R-hook）のmerge証跡[\s\S]*005a8f33-d671-4ac0-8f2c-685cba06f872[\s\S]*299644165509a12e42eb5996db86f6941e62b8f4008615d471e065ebb65622fa[\s\S]*689261c3672963b5695a30df6d6a3b3691e35697/,
    "the #609 Full evidence must stay transcribed with its receipt digest",
  );
  await assertLocalMarkdownLink(
    "docs/plans/nir1-l6-l9-execution-plan.md",
    "docs/plans/nir1-continuation-2026-10.md",
  );
  assert.doesNotMatch(
    roadmap,
    /hard同時2 MiB|次の実装PRはR-hook/,
    "the roadmap current focus must not keep retired HOLDs or the merged R-hook as next",
  );

  assert.match(roadmap, /PR-R0/);
  assert.match(roadmap, /81d0390fe7a935191753b41e5673503f99d51d16/);
  assert.match(roadmap, /0decaab5470c2408be81856ac2373b28e078b945/);
  assert.match(
    roadmap,
    /PR #591.*A2.*Entity／Relation.*immutable Revision.*cold reopen/is,
  );
  assert.match(roadmap, /Graph.*Packing.*AI.*(?:inactive|未activate)/is);
  assert.match(roadmap, /downstream threat model.*draft/is);
  assert.match(roadmap, /NIR-1 overall acceptance remains incomplete/);
  assert.match(integrationPlan, /PR-R0/);
  assert.match(
    integrationPlan,
    /proposal\/4.*Entity／Relation-only.*typed-revision-material.*(?:explicitly ratified|明示批准済み)/is,
  );
  assert.match(
    integrationPlan,
    /PR #591.*A2.*Entity／Relation.*immutable Revision.*cold reopen/is,
  );
  assert.match(
    integrationPlan,
    /Graph.*Packing.*AI.*(?:inactive|未activate)/is,
  );
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
      /(?:今後の実装候補は.*merge gate M.*通常のPRはmerge前のrebase済みclean HEADでQuick＋直後verifyを必須|Future implementation candidates remain subject to the shared merge gate M: an ordinary PR needs a rebased clean candidate with a complete Quick and immediate verify plus the same-head PR checks before merge \(the canonical Full then runs on master\), and a release PR needs a complete hosted Full and immediate verify)/is,
      `${name} must keep future implementation candidates subject to merge gate M`,
    );
    assert.doesNotMatch(
      narrative,
      /merge前のclean HEADのFull＋直後verifyを必須|a clean candidate must pass Full and immediate verify before merge/,
      `${name} must not keep Full as the merge gate of every PR (U7)`,
    );
    assert.doesNotMatch(
      narrative,
      /(?:今後の実装候補は|Future implementation candidates remain)[^\n]*(?:Full|verify)[^\n]*(?:未実施|実施していない|not run)/is,
      `${name} must not exempt future implementation candidates with a historical no-run note`,
    );
  }
});

test("NIR-1 continuation record keeps verbatim user decisions and the bounded delegation", async () => {
  const recordPath = "docs/plans/nir1-continuation-2026-10.md";
  const record = await read(recordPath);

  // U1–U6 and the later U3 change are transcribed verbatim from the user's
  // own answers.
  for (const quote of [
    "「使わずに計画し直す」",
    "「2MiB/8ms はキツすぎてCodexでは達成できませんでした。何かいい案があれば挑戦してもいいかもしれませんが、現状は達成不可能です。」",
    "「1でRalphを使ってやるかどうかは任せます。」",
    "「merge まで進める」",
    "「そもそもこんなにキチキチにメモリを制限している理由がよくわからん」",
    "「防御用の上限だけに簡素化（推奨）」",
    "「この計画では扱わない」",
    "「Ralphの実行はPiではなくClaudeCodeにしてください」",
    "「Workflow subagent で続ける（推奨）」",
    // U7 (2026-10-13 22:22 JST): the user's own message, transcribed verbatim.
    "「FullCIに時間が掛かり、Full中の並列PRのmergeによるbase stale 問題などが発生している。merge条件からCanonicalFullの合格を外す。「merge の直前に base が master と完全に一致していること」という条件も、一緒に緩める。たとえば「rebase して Quick が通れば可」にします。masterのfullで赤が出た場合、優先して対応するなどの運用でカバーする。ReleaseではFullCIのままにする。」",
  ]) {
    assert.ok(
      record.includes(quote),
      `verbatim decision must be kept: ${quote}`,
    );
  }
  assert.match(record, /決定日は 2026-10-12/);
  assert.match(record, /ただし U7 は 2026-10-13（JST）/);
  assert.match(
    record,
    /^\| U7 \| 10-13 22:22 \| 問いへの回答ではない。[^\n]*merge 条件の変更の指示 \| 「FullCIに時間が掛かり、[^\n]*ReleaseではFullCIのままにする。」 \| 通常の PR の merge 条件から canonical Full を外し、rebase 済みの Quick と同じ head の `ci\.yml` checks で merge する。merge 直前の base の完全一致も要求しない。merge 後に master の head で hosted Full を走らせ、赤は優先して直す。release PR と release tag は従来どおり Full を要求する/m,
    "U7 must be a decision row that records the new merge rule",
  );
  // The earlier merge decision (U4) now points at the changed condition.
  assert.match(
    record,
    /^\| U4 \| 17:22 \| 各レーンの到達点 \| 「merge まで進める」 \| 独立受入れと、rebase 済みの Quick＋verify、同じ head の `ci\.yml` checks が green なら、squash merge まで進める（merge の条件は U7 で変更した。当初は hosted Full＋verify が green で、merge 直前に base を照合する条件だった。§6） \|$/m,
  );
  assert.doesNotMatch(
    record,
    /独立受入れと hosted Full＋verify が green なら、merge 直前に base を照合して squash merge まで進める \|/,
  );

  // §6 (merge column): the ordinary path needs no Full; master's Full is the
  // operational cover; a release PR and the release tag keep Full.
  const mergeColumn = normalizeSection(
    sectionFromHeading(record, "## 6. merge 列と各 PR の手順"),
  );
  assert.match(mergeColumn, /各 PR の手順（U4。merge の条件は U7 で変更した。/);
  assert.match(
    mergeColumn,
    /`git fetch origin master` の後、最新の `origin\/master` が候補 HEAD の祖先であることを確かめる/,
  );
  // Review P3: the lanes are pushed branches, and rebasing a pushed branch needs
  // a force push that ship-branch 3.4 forbids without the user's explicit word,
  // so the step says "sync" and points to ship-branch 2.3 for the method.
  assert.match(
    mergeColumn,
    /1\. 最新の `origin\/master` に同期して freeze する（`\/ship-branch` §2\.3。未 push の branch は rebase し、push 済みの branch は force push の明示がなければ `origin\/master` を取り込む）。`git fetch origin master` の後、/,
  );
  assert.doesNotMatch(
    mergeColumn,
    /rebase して freeze する|rebase して 1 からやり直す|rebase と Quick はやり直さない/,
    "the merge column must not tell pushed lanes to rebase without a force push",
  );
  assert.match(
    mergeColumn,
    /complete な Quick receipt を得る。hosted の Quick は、branch を push し、remote HEAD が `candidate_head` と一致することを確かめてから dispatch する/,
  );
  assert.match(
    mergeColumn,
    /同じ head の `ci\.yml` checks（opt-in lane を含む）と Quick を green にする。通常の PR のために canonical Full は dispatch しない/,
  );
  assert.match(
    mergeColumn,
    /`gh pr merge --squash --match-head-commit <candidate_head>` で merge する。merge 直前に base が `candidate_base` と一致することは要求しない。Quick の後に `origin\/master` が進んでも、衝突がなく PR HEAD が `candidate_head` のままなら、同期（手順 1）と Quick はやり直さない。衝突があるか候補を変えるときは、同期して 1 からやり直す/,
  );
  assert.match(
    mergeColumn,
    /first parent が `candidate_base` と違っても失敗にしない/,
  );
  assert.match(
    mergeColumn,
    /merge した担当は、master の head で hosted の canonical Full を dispatch する。実行中なら、終わった後に最新の master head で 1 本だけ dispatch する。次の merge はこの Full の完了を待たない。dispatch した run の id は integrator へ引き継ぎ、完了の見届けと赤のときの対応の開始は integrator が行う（`\/ship-branch` §8\.3）。master の Full が赤になったら（判定は `\/ship-branch` §8\.5。全 job を再実行している間も赤のままである）、次の merge の前に、全 job の再実行で再現するか、どの merge が持ち込んだかを切り分け、修正か revert を他の PR より先に merge する。他のレーンの PR を revert するかどうかは integrator が判断する/,
  );
  assert.match(
    mergeColumn,
    /release PR と release tag は、従来どおり complete な hosted Full と verify を要求する（release PR は merge 前、tag は merge 後の release commit 自身）/,
  );
  assert.doesNotMatch(
    mergeColumn,
    /base が `candidate_base` と一致することを確かめる|approved merge base と照合する|profile=full|Full（7 part と `full-aggregate` の verify）を green にする/,
    "§6 must not keep the pre-merge Full steps",
  );
  assert.match(
    normalizeSection(sectionFromHeading(record, "## 2. 計画の要約")),
    /保守の失敗で PR の Security job が止まった場合は、merge 列を止めて実装を続け、ユーザーに報告する。master の Full が赤になった場合は、§6 の優先対応に従う（U7）/,
  );
  assert.match(record, /2026-10-12 にユーザーが承認済み/);
  assert.match(
    record,
    /^\| U3 変更 \| 23:05 \|[^\n]*\| 「Workflow subagent で続ける（推奨）」 \|[^\n]*Workflow subagent/m,
    "the 23:05 switch from Ralph to Workflow subagents must be a decision row",
  );
  // The plan file was revised after approval; the record keeps both digests.
  assert.match(
    record,
    /承認時（21:51 JST）の本文の SHA-256 は `0bfb2a90a0b1b0e13b39b99de825674647d88621afe30855d5bed2151efb474e`/,
  );
  assert.match(
    record,
    /23:05 JST の改訂後は `f712102e78ca4e3dc217a6e6b1fc637e6a9085050d24e7b586fb6c179ee2e335`/,
  );

  const delegation = normalizeSection(
    sectionFromHeading(record, "## 3. U3 の委任範囲と記録の形式"),
  );
  assert.match(
    delegation,
    /C-resource、C-body、C-product、D-final 追補、D-transport、D-dispatch、H-store／H-current、DI-1、E/,
  );
  assert.match(
    delegation,
    /worker／owner／終了処理／lifecycle の技術判断と、確認済みの actor・防御・受信先・受入れの範囲内での技術的脅威モデルの改訂/,
  );
  for (const exclusion of [
    "秘密・データの新しい送信先",
    "保存範囲の拡大",
    "閾値の緩和（確認台帳の現行閾値と Gold の緩和・黙示変更を含む）",
    "製品公開",
    "製品認可の削除",
    "新しい契約・authority",
  ]) {
    assert.ok(
      delegation.includes(exclusion),
      `delegation exclusion: ${exclusion}`,
    );
  }
  assert.match(delegation, /NIR-1 の残レーンの外には適用しない/);
  assert.match(
    delegation,
    /\| ID \| 日付 \| レーン／PR \| 判断 \| 信頼境界（actor・防御・受信先・受入れ） \| 代替案 \| advisor（requested／effective の model・effort、結論） \| 除外6項目への該当 \| owner\/lifecycle matrix \| 状態 \|/,
    "lanes must share one delegated-decision record format",
  );
  assert.match(
    delegation,
    /記録先はレーンの decisions 文書と PR 本文で、本表には判断の ID と記録先を残す/,
    "the record location must match GDX-PRECHECK-001",
  );
  assert.doesNotMatch(delegation, /8 ms|2 MiB/);

  // Ralph only launched the first three lanes; later implementation runs as
  // Workflow subagents after the 23:05 decision.
  const laneTable = sectionFromHeading(record, "## 4. レーン表");
  const ralphRows = laneTable
    .split("\n")
    .filter((line) => line.startsWith("| ") && line.includes("Ralph"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  assert.deepEqual(
    ralphRows.map((cells) => cells[1]),
    ["CR-1／CR-REC", "DT-1→DT-2→DT-3", "HP-1"],
    "only the first three lanes may name Ralph",
  );
  for (const cells of ralphRows) {
    assert.match(cells[3], /Ralph で起動（以後は Workflow subagent）/);
  }
  const execution = normalizeSection(
    sectionFromHeading(record, "## 5. 実行方式と precheck の記録"),
  );
  assert.match(
    execution,
    /最初の3レーン（CR-1、DT-1、HP-1）は、Ralph を Claude Code の backend で起動した/,
  );
  assert.match(
    execution,
    /以後の実装は Workflow subagent で行う。進め方は builder → Fable による reviewer → fix の順/,
  );
  assert.doesNotMatch(execution, /Ralph は Claude Code の backend で動かす/);

  for (const lane of [
    "gov",
    "cres",
    "cp0",
    "dt1",
    "hp",
    "spike",
    "contracts",
  ]) {
    assert.match(
      record,
      new RegExp(
        `\\| \`claude-nir1-${lane}\` \\| \`claude/nir1-${lane}\` \\| \`a153743b\` \\|`,
      ),
      `worktree ledger row for ${lane}`,
    );
  }
  assert.match(
    record,
    /\| `claude-nir1-dt2` \| `claude\/nir1-dt2` \| `3688a063`（`claude\/nir1-dt1`） \| DT-2/,
    "worktree ledger row for dt2, stacked on DT-1",
  );
  // Stacked worktrees created after G0 started (times from the branch reflog).
  assert.match(
    record,
    /\| `claude-nir1-dt3` \| `claude\/nir1-dt3` \| `3688a063`（`claude\/nir1-dt1`） \| DT-3/,
    "worktree ledger row for dt3, stacked on DT-1",
  );
  assert.match(
    record,
    /\| `claude-nir1-cp1` \| `claude\/nir1-cp1` \| `0e041537`（`claude\/nir1-cres`） \| CP-1/,
    "worktree ledger row for cp1, stacked on CR-1",
  );
  assert.match(
    record,
    /`claude-nir1-dt3` は 2026-10-12 23:34 JST に、同じ DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った/,
  );
  assert.match(
    record,
    /`claude-nir1-cp1` は 2026-10-13 00:11 JST に、`claude\/nir1-cres` の CR-1b commit `0e041537e8c56c43be38afea490c26857bb488a7` から作った/,
  );
  assert.match(record, /a153743b3f672b7274bdd748f15ef9c216dc9961/);
  assert.match(record, /3688a0633537818e80a88e40f056604ffa496e8a/);
  // U3 追加 was the message that sent the first plan presentation back; the
  // plan was approved on its second presentation at 21:51.
  assert.match(
    record,
    /^\| U3 追加 \| 18:45 \| 問いへの回答ではない。最初の計画提示（ExitPlanMode）を差し戻したときのユーザーのメッセージ。計画の承認は、21:51 の2回目の提示に対するもの \| 「Ralphの実行はPiではなくClaudeCodeにしてください」 \|/m,
    "U3 追加 must be recorded as the plan send-back message, not the approval",
  );
  assert.doesNotMatch(record, /\| U3 追加 \| 18:45 \| 計画の承認時の指示 \|/);
  assert.match(
    normalizeSection(
      sectionFromHeading(
        record,
        "## 8. 2026-09-25/26 の off-master 承認と WIP（不採用・参照のみ）",
      ),
    ),
    /U1 により採用しない。master の確認台帳には記録せず、承認の根拠にも文面の流用元にもしない/,
  );
  assert.match(record, /G0 → CR-1 → CR-REC → CP-0 → DT-1/);

  // Session A (K1): the receipt time, the draft commit and digest, and the two
  // statements transcribed exactly as the user typed them.
  const sessionA = record.split("### 10.1. Session A（K1）\n", 2)[1];
  assert.ok(sessionA, "the work record must keep the Session A record");
  for (const evidence of [
    "| 受信 | 2026-10-12T23:58+0900。",
    `| draft | \`claude/nir1-contracts\` の commit \`${PROPOSAL6_DRAFT_COMMIT}\` の \`${PROPOSAL6_DRAFT_PATH}\` |`,
    `| draft の SHA-256 | \`${PROPOSAL6_DRAFT_SHA256}\` |`,
  ]) {
    assert.ok(sessionA.includes(evidence), `Session A must record ${evidence}`);
  }
  assert.ok(
    sessionA.includes(
      `\n\`\`\`text\n${PROPOSAL6_GRAPH_STATEMENT}\n${PROPOSAL6_RULE_STATEMENT}\n\`\`\`\n`,
    ),
    "Session A must keep the two statements verbatim, one per line",
  );
  assert.match(
    sessionA,
    /C-resource の受入れの HOLD は、CR-REC（CR-1 の lane 証跡と独立受入れ）で解除するので、まだ解除しない/,
  );
  assert.match(
    sessionA,
    /Graph の製品公開、local 送信、新しい authority・保存先・送信先、K2〜K6 の内容を確認しない/,
  );
  assert.match(
    record,
    /^\| K1 \| `nir1-l6-l9-contract-proposal\/6`：`graph-limited-binding`、`nir1-defensive-resource-limits` \|[^\n]*\| 確認済み（2026-10-12、Session A。2行とも。§10\.1） \|$/m,
  );
  for (const k of ["K2", "K3", "K4", "K5", "K6"]) {
    const row = record.match(new RegExp(`^\\| ${k} \\|[^\\n]*$`, "m"))?.[0];
    assert.ok(row, `${k} must keep its contract row`);
    assert.doesNotMatch(
      row,
      /確認済み|Session A/,
      `${k} must not be recorded as confirmed by Session A`,
    );
  }
  // The bump-version release Full still names a local Full; it is recorded as
  // an open [policy] mismatch rather than edited from G0.
  const openIssues = normalizeSection(
    sectionFromHeading(record, "## 11. 未解決事項"),
  );
  assert.match(
    openIssues,
    /`\[policy\]` `\.agents\/skills\/bump-version\/SKILL\.md` の手順9（97行目）は、release commit の Full に、ローカルの `pnpm ci:local:full -- --base "\$release_base" --head "\$release_head"` を指示したままである。.*GDX-TRACE-001.*食い違う。.*G0 では skill を編集しない/,
  );
  await assertLocalMarkdownLink(recordPath, PROPOSAL6_DRAFT_PATH);
  await assertLocalMarkdownLink(
    recordPath,
    "policies/quality/iron-laws.md",
    "GDX-TRACE-001",
  );
  await assertLocalMarkdownLink(
    recordPath,
    "policies/quality/iron-laws.md",
    "GDX-PRECHECK-001",
  );
});

test("records that state the old Full-before-merge rule say so and point to the current rule", async () => {
  // U7 (2026-10-13), review P3: these September records and an unapproved draft
  // still said, in the present tense, that every merge needs a Full. Their
  // original sentences stay as written (they are history); a note beside each
  // says it is the rule of its time and where the current conditions live, so
  // that resuming the work from the record does not revive the old gate.
  for (const [planPath, note] of [
    [
      "docs/plans/nir1-l5-acceptance.md",
      /マージには最新baseを含むclean HEADでFull-from-stage-1＋verifyが別途必要である。（この一文は当時の規則の記録である。2026-10-13のmerge条件の変更（\[続行計画\]\(nir1-continuation-2026-10\.md\)の§1 U7）以降、通常のPRのmergeにFullは要求されない。現行の条件は\[GDX-TRACE-001\]\(\.\.\/\.\.\/policies\/quality\/iron-laws\.md#GDX-TRACE-001\)に従う。）/,
    ],
    [
      "docs/plans/chronicle-modality-gate-implementation.md",
      /Fullはmerge前のclean commitで必要となる別gateであり、部分実行やdirty候補のQuick\/Journeyで置き換えない。（Fullをmerge前に必要とするのは当時の規則である。2026-10-13のmerge条件の変更（\[続行計画\]\(\.\/nir1-continuation-2026-10\.md\)の§1 U7）以降、通常のPRのmergeにFullは要求されない。現行の条件は\[GDX-TRACE-001\]\(\.\.\/\.\.\/policies\/quality\/iron-laws\.md#GDX-TRACE-001\)に従う。部分実行やdirty候補で置き換えない点は変わらない。）/,
    ],
    [
      "docs/plans/nir1-related-scenes-precheck.md",
      /Merge requires clean Full-from-stage-1 and verify \(the rule when this draft was written; since 2026-10-13 an ordinary PR's merge conditions follow \[GDX-TRACE-001\]\(\.\.\/\.\.\/policies\/quality\/iron-laws\.md#GDX-TRACE-001\), see U7 in \[the continuation record\]\(nir1-continuation-2026-10\.md\), and Full is required only for a release PR and the release tag\)/,
    ],
  ]) {
    const source = await assertLocalMarkdownLink(
      planPath,
      "policies/quality/iron-laws.md",
      "GDX-TRACE-001",
    );
    assert.match(
      normalizeSection(source),
      note,
      `${planPath} must mark its Full-before-merge sentence as the old rule`,
    );
    await assertLocalMarkdownLink(
      planPath,
      "docs/plans/nir1-continuation-2026-10.md",
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
  assert.match(
    author,
    /grimodex-impact-gate.*verify:quality.*Light.*まとめて/is,
  );
  assert.match(author, /成功済み command.*重ねて実行しない/);
  const authorCommands = [...author.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join("\n");
  assert.doesNotMatch(
    authorCommands,
    /pnpm (?:verify:quality|eval:impact|ci:local:quick)/,
  );
  assert.match(
    impact,
    /commit／PR.*依頼していない調査・レビュー.*gate.*CI.*自動起動しない/,
  );
  assert.match(impact, /pnpm verify:quality/);
  assert.match(impact, /verify:quality.*Light suite.*同一の検証範囲ではない/);
  assert.match(impact, /成功が確認済みなら再実行しない/);

  const diagnostic = normalizeSection(
    sectionFromHeading(impact, "## 作業ツリー・限定範囲の Light 評価"),
  );
  assert.match(diagnostic, /候補証跡を作らない変更.*Quick.*開始せず/);
  assert.match(diagnostic, /pnpm eval:impact -- --run/);
  assert.match(diagnostic, /branch.*staged.*unstaged.*untracked/);
  assert.match(
    diagnostic,
    /ファイル集合を指定する場合だけ.*--changed-file.*対象外の既存差分/,
  );
  assert.match(
    diagnostic,
    /限定範囲.*診断証拠.*candidate 全体.*Quick／Full receipt.*しない/,
  );
  assert.match(diagnostic, /suite.*減らさず.*全 suite fallback.*変更しない/);

  const candidateRaw = sectionFromHeading(impact, "## PR／release の候補証跡");
  const candidate = normalizeSection(candidateRaw);
  assert.match(
    candidate,
    /PR／release の証跡が依頼範囲に含まれ.*CI が許可されている場合だけ.*focused 検証.*clean な候補 commit/,
  );
  assert.match(candidate, /commit-only.*CI 明示除外.*開始しない/);
  assert.match(
    candidate,
    /base／head.*一度だけ解決.*Quick.*直後.*verify.*同じ値/,
  );
  assert.match(
    candidate,
    /wrapper.*Light suite.*eval:impact -- --run.*別途重ねない/,
  );
  const quick = commandBindings(candidateRaw, "pnpm ci:local:quick", "Quick");
  const verify = commandBindings(
    candidateRaw,
    "pnpm ci:local:verify -- quick",
    "Quick verify",
  );
  assert.deepEqual(quick, [
    { base: '"$candidate_base"', head: '"$candidate_head"' },
  ]);
  assert.deepEqual(verify, quick);
  assert.deepEqual(
    commandBindings(impact, "pnpm ci:local:quick", "all Quick"),
    quick,
  );
  assert.deepEqual(
    commandBindings(
      impact,
      "pnpm ci:local:verify -- quick",
      "all Quick verify",
    ),
    verify,
  );
  assert.ok(
    candidateRaw.indexOf("pnpm ci:local:quick") <
      candidateRaw.indexOf("pnpm ci:local:verify -- quick"),
  );
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
