// 道具の「写し」と製品の定数・条件式の照合（形 1：製品の source を読んで比べる。lib.test.mjs の
// 敬称・AI command、measure-b-core.test.mjs の窓と欄と同じ形）。
//
// 製品の TS は `@/` の別名や拡張子なしの相対 import があり、node の試験では import できない。
// なので source の定数・条件式の並びを取り出して比べる。条件式の論理（実行時の振る舞い）までは見ない。
// 正規表現が当たらなければ必ず落ちる（assert.ok(match)）：製品が書き換わったとき、黙って通らない。
// 製品の挙動の正本は常に製品のコード。ここが落ちたら、道具の写しを製品に合わせて直す（逆はしない）。
//
// 対応表（調査の C4〜C16。C1〜C3 は lib.test.mjs・measure-b-core.test.mjs にある）：
//   C4  一括承認可の条件（lib.isBulkApprovableRow）          → 「一括承認可の条件」の 3 本
//   C5  分類（classifyRow の bulkBind）                      → measure-a-metrics.test.mjs（挙動）と、下の renderer の旗
//   C6  candidateKey                                          → 「candidateKey」
//   C7  buildSourceViewsForPlan の写し                       → 「buildSourceViewsForPlan」
//   C8  catalog の組み立て                                    → 「catalog の組み立て」
//   C9  型 slug・人物の前提                                   → 「型の slug」
//   C10 B2 の模擬作者の handler                               → 「bApply」
//   C11 別名ボタンの条件                                      → 「別名ボタン」
//   C12 B の active／visible                                  → 「候補の active／visible」
//   C15 照合 method の語彙                                    → 「照合 method」
//   C16 B の型・surface 名                                    → 「B の型と surface」
//   seed を落とす経路（#894・#906）                           → 「seed を落とす経路」
//   保存済みの未 review の提案の件数（問い 4）                → 「保存済みの提案」
// 足せないもの（実行時の振る舞いの照合が要る）は records の open：C13（本文の canonical の期待値）、
// 一括承認の実行時の再検査（recheckExactBindAgainstEntries）と静的な旗の一致。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CODEX_JUDGMENT, typeMatches } from "./measure-b-core.mjs";
import {
  STORED_PROPOSAL_KIND_FIELDS,
  STORED_PROPOSAL_STATUSES,
  STORED_RESTORE_LIST_LIMIT,
  STORED_RESUMABLE_RUN_STATUSES,
  STORED_RUN_LIST_LIMIT,
  STORED_RUN_STATUSES,
  STORED_SET_STATUSES,
  candidateKey,
  findAiCommands,
  isBulkApprovableRow,
} from "./lib.mjs";
import { codexTypeOf, unresolvedReason } from "./measure-a-metrics.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const product = (relative) =>
  readFileSync(path.join(ROOT, "src/features", relative), "utf8");
const tool = (name) =>
  readFileSync(path.join(import.meta.dirname, name), "utf8");

// ---- source を読む小さな道具 -------------------------------------------------------------

const CLOSERS = { "(": ")", "{": "}", "[": "]" };

/** text[open] の括弧に対応する閉じ括弧までの、括弧の内側（文字列・コメントは考えない：製品の対象部は単純）。 */
function inside(text, open) {
  const opener = text[open];
  assert.ok(CLOSERS[opener], `not a bracket at ${open}`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  assert.fail("unbalanced bracket");
}

/** 深さ 0 の separator で切る（文字列・正規表現の中の括弧は無いものとする）。 */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.replace(/\s+/gu, "")).filter((p) => p.length > 0);
}

/** anchor（正規表現）の直後の最初の括弧の内側。 */
function insideAfter(text, anchor, bracket) {
  const match = anchor.exec(text);
  assert.ok(match, `anchor not found: ${anchor}`);
  // anchor が括弧で終わるならその括弧を使う（`foo(` の直後の `(` を探さない）。
  const last = match.index + match[0].length - 1;
  const open = text[last] === bracket ? last : text.indexOf(bracket, last + 1);
  assert.ok(open >= 0, `no ${bracket} after ${anchor}`);
  return inside(text, open);
}

/** 関数の本体（引数の括弧の後の最初の `{` の内側）。 */
function functionBody(text, name) {
  const match = new RegExp(
    `(?:export )?(?:async )?function ${name}\\b`,
    "u",
  ).exec(text);
  assert.ok(match, `function not found: ${name}`);
  const paramsOpen = text.indexOf("(", match.index + match[0].length);
  const paramsClose = paramsOpen + inside(text, paramsOpen).length + 1;
  const bodyOpen = text.indexOf("{", paramsClose + 1);
  assert.ok(bodyOpen >= 0, `no body: ${name}`);
  return inside(text, bodyOpen);
}

/** object literal の最上位の key の並び。 */
function topLevelKeys(objectBody) {
  // object literal（`,` 区切り）も interface（`;` 区切り・readonly・コメント）も読む。
  const plain = objectBody
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/;/gu, ",");
  return splitTop(plain, ",")
    .map((entry) => /^(?:\.\.\.)?(?:readonly)?(\w+)/u.exec(entry)?.[1])
    .filter(Boolean);
}

/** 式全体を包む括弧を外す。 */
function unwrapParens(expression) {
  const text = expression.trim();
  return text.startsWith("(") && inside(text, 0).length === text.length - 2
    ? inside(text, 0)
    : text;
}

/** `return a && b && c;` の条件の並び（空白を除いた文字列）。 */
function returnConjuncts(body) {
  const match = /return\s*([\s\S]*?);/u.exec(body);
  assert.ok(match, "return not found");
  return splitTop(unwrapParens(match[1]), "&&");
}

const flat = (text) => text.replace(/\s+/gu, "");

// ---- C4：一括承認可の条件 ------------------------------------------------------------------

test("一括承認可の条件：道具の 3 条件は製品の画面（safeProposals）と実行（isTarget）の条件と同じ。実行だけにある !application は A では未適用なので影響しない", () => {
  const review = product("codex/CodexEntityProposalReview.tsx");
  const screen = splitTop(
    insideAfter(review, /const safeProposals = proposals\.filter\(/u, "("),
    "&&",
  );
  // 先頭は `(proposal) => proposal.applicability === ...`。
  assert.deepEqual(
    screen.map((c) => c.replace(/^\(proposal\)=>/u, "").replace(/,$/u, "")),
    [
      'proposal.applicability==="applicable"',
      'proposal.status==="unreviewed"',
      "isSafeForCodexEntityBulkApprove(proposal.safety)",
    ],
  );
  const api = product("codex/codexStructureExtractionApi.ts");
  const isTarget =
    /const isTarget = \(proposal: CodexEntityReviewProposal\) =>([\s\S]*?);\n/u.exec(
      api,
    );
  assert.ok(isTarget, "isTarget not found");
  assert.deepEqual(splitTop(isTarget[1], "&&"), [
    'proposal.applicability==="applicable"',
    'proposal.status==="unreviewed"',
    "!proposal.application",
    "isSafeForCodexEntityBulkApprove(proposal.safety)",
  ]);
  // 道具の写し。renderer の行は application を持たない（A は決定を入れず、構造抽出の直後の projection を読む）。
  const lib = tool("lib.mjs");
  assert.deepEqual(returnConjuncts(functionBody(lib, "isBulkApprovableRow")), [
    'row.applicability==="applicable"',
    'row.status==="unreviewed"',
    "row.safe===true",
  ]);
  assert.equal(
    isBulkApprovableRow({
      applicability: "applicable",
      status: "unreviewed",
      safe: true,
    }),
    true,
  );
});

test("一括承認可の旗：製品は create-new の 7 条件と完全一致 bind の 3 条件の 2 種だけを一括の対象にする（道具の bulk／bulkBind の前提）", () => {
  const store = product("codex/codexStructureExtractionStore.ts");
  const flagsOf = (name) =>
    returnConjuncts(functionBody(store, name)).map((c) =>
      c.replace(/^flags\./u, ""),
    );
  assert.deepEqual(flagsOf("isSafeCreateNewForCodexEntityBulkApprove"), [
    "evidenceExact",
    "typeResolved",
    "noExistingCandidates",
    "explicitProperName",
    "explicitAliasesOnly",
    "noRelationDeps",
    "createNew",
  ]);
  assert.deepEqual(
    flagsOf("isSafeExistingExactBindForCodexEntityBulkApprove"),
    ["existingExactBind", "evidenceExact", "existingBindNoDependents"],
  );
  const any = /return\s*([\s\S]*?);/u.exec(
    functionBody(store, "isSafeForCodexEntityBulkApprove"),
  );
  assert.ok(any, "isSafeForCodexEntityBulkApprove return not found");
  assert.deepEqual(splitTop(unwrapParens(any[1]), "||"), [
    "isSafeCreateNewForCodexEntityBulkApprove(flags)",
    "isSafeExistingExactBindForCodexEntityBulkApprove(flags)",
  ]);
  // create-new の旗は binding が create-new のときだけ立つ。bind の旗は refreshEntityBindSafety が引き直す。
  assert.match(store, /createNew: args\.bindingKind === "create-new"/u);
});

test("一括承認の旗の出どころ：renderer は製品の関数で safe を作り、構造抽出の戻り値は旗を引き直した後の projection", () => {
  const renderer = tool("renderer.ts");
  assert.match(
    renderer,
    /import \{ isSafeForCodexEntityBulkApprove \} from "@\/features\/codex\/codexStructureExtractionStore";/u,
  );
  for (const line of [
    "safe: isSafeForCodexEntityBulkApprove(proposal.safety),",
    "applicability: String(proposal.applicability),",
    "status: String(proposal.status),",
    "bulkApprovable: isBulkApprovableRow(row),",
    "bulkApprovable: countBulkApprovable(rows),",
  ])
    assert.ok(renderer.includes(line), `renderer lost: ${line}`);
  const api = product("codex/codexStructureExtractionApi.ts");
  assert.match(
    functionBody(api, "startCodexStructureExtraction"),
    /return refreshEntityBindSafety\(projection\);/u,
  );
});

// ---- seed を落とす経路（#894・#906）--------------------------------------------------------------

test("seed を落とす経路：呼び名と却下済みの表記だけを、planner の前段で落として projection に残す。planner は seed を飛ばさない", () => {
  const api = product("codex/codexStructureExtractionApi.ts");
  const body = functionBody(api, "startCodexStructureExtraction");
  const iRelational = body.indexOf("skippedRelationalTerms.push(");
  const iDismissed = body.indexOf("foldedDismissedSurfaces.push(");
  const iSeed = body.indexOf("seeds.push(");
  assert.ok(iRelational > 0 && iDismissed > iRelational && iSeed > iDismissed);
  // 落とす条件：呼び名は「名簿に当たらない」、却下は「名簿に当たらず、却下集合に有る」。
  assert.match(
    body,
    /existingResolution\.status === "none"\s*\?\s*relationalTermKind\(seed\.surface\)/u,
  );
  assert.match(
    body,
    /existingResolution\.status === "none" &&\s*dismissedKeys\.has\(surfaceKey\)/u,
  );
  assert.match(body, /const surfaceKey = candidateKey\(seed\.surface\);/u);
  // 落とした表記は projection に残る（道具が読む欄）。
  assert.match(
    body,
    /\.\.\.\(skippedRelationalTerms\.length > 0 \? \{ skippedRelationalTerms \} : \{\}\)/u,
  );
  assert.match(
    body,
    /\.\.\.\(foldedDismissedSurfaces\.length > 0 \? \{ foldedDismissedSurfaces \} : \{\}\)/u,
  );
  assert.match(
    body,
    /\.\.\.\(dismissalsUnavailable \? \{ dismissalsUnavailable: true as const \} : \{\}\)/u,
  );
  const store = product("codex/codexStructureExtractionStore.ts");
  assert.deepEqual(
    topLevelKeys(
      insideAfter(
        store,
        /interface CodexStructureSkippedRelationalTerm /u,
        "{",
      ),
    ).sort(),
    ["kind", "surface"],
  );
  assert.deepEqual(
    topLevelKeys(
      insideAfter(
        store,
        /interface CodexStructureFoldedDismissedSurface /u,
        "{",
      ),
    ).sort(),
    ["key", "surface"],
  );
  // planner は seed を飛ばさない：呼び出しは emitBlocked を渡さず（既定 true）、seed の form は proper-name か alias だけで、
  // planner が提案を作らずに飛ばす 2 つの条件（emitBlocked=false の blocked、代名詞だけ・名前になれる言及が無い）に当たらない。
  assert.deepEqual(
    topLevelKeys(
      insideAfter(body, /const planned = planBindCodexEntityProposals\(/u, "{"),
    ),
    ["hypotheses", "createId"],
  );
  assert.ok(
    flat(body).includes(
      'form:seed.features.appearsAsProperName?"proper-name":"alias"',
    ),
  );
  const planner = product("codex/extraction/proposalPlanner.ts");
  assert.match(planner, /const emitBlocked = input\.emitBlocked \?\? true;/u);
  assert.match(
    planner,
    /const NAMEABLE_MENTION_FORMS[^=]*= new Set\(\[\s*"proper-name",\s*"alias",/u,
  );
  const plan = functionBody(planner, "planBindCodexEntityProposals");
  // continue は 4 つ：飛ばす条件の 2 つ（上）と、resolved・ambiguous を push した後の 2 つ。
  assert.equal(plan.match(/\bcontinue\b/gu).length, 4);
  assert.match(plan, /if \(blocked && !emitBlocked\) continue;/u);
  assert.match(
    plan,
    /if \(isPronounOnly\(hypothesis\) \|\| !hasNameableMention\(hypothesis\)\) \{[^}]*continue;/u,
  );
  assert.equal(plan.match(/\}\);\s*continue;/gu).length, 2);
  assert.match(
    functionBody(planner, "isPronounOnly"),
    /forms\.every\(\s*\(mention\) => mention\.form === "pronoun" \|\| mention\.form === "implicit",\s*\)/u,
  );
  // renderer が読む欄。
  const renderer = tool("renderer.ts");
  for (const field of [
    "projection.skippedRelationalTerms",
    "projection.foldedDismissedSurfaces",
    "projection.dismissalsUnavailable",
  ])
    assert.ok(renderer.includes(field), `renderer does not read ${field}`);
});

// ---- C6：candidateKey ----------------------------------------------------------------------

test("candidateKey：製品の式（trim → NFC → ASCII 小文字化）を取り出して実行し、道具の写しと同じ出力にする", () => {
  const source = product("codex/codexCandidates.ts");
  const body = functionBody(source, "candidateKey");
  const productKey = new Function("surface", body);
  const samples = [
    "",
    "  Abc  ",
    "ＡＢＣ", // 全角は畳まない
    "Ａbc",
    "が", // NFD の濁点 → NFC
    "が",
    "İstanbul", // ASCII 以外の大文字は触らない
    "ÀÉ",
    "\tName\n",
    "ABCxyz123",
  ];
  for (const sample of samples)
    assert.equal(
      candidateKey(sample),
      productKey(sample),
      JSON.stringify(sample),
    );
});

// ---- C7：buildSourceViewsForPlan -----------------------------------------------------------

test("buildSourceViewsForPlan：範囲を owned→context の順に集めて min／max で包み、document が無い window は飛ばす（製品と同じ）", () => {
  const api = product("codex/codexStructureExtractionApi.ts");
  const renderer = tool("renderer.ts");
  const productBody = flat(functionBody(api, "buildSourceViewsForPlan"));
  const rendererBody = flat(functionBody(renderer, "buildSourceViewsForPlan"));
  // 製品は mergeRanges を別関数にし、道具は式に展開している。どちらも min(start)・max(end)。
  const merge = flat(functionBody(api, "mergeRanges"));
  assert.ok(
    merge.includes("start:Math.min(...ranges.map((range)=>range.start))"),
  );
  assert.ok(merge.includes("end:Math.max(...ranges.map((range)=>range.end))"));
  assert.ok(
    rendererBody.includes(
      "start:Math.min(...ranges.map((range)=>range.start))",
    ),
  );
  assert.ok(
    rendererBody.includes("end:Math.max(...ranges.map((range)=>range.end))"),
  );
  assert.ok(
    productBody.includes(
      "mergeRanges([...window.ownedRanges,...window.contextRanges",
    ),
  );
  assert.ok(
    rendererBody.includes("[...window.ownedRanges,...window.contextRanges]"),
  );
  for (const common of [
    "constdocumentByRef=newMap(snapshot.documents.map((document)=>[document.ref,document]asconst),);",
    "constdocument=documentByRef.get(window.documentRef);",
    "if(!document)continue;",
    "ref:window.sourceRef,",
    "awaitbuildNarrativeSourceView({",
  ])
    for (const [label, text] of [
      ["product", productBody],
      ["renderer", rendererBody],
    ])
      assert.ok(text.includes(common), `${label} lost: ${common}`);
});

test("seed を落とす経路：製品の seed の loop で seed を捨てるのは、呼び名と却下済みの 2 つの continue だけ（他の落とし先を足すと落ちる。F3b の m5）", () => {
  const api = product("codex/codexStructureExtractionApi.ts");
  const body = functionBody(api, "startCodexStructureExtraction");
  const loop = insideAfter(
    body,
    /for \(const seed of prepass\.seeds\) \{/u,
    "{",
  )
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  // 捨てる文は continue（上の 2 つ）だけ。break・return・throw・try で loop を抜ける・飛ばす形を許さない。
  assert.equal(loop.match(/\bcontinue\b/gu).length, 2);
  assert.doesNotMatch(loop, /\b(?:break|return|throw|try)\b/u);
  // 2 つの continue は、それぞれ落とした表記を projection に残す push の直後。
  assert.match(loop, /skippedRelationalTerms\.push\(\{[^}]*\}\);\s*continue;/u);
  assert.match(
    loop,
    /foldedDismissedSurfaces\.push\(\{[^}]*\}\);\s*continue;/u,
  );
  // if は落とす 2 つの条件だけ（条件を足した continue・push の包みを許さない）。
  const conditions = [...loop.matchAll(/\bif \(/gu)].map((m) =>
    flat(inside(loop, m.index + 3)),
  );
  assert.deepEqual(conditions, [
    "relationalKind",
    'existingResolution.status==="none"&&dismissedKeys.has(surfaceKey)',
  ]);
  // seeds.push は loop の本体の最上位の 1 文（条件・短絡の中に入れない）。
  const iPush = loop.indexOf("seeds.push(");
  assert.ok(iPush > 0);
  assert.equal(loop.indexOf("seeds.push(", iPush + 1), -1);
  let depth = 0;
  for (const ch of loop.slice(0, iPush)) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
  }
  assert.equal(depth, 0, "seeds.push は最上位の文");
  assert.match(loop.slice(0, iPush), /[;}]\s*$/u, "seeds.push は文の先頭");
});

// ---- C8：catalog の組み立て ----------------------------------------------------------------

test("catalog の組み立て：renderer の entries／relations の欄と start の引数名は、製品の dialog と同じ（renderer は skipNativePersist だけ足す）", () => {
  const dialog = product("codex/CodexStructureExtractDialog.tsx");
  const renderer = tool("renderer.ts");
  const mapFields = (text, anchor) =>
    topLevelKeys(insideAfter(text, anchor, "{"));
  for (const [label, anchor] of [
    ["entries", /entries: entries\.map\(\(entry\) => \(/u],
    [
      "relations",
      /\(await listCodexRelations\(projectId\)\)\.map\(\(row\) => \(/u,
    ],
  ]) {
    const fromDialog = mapFields(dialog, anchor);
    const fromRenderer = mapFields(renderer, anchor);
    assert.deepEqual(fromRenderer, fromDialog, `${label} fields differ`);
    assert.ok(fromDialog.length >= 5, `${label} fields not found`);
  }
  assert.deepEqual(
    mapFields(dialog, /entries: entries\.map\(\(entry\) => \(/u),
    ["id", "name", "aliases", "type", "version"],
  );
  assert.deepEqual(
    mapFields(
      dialog,
      /\(await listCodexRelations\(projectId\)\)\.map\(\(row\) => \(/u,
    ),
    [
      "id",
      "fromCodexId",
      "toCodexId",
      "relationType",
      "directionality",
      "label",
      "inverseLabel",
      "semanticKey",
      "version",
    ],
  );
  // directionality の変換も同じ。
  const directionality =
    'directionality: row.directionality === "symmetric" ? "symmetric" : "directed"';
  assert.ok(flat(dialog).includes(flat(directionality)));
  assert.ok(flat(renderer).includes(flat(directionality)));
  // start の引数名。
  const dialogStart = topLevelKeys(
    insideAfter(dialog, /await startCodexStructureExtraction\(/u, "{"),
  );
  const rendererStart = topLevelKeys(
    insideAfter(renderer, /await startCodexStructureExtraction\(/u, "{"),
  );
  // topLevelKeys は spread の中の key を拾わない。renderer の追加は spread 1 つ（skipNativePersist）だけであること。
  const rendererCall = insideAfter(
    renderer,
    /await startCodexStructureExtraction\(/u,
    "{",
  );
  assert.equal(rendererCall.match(/\.\.\./gu).length, 1);
  assert.ok(
    flat(rendererCall).includes(
      "...(input.persist?{}:{skipNativePersist:true}),",
    ),
  );
  assert.deepEqual(rendererStart, dialogStart);
  assert.ok(
    dialogStart.includes("useAi") && dialogStart.includes("existingRelations"),
  );
  assert.match(dialog, /useAi: false,/u);
  assert.match(renderer, /useAi: false,/u);
  // catalog の関数を製品から使う（写しでない）。
  assert.match(
    renderer,
    /import \{\s*buildCodexStructureCatalogs,\s*startCodexStructureExtraction,\s*\} from "@\/features\/codex\/codexStructureExtractionApi";/u,
  );
});

test("catalog の組み立て：製品は project の型の一覧に無い型の Entry を先頭の型に落とす。renderer は catalog を作った直後に、型が落ちていないかを止める assert で確かめる（F3b の m2）", () => {
  const api = product("codex/codexStructureExtractionApi.ts");
  // 落とし方（lib.test.mjs の fake が写す式）。製品が変わったら fake と assert を見直す。
  assert.ok(
    flat(api).includes(
      flat(
        'typeRef: typeRefBySlug.get(entry.type) ?? typeCatalog[0]?.ref ?? "T0001",',
      ),
    ),
    "製品の型の落とし方が変わった",
  );
  const renderer = tool("renderer.ts");
  const body = functionBody(renderer, "buildCatalogRequest");
  const iCatalogs = body.indexOf("buildCodexStructureCatalogs(");
  const iAssert = body.indexOf("assertEntryTypesInCatalog(");
  const iReturn = body.lastIndexOf("return {");
  assert.ok(iCatalogs > 0 && iAssert > iCatalogs && iReturn > iAssert);
  // assert には、DB から読んだ entries と、catalog の 2 つを加工せず渡す。
  assert.ok(
    flat(body).includes(
      flat(`assertEntryTypesInCatalog({
        entries: entries.map((entry) => ({ id: entry.id, type: entry.type })),
        existingCatalog: catalogs.existingCatalog,
        typeCatalog: catalogs.typeCatalog,
      });`),
    ),
  );
  assert.match(renderer, /assertEntryTypesInCatalog,\s*candidateKey,/u);
});

// ---- C9：型の slug -------------------------------------------------------------------------

test("型の slug：名簿の型 → Codex の型 → 製品の粗い型の対応が、一括承認の『結び先が人物』の前提と矛盾しない", () => {
  const entityBulkSafety = product("codex/extraction/entityBulkSafety.ts");
  const person = /export const PERSON_TYPE_SLUG = "([^"]+)";/u.exec(
    entityBulkSafety,
  );
  assert.ok(person, "PERSON_TYPE_SLUG not found");
  const api = product("codex/codexStructureExtractionApi.ts");
  const coarse = new Map(
    [
      ...insideAfter(api, /function coarseClassForSlug\(/u, "{").matchAll(
        /case "(\w+)":\s*return "(\w+)";/gu,
      ),
    ].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(Object.fromEntries(coarse), {
    character: "person",
    location: "place",
    item: "item",
    lore: "concept",
  });
  // 人物の型は character だけで、道具の名簿の character がそれに当たる。
  assert.equal(coarse.get(person[1]), "person");
  assert.equal(codexTypeOf("character"), person[1]);
  assert.equal(coarse.get(codexTypeOf("location")), "place");
  assert.equal(coarse.get(codexTypeOf("other")), "concept");
  // 人物以外の名簿の型は、製品の粗い型でも person にならない（typePersonOnNonCharacter の定義）。
  for (const rosterType of ["location", "other", "item", "lore"])
    assert.notEqual(coarse.get(codexTypeOf(rosterType)), "person");
  // 登録に使う slug が組み込みの型に実在する。
  const builtin = product("codex/typeApi.ts");
  for (const slug of new Set(
    ["character", "location", "lore"].map(codexTypeOf),
  ))
    assert.ok(builtin.includes(`slug: "${slug}"`), `builtin type ${slug}`);
});

// ---- C10・C11：B の handler と別名ボタン ---------------------------------------------------------

test("別名ボタン：製品は『AI が別名を勧め、かつ呼び名でない』ときだけ別名ボタンを出す。道具は製品の isRelationalTerm を使い、一覧を写さない", () => {
  const report = product("codex/CodexCandidatesReport.tsx");
  assert.match(
    report,
    /import \{ isRelationalTerm \} from "\.\/extraction\/relationalTerms";/u,
  );
  assert.ok(
    flat(report).includes(
      flat(`const relationalAliasSuppressed =
                  !!j?.aliasOfId && isRelationalTerm(c.surface);`),
    ),
    "relationalAliasSuppressed expression changed",
  );
  assert.ok(
    flat(report).includes(
      flat(`const aliasName =
                  j?.aliasOfId && !relationalAliasSuppressed
                    ? entries.find((e) => e.id === j.aliasOfId)?.name
                    : undefined;`),
    ),
    "aliasName expression changed",
  );
  // ボタンは aliasName があるときだけ。
  assert.match(
    report,
    /\{aliasName && \(\s*<button[\s\S]*?data-testid="codex-candidates-register-alias"/u,
  );
  // 呼び名の判定は 1 つの関数から。
  const relational = product("codex/extraction/relationalTerms.ts");
  assert.match(
    relational,
    /export function isRelationalTerm\(surface: string\): boolean \{\s*return relationalTermKind\(surface\) !== null;\s*\}/u,
  );
  // 道具の側：renderer が製品の関数で候補の行に旗を付け、judgmentMetrics・authorDecision は旗だけを見る。
  const renderer = tool("renderer.ts");
  assert.match(
    renderer,
    /import \{ isRelationalTerm \} from "@\/features\/codex\/extraction\/relationalTerms";/u,
  );
  assert.ok(
    renderer.includes("relationalTerm: isRelationalTerm(c.surface),"),
    "renderer does not flag candidates",
  );
  assert.ok(renderer.includes("if (isRelationalTerm(surface)) {"));
  const core = tool("measure-b-core.mjs");
  assert.ok(core.includes("candidate.relationalTerm === true"));
  assert.ok(!/KINSHIP|SECOND_PERSON|THIRD_PERSON/u.test(core + renderer));
});

test("bApply：別名の重複の条件・追記の形・却下の保存は、製品の handler（handleRegisterAlias・handleDismiss）と同じ", () => {
  const report = product("codex/CodexCandidatesReport.tsx");
  const renderer = tool("renderer.ts");
  const apply = flat(functionBody(renderer, "bApply"));
  const alias = flat(
    insideAfter(report, /const handleRegisterAlias = useCallback\(/u, "("),
  );
  // 重複：名前または別名に同じ正規化キーが有る。
  assert.ok(alias.includes('candidateKey(target.name??"")===key'));
  assert.ok(alias.includes("aliases.some((a)=>candidateKey(a)===key)"));
  assert.ok(apply.includes('productCandidateKey(target.name??"")===key'));
  assert.ok(apply.includes("aliases.some((x)=>productCandidateKey(x)===key)"));
  // 追記：既存の別名の後ろに表記を足し、JSON で aliases に書く。parseAliases は製品の関数。
  assert.ok(alias.includes("aliases:JSON.stringify([...aliases,c.surface])"));
  assert.ok(apply.includes("aliases:JSON.stringify([...aliases,surface])"));
  assert.ok(alias.includes("constaliases=parseAliases(target.aliases);"));
  assert.ok(apply.includes("constaliases=parseAliases(target.aliases);"));
  // 却下：却下キー集合に candidateKey(surface) を足し、集合ごと保存する。
  const dismiss = flat(
    insideAfter(report, /const handleDismiss = useCallback\(/u, "("),
  );
  assert.ok(dismiss.includes("next.add(candidateKey(surface));"));
  assert.ok(apply.includes("dismissed.add(productCandidateKey(surface));"));
  assert.ok(
    apply.includes("saveDismissedCandidateKeys(a.projectId,dismissed)"),
  );
  assert.ok(
    flat(report).includes("saveDismissedCandidateKeys(pid,value)"),
    "product persists dismissals with saveDismissedCandidateKeys",
  );
});

// ---- C12：候補の active／visible ------------------------------------------------------------

test("候補の active／visible：renderer は製品の activeCandidates と却下の読み書きを import し、visible の式も同じ", () => {
  const report = flat(product("codex/CodexCandidatesReport.tsx"));
  const renderer = tool("renderer.ts");
  assert.match(
    renderer,
    /import \{\s*activeCandidates,\s*candidateKey as productCandidateKey,\s*\} from "@\/features\/codex\/codexCandidates";/u,
  );
  assert.match(
    renderer,
    /import \{\s*loadDismissedCandidateKeys,\s*saveDismissedCandidateKeys,\s*\} from "@\/features\/codex\/codexCandidateDismissals";/u,
  );
  const normalized = flat(renderer).replaceAll(
    "productCandidateKey(",
    "candidateKey(",
  );
  assert.ok(
    report.includes(
      "active.filter((c)=>!dismissed.has(candidateKey(c.surface)))",
    ),
  );
  assert.ok(
    normalized.includes(
      "active.filter((c)=>!dismissed.has(candidateKey(c.surface)),)",
    ),
    "renderer visible expression changed",
  );
  assert.ok(report.includes("activeCandidates(candidates,entries)"));
  assert.ok(normalized.includes("activeCandidates(raw,entries)"));
});

// ---- C15：照合 method の語彙 ----------------------------------------------------------------

test("照合 method：道具が分類に使う method の語彙は製品の型に有り、製品に増えた method は『other』になる（増えたら落ちて気づく）", () => {
  const hypothesis = product(
    "narrative-extraction/ir/inferences/codexEntityHypothesis.ts",
  );
  const union = /export type EntityBindingMatchMethod =([\s\S]*?);/u.exec(
    hypothesis,
  );
  assert.ok(union, "EntityBindingMatchMethod not found");
  const methods = [...union[1].matchAll(/"([\w-]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(methods, [
    "exact-name",
    "exact-alias",
    "explicit-identity",
    "honorific-strip",
    "prefix",
    "substring",
    "embedding",
  ]);
  const reasonOf = (method) => unresolvedReason([{ methods: [method] }]);
  assert.equal(reasonOf("exact-name"), "exact-multiple");
  assert.equal(reasonOf("exact-alias"), "exact-multiple");
  assert.equal(reasonOf("explicit-identity"), "exact-multiple");
  assert.equal(reasonOf("honorific-strip"), "honorific-strip");
  assert.equal(reasonOf("prefix"), "prefix");
  assert.equal(reasonOf("substring"), "substring");
  // embedding は AI なしの照合では出ない。道具は other にまとめる。
  assert.equal(reasonOf("embedding"), "other");
  // 製品の照合が出す method の綴りは matcher の push と同じ（道具の method の写しの出どころ）。
  const matcher = product("codex/extraction/existingEntityMatcher.ts");
  const pushed = new Set(
    [...matcher.matchAll(/methods\.push\("([\w-]+)"\)/gu)].map((m) => m[1]),
  );
  assert.deepEqual([...pushed].sort(), [
    "exact-alias",
    "exact-name",
    "honorific-strip",
    "prefix",
    "substring",
  ]);
  // 注釈の score floor（lib.mjs）は製品の定数と同じ値。
  const floor =
    /export const EXISTING_ENTITY_CANDIDATE_SCORE_FLOOR = (\d+);/u.exec(
      matcher,
    );
  assert.ok(floor, "score floor not found");
  assert.ok(tool("lib.mjs").includes(`score floor ${floor[1]}`));
});

// ---- C16：B の型・surface 名 ----------------------------------------------------------------

test("B の型と surface：suggestedType の 4 種を道具の typeMatches が扱い、判定の surface・pathId は codex_judgment のまま", () => {
  const judgment = product("codex/candidateJudgment.ts");
  const union = /export type SuggestedType =([^;]+);/u.exec(judgment);
  assert.ok(union, "SuggestedType not found");
  const types = [...union[1].matchAll(/"(\w+)"/gu)].map((m) => m[1]);
  assert.deepEqual(types, ["character", "location", "item", "lore"]);
  const expected = {
    character: ["character"],
    location: ["location"],
    other: ["item", "lore"],
  };
  for (const [rosterType, allowed] of Object.entries(expected))
    for (const type of types)
      assert.equal(
        typeMatches(rosterType, type),
        allowed.includes(type),
        `${rosterType} vs ${type}`,
      );
  assert.equal(CODEX_JUDGMENT, "codex_judgment");
  assert.ok(judgment.includes('pathId: "codex_judgment",'));
  assert.ok(judgment.includes('surface: "codex_judgment",'));
  assert.ok(judgment.includes('resolveRoleSendOverride("codex_judgment")'));
  assert.ok(
    product("ai-usage/recordAiUsage.ts").includes('| "codex_judgment"'),
  );
});

// ---- 保存済みの未 review の提案の件数（問い 4）-----------------------------------------------

const unionOf = (source, name) => {
  const match = new RegExp(`export type ${name} =([^;]+);`, "u").exec(source);
  assert.ok(match, `${name} not found`);
  return [...match[1].matchAll(/"([\w-]+)"/gu)].map((m) => m[1]);
};
const repoFile = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

test("保存済みの提案：kind・status・run の状態の語と、読む command・上限は製品と同じ", () => {
  const api = product("codex/codexStructureExtractionApi.ts");
  // kind：saveProposalSet が保存する 4 種の定数の値と、projection の件数の欄。
  const constants = {
    "codex.entity.bind": [
      "narrative-extraction/proposals/bindCodexEntityProposal.ts",
      "CODEX_ENTITY_BIND_PROPOSAL_KIND",
    ],
    "codex.relation.create": [
      "narrative-extraction/proposals/createCodexRelationProposal.ts",
      "CODEX_RELATION_CREATE_PROPOSAL_KIND",
    ],
    "codex.detail.base.set": [
      "narrative-extraction/proposals/setCodexBaseDetailProposal.ts",
      "CODEX_BASE_DETAIL_SET_PROPOSAL_KIND",
    ],
    "codex.phase.bind": [
      "narrative-extraction/proposals/bindCodexPhaseProposal.ts",
      "CODEX_PHASE_BIND_PROPOSAL_KIND",
    ],
  };
  assert.deepEqual(
    Object.keys(STORED_PROPOSAL_KIND_FIELDS).sort(),
    Object.keys(constants).sort(),
  );
  for (const [kind, [file, name]] of Object.entries(constants)) {
    assert.match(
      product(file),
      new RegExp(
        `export const ${name} =\\s*"${kind.replaceAll(".", "\\.")}"`,
        "u",
      ),
      name,
    );
    // saveProposalSet の proposals に載る（kind: 定数）。
    assert.ok(api.includes(`kind: ${name},`), `${name} not saved`);
  }
  // 道具が件数を突き合わせる projection の欄（renderer の entityProposalCount など）。
  const renderer = tool("renderer.ts");
  const fields = {
    entityProposalCount: "proposals",
    relationProposalCount: "relationProposals",
    baseDetailProposalCount: "baseDetailProposals",
    phaseProposalCount: "phaseProposals",
  };
  assert.deepEqual(
    Object.values(STORED_PROPOSAL_KIND_FIELDS).sort(),
    Object.keys(fields).sort(),
  );
  for (const [field, list] of Object.entries(fields))
    assert.ok(renderer.includes(`${field}: projection.${list}.length,`), field);
  // status の語（未 review ＝ "unreviewed"）と run・ProposalSet の状態。
  const types = repoFile("src/features/narrative-extraction/runtime/types.ts");
  assert.deepEqual(
    [...STORED_PROPOSAL_STATUSES],
    unionOf(types, "NarrativeProposalStatus"),
  );
  assert.ok(STORED_PROPOSAL_STATUSES.includes("unreviewed"));
  assert.deepEqual(
    [...STORED_RUN_STATUSES],
    unionOf(types, "NarrativeExtractionRunStatus"),
  );
  assert.match(
    types,
    /interface NarrativeProposalSet \{[^}]*readonly status: "draft" \| "published" \| "superseded";/u,
  );
  assert.deepEqual(
    [...STORED_SET_STATUSES],
    ["draft", "published", "superseded"],
  );
  // 列挙の surface と上限（Native は 1〜100 に収める）。
  assert.ok(
    api.includes(
      'export const CODEX_STRUCTURE_EXTRACT_SURFACE_PATH =\n  "codex/structure-extract" as const;',
    ),
  );
  const rust = repoFile(
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
  );
  assert.ok(rust.includes("payload.limit.unwrap_or(20).clamp(1, 100)"));
  assert.equal(STORED_RUN_LIST_LIMIT, 100);
});

test("保存済みの提案：renderer は製品の read-only の command だけを生の nativeApi で呼び、restore・warm store・書き込みは使わない", () => {
  const renderer = tool("renderer.ts");
  const start = renderer.indexOf("async function readStoredProposals()");
  assert.ok(start > 0, "readStoredProposals not found");
  const end = renderer.indexOf("Object.assign(window", start);
  const body = renderer.slice(start, end);
  for (const name of [
    "narrativeExtractionListResumableRuns",
    "narrativeExtractionGetRunReviewBundle",
    "narrativeExtractionGetRun",
  ])
    assert.ok(body.includes(`${name}(`), name);
  // 製品の restore（warm store の早期 return・limit 8・失敗を握りつぶす fallback）と、書き込みの command は使わない。
  for (const banned of [
    "restoreCodexStructureExtractionReview",
    "getCodexStructureExtractionReview",
    "listResumableRuns(",
    "appendDecision",
    "AppendHumanDecision",
    "saveProposalSet",
    "cancelRun",
    "CancelRun",
  ])
    assert.ok(!body.includes(banned), banned);
  // 3 つの nativeApi は製品の read-only の command に束ねられている。
  const native = repoFile("src/application/narrative-extraction/nativeApi.ts");
  for (const [fn, command] of [
    [
      "narrativeExtractionListResumableRuns",
      "narrative_extraction_list_resumable_runs",
    ],
    [
      "narrativeExtractionGetRunReviewBundle",
      "narrative_extraction_get_run_review_bundle",
    ],
    ["narrativeExtractionGetRun", "narrative_extraction_get_run"],
  ]) {
    const at = native.indexOf(`export async function ${fn}(`);
    assert.ok(at > 0, fn);
    assert.ok(native.slice(at, at + 400).includes(`"${command}"`), command);
  }
  // 読む run は製品の列挙と、道具が保存した run の控え（前の段も）の和集合（planStoredRuns）。
  assert.ok(body.includes("planStoredRuns({"));
  assert.ok(body.includes("trackedIds: persistedRunIds"));
  assert.ok(body.includes("failedIds: unadoptedRunIds"));
  // 件数は保存した run の控えから「今回の run」を決める。persist:true のときだけ、段が成功したら採用した run の
  // 控え（persistedRunIds）に、run を作った後で段が失敗したら採用しなかった run の控え（unadoptedRunIds）に入れる。
  const wrapperStart = renderer.indexOf(
    "async function extractStructure(input",
  );
  assert.ok(wrapperStart > 0, "extractStructure wrapper not found");
  const wrapper = renderer.slice(
    wrapperStart,
    renderer.indexOf("async function extractStructureBody(", wrapperStart),
  );
  assert.match(
    wrapper,
    /const result = await extractStructureBody\(input, started\);\s*if \(input\.persist && started\.runId !== undefined\)\s*persistedRunIds\.push\(started\.runId\);\s*return result;/u,
  );
  assert.match(
    wrapper,
    /catch \(error\) \{\s*if \(input\.persist && started\.runId !== undefined\)\s*unadoptedRunIds\.push\(started\.runId\);\s*throw error;/u,
  );
  // run を作った直後に id を渡す（その後の throw でも失敗した run を控えられる）。
  assert.ok(renderer.includes("started.runId = projection.runId;"));
});

test("保存済みの提案：作者に見える run（製品の restore）の写しと、未 review の定義は製品の画面と同じ status", () => {
  // restore は列挙の先頭 8 件（folder ごとに最初に復元できた run 1 つ）を出す。再開できる run の状態は 3 つ。
  const api = product("codex/codexStructureExtractionApi.ts");
  const restoreStart = api.indexOf(
    "export async function restoreCodexStructureExtractionReview(",
  );
  assert.ok(restoreStart > 0, "restore not found");
  const restore = api.slice(restoreStart, restoreStart + 2400);
  assert.match(
    restore,
    /listResumableRuns\(\{[^}]*surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,\s*limit: 8,/u,
  );
  assert.equal(STORED_RESTORE_LIST_LIMIT, 8);
  assert.match(
    restore,
    /candidateFolder !== null && candidateFolder !== scope\.folderId/u,
  );
  const repo = repoFile(
    "src/application/narrative-extraction/runRepository.ts",
  );
  assert.match(
    repo,
    /const RESUMABLE_RUN_STATUSES = new Set<NarrativeExtractionRunStatus>\(\[\s*"pending",\s*"running",\s*"completed",\s*\]\);/u,
  );
  assert.deepEqual(
    [...STORED_RESUMABLE_RUN_STATUSES],
    ["pending", "running", "completed"],
  );
  // 製品の画面の「未 review」は提案ごとの status === "unreviewed"（一括承認の対象も、同じ status を要る）。
  assert.match(
    product("codex/CodexEntityProposalReview.tsx"),
    /proposal\.applicability === "applicable" &&\s*proposal\.status === "unreviewed" &&/u,
  );
  // 作者に見える run の folder は、run の scope の folderId（文字列）。道具も同じ読みで、同じ get_run の応答を使う
  // （製品の runRepository.getRun は narrativeExtractionGetRun の薄い包みで、restore は run.scopeJson を読む）。
  assert.match(
    api,
    /function folderIdFromScopeJson\(scopeJson: unknown\): string \| null \{\s*if \(!scopeJson \|\| typeof scopeJson !== "object"\) return null;\s*const folderId = \(scopeJson as Record<string, unknown>\)\.folderId;\s*return typeof folderId === "string" \? folderId : null;/u,
  );
  assert.match(restore, /folderIdFromScopeJson\(candidate\.run\.scopeJson\)/u);
  assert.match(
    repo,
    /export async function getRun\([^)]*\): Promise<NarrativeExtractionRunProjection> \{\s*const payload: RunRefPayload = \{ runId, projectId \};\s*return narrativeExtractionGetRun\(payload\);/u,
  );
  const renderer = tool("renderer.ts");
  assert.match(
    renderer,
    /const scope = projection\.run\.scopeJson as Record<string, unknown> \| null;\s*const folderId = scope && typeof scope === "object" \? scope\.folderId : null;[\s\S]*?folderKey: typeof folderId === "string" \? folderId : null,/u,
  );
  // 復元した entity の提案の status は、保存した提案の status（DB）と同じ値。道具の読みと同じ集合。
  for (const name of [
    "rebuildEntityFromNative",
    "rebuildRelationFromNative",
    "rebuildBaseDetailFromNative",
    "rebuildPhaseFromNative",
  ])
    assert.match(
      functionBody(api, name),
      /status: args\.native\.status,/u,
      name,
    );
});

test("renderer：prepass が complete なのに seed と提案の突合が成り立たなければ止める（throw の条件と突合の入力を固定する）", () => {
  const renderer = tool("renderer.ts");
  assert.match(
    renderer,
    /if \(\s*observedSeeds\.prepass\.status === "complete" &&\s*!seedReconciliation\.ok\s*\) \{\s*throw new Error\(\s*`\[artifact\] SEED_PROPOSAL_SET_DIFFERS /u,
  );
  // 突合の入力：seed ＝ 独立に読んだ seed、提案 ＝ projection の行、落とした表記 ＝ 製品が projection に残した 2 つ。
  assert.match(
    renderer,
    /reconcileSeedsWithProposals\(\{\s*seedHashes: await Promise\.all\(\s*observedSeeds\.mapped\.map\(\(m\) => hashSurface\(m\.surface\)\),\s*\),\s*proposalHashes: rows\.map\(\(r\) => r\.surfaceHash\),\s*droppedRelationalHashes: await Promise\.all\(\s*skippedRelational\.map\(\(t\) => hashSurface\(t\.surface\)\),\s*\),\s*droppedDismissedHashes: await Promise\.all\(\s*foldedDismissed\.map\(\(t\) => hashSurface\(t\.surface\)\),\s*\),/u,
  );
});

// ---- F2：送る前の guard（役割の上書き・名簿の hidden）の写しと製品の照合 ------------------------

test("役割の上書き：codex_judgment は structured ロールで、役割の設定の既定は空・{}。道具の guard は製品が送信時に使う関数と全設定を見る", () => {
  const routing = product("chat/modelRouting.ts");
  assert.match(routing, /codex_judgment: "structured",/u);
  assert.match(
    routing,
    /export const ROLE_PROVIDERS_KEY = "aiModel\.roleProviders";/u,
  );
  assert.match(routing, /return `aiModel\.role\.\$\{role\}`;/u);
  // 役割は 7 つ（道具は 7 以上を確かめる。製品が増やしたら、guard の見る範囲は MODEL_ROLES に従って広がる）。
  const roles =
    /export const MODEL_ROLES: readonly ModelRole\[\] = \[([^\]]+)\]/u.exec(
      routing,
    );
  assert.ok(roles);
  assert.equal([...roles[1].matchAll(/"(\w+)"/gu)].length, 7);
  // 製品の既定：役割の設定はすべて空、roleProviders は {}。
  const types = product("settings/types.ts");
  for (const role of [
    "conversation",
    "agent",
    "inline",
    "cheap",
    "structured",
    "review",
    "reader",
  ])
    assert.match(
      types,
      new RegExp(`"aiModel\\.role\\.${role}": "",`, "u"),
      role,
    );
  assert.match(types, /"aiModel\.roleProviders": "\{\}",/u);
  // 製品の送信は、同じ resolveRoleSendOverride を呼び、その 4 欄を送信に渡す。
  const judgment = product("codex/candidateJudgment.ts");
  assert.ok(judgment.includes('resolveRoleSendOverride("codex_judgment")'));
  for (const field of [
    "ov.apiVariant",
    "ov.model",
    "ov.provider",
    "ov.endpointId",
  ])
    assert.ok(judgment.includes(field), field);
  // 道具の page 側の guard：3 層の保存先を read-only に読み、live の store と、製品の送信と同じ関数の 4 欄を見る。
  const renderer = tool("renderer.ts");
  const guard = functionBody(renderer, "bAssertRoleDefaults");
  assert.match(guard, /prepareSettingsHydration\(a\.projectId\)/u);
  assert.match(
    guard,
    /snapshot\.layers\.legacy,\s*snapshot\.layers\.project,\s*snapshot\.layers\.global,/u,
  );
  assert.match(guard, /for \(const role of MODEL_ROLES\)/u);
  assert.match(guard, /rawOf\(ROLE_PROVIDERS_KEY\)/u);
  assert.match(guard, /resolveRoleSendOverride\("codex_judgment"\)/u);
  assert.match(
    guard,
    /override\.model === null &&\s*override\.provider === null &&\s*override\.apiVariant === null &&\s*override\.endpointId === null/u,
  );
  // 読む関数は製品の read-only の経路（store に書かない）。
  const store = product("settings/settingsStore.ts");
  const prepare = functionBody(store, "prepareSettingsHydration");
  assert.match(prepare, /api\.getSettingsByPrefix\(""\)/u);
  assert.ok(!/\.set\(|setSetting|patch\(/u.test(prepare));
});

test("名簿の hidden：製品の判定（listCodexIdsHiddenFromAi＝resolveCodexForAi の hidden）を、judgeCandidates に渡る Entry と同じ列挙に掛ける", () => {
  const hidden = product("codex/context/codexHiddenFromAi.ts");
  const listIds = functionBody(hidden, "listCodexIdsHiddenFromAi");
  assert.match(
    listIds,
    /return \(await resolveCodexForAi\(input\)\)\.hidden;/u,
  );
  // 判定は DB に無い id・不明な mode を hidden に数え、失敗は throw（握りつぶす visibleCodexForAi は使わない）。
  assert.match(
    hidden,
    /for \(const id of ids\) if \(!found\.has\(id\)\) hidden\.add\(id\);/u,
  );
  const renderer = tool("renderer.ts");
  assert.ok(!/visibleCodexForAi|visibleCodexIdsForAi/u.test(renderer));
  const guard = functionBody(renderer, "bAssertRosterNotHidden");
  assert.match(guard, /listCodexEntries\(a\.projectId\)/u);
  assert.match(
    guard,
    /countHiddenAmong\(\s*a\.projectId,\s*entries\.map\(\(entry\) => entry\.id\),\s*\)/u,
  );
  assert.match(
    functionBody(renderer, "countHiddenAmong"),
    /listCodexIdsHiddenFromAi\(\{\s*entryIds: unique,\s*projectId,\s*\}\)/u,
  );
  // judgeCandidates に渡る Entry（bRefresh の entries）は、同じ listCodexEntries(projectId)。
  assert.match(
    functionBody(renderer, "bRefresh"),
    /const entries = await listCodexEntries\(a\.projectId\);/u,
  );
});

test("送信の直前の guard：bJudge は guard を runGuardedJudge に渡し、judgeCandidates はその judge の中だけで呼ぶ（順序・止め方は lib.test の fake の試験）", () => {
  const renderer = tool("renderer.ts");
  const judge = functionBody(renderer, "bJudge");
  assert.match(judge, /return runGuardedJudge\(\{/u);
  assert.match(judge, /assertRoleDefaults: bAssertRoleDefaults,/u);
  assert.match(judge, /sendArmed,/u);
  assert.match(judge, /visibleCount: b\.visible\.length,/u);
  // hidden の確認は送る窓（先頭 JUDGMENT_MAX_ENTRIES 件）の Entry に、製品の hidden 判定（countHiddenAmong）で掛ける。
  assert.match(judge, /countHiddenInSentWindow: async \(\) =>/u);
  assert.match(judge, /countHiddenAmong\(/u);
  assert.match(judge, /b\.entries\s*\.slice\(0, JUDGMENT_MAX_ENTRIES\)/u);
  // judgeCandidates を呼ぶのは renderer 全体で 1 か所（bJudge の judge の中）だけ。guard の関数の外で送れない。
  assert.equal([...renderer.matchAll(/\bawait judgeCandidates\(/gu)].length, 1);
  const judgeStart = judge.indexOf("judge: async () => {");
  assert.ok(
    judgeStart > 0 && judge.indexOf("await judgeCandidates(") > judgeStart,
  );
  // runGuardedJudge は lib.mjs から読む（page で動く純関数）。
  assert.match(renderer, /runGuardedJudge,\s*seedMissingFromCandidates/u);
  // page に出す関数と、node が呼ぶ名前が揃っている。
  assert.match(
    renderer,
    /bAssertRoleDefaults,\s*bAssertRosterNotHidden,\s*bJudge,/u,
  );
  const runner = tool("run-measure-b.mjs");
  assert.ok(runner.includes("window.identityLoad.bAssertRoleDefaults()"));
  assert.ok(runner.includes("window.identityLoad.bAssertRosterNotHidden()"));
  // 道具が登録する Codex 項目は contextMode を渡さない（製品の既定のまま。hidden の判定が実 DB で確かめる）。
  const register = functionBody(renderer, "registerRoster");
  assert.ok(!/contextMode/u.test(register));
});

test("ルビ：道具が作る本文は text と ruby の node だけで、候補・文脈の見積りは製品の抽出（IPC）の出力と製品の prompt 関数から作る", () => {
  const renderer = tool("renderer.ts");
  // 本文は製品の取り込みと同じ変換。mention・画像の node は作らない。
  assert.match(renderer, /JSON\.parse\(kakuyomuBodyToProseMirror\(text\)\)/u);
  assert.ok(!/type: "mention"|type: "image"/u.test(renderer));
  // 見積り（bEstimate）の文脈は、IPC extract_codex_candidates の候補の context。道具は本文を再構成しない。
  const estimate = functionBody(renderer, "bEstimate");
  assert.match(estimate, /context: c\.context/u);
  assert.match(estimate, /b\.visible\.slice\(0, JUDGMENT_MAX_CANDIDATES\)/u);
  assert.match(
    functionBody(renderer, "bRefresh"),
    /invoke\("extract_codex_candidates", \{\s*projectId: a\.projectId,\s*minCount: null,\s*\}\)/u,
  );
});

test("page の guard が呼ぶ IPC は AI・外部通信の command に当たらない（読むのは db_execute と get_global_settings だけ）", () => {
  // 設定の 3 層の読みと hidden の判定・Entry の列挙は、製品の source で db（drizzle の sqlite-proxy＝db_execute）か
  // get_global_settings だけを呼ぶ。測定 B の realCellStatus は AI command を許可した 3 本以外は不採用にするので、当たれば課金済みの cell が落ちる。
  const client = readFileSync(path.join(ROOT, "src/db/client.ts"), "utf8");
  assert.deepEqual(
    [...client.matchAll(/invoke<[^>]*>\("(\w+)"/gu)].map((m) => m[1]),
    ["db_execute"],
  );
  const settingsApi = product("settings/api.ts");
  for (const name of ["getSettingsByPrefix", "getAllProjectSettings"]) {
    const body = functionBody(settingsApi, name);
    assert.match(body, /await db\s*\.select\(\)/u, name);
    assert.ok(!/invoke\(/u.test(body), name);
  }
  const repository = readFileSync(
    path.join(ROOT, "src/lib/globalSettings/repository.ts"),
    "utf8",
  );
  assert.match(
    repository,
    /read: \(\) => invoke<GlobalSettings>\("get_global_settings"\),/u,
  );
  for (const name of ["listPhasesByEntryIds"])
    assert.ok(
      !/invoke\(/u.test(functionBody(product("codex/phaseApi.ts"), name)),
      name,
    );
  const hidden = product("codex/context/codexHiddenFromAi.ts");
  assert.ok(!/invoke\(/u.test(hidden));
  // 道具の guard 3 関数は、自分では IPC を呼ばない（製品の読みの関数だけ）。
  const renderer = tool("renderer.ts");
  for (const name of [
    "bAssertRoleDefaults",
    "countHiddenAmong",
    "bAssertRosterNotHidden",
  ])
    assert.ok(!/\binvoke\(/u.test(functionBody(renderer, name)), name);
  assert.deepEqual(findAiCommands(["db_execute", "get_global_settings"]), []);
  // listCodexEntries（bRefresh も使う Entry の列挙）は、読みの command だけ。
  const codexApi = product("codex/api.ts");
  assert.ok(!/\binvoke\(/u.test(functionBody(codexApi, "listCodexEntries")));
});

test("F5 M-a：judgeCandidates は出力の上限を渡さず、native の既定の max_tokens（claude-sonnet-5-5 は 32,000）が費用の最悪値の元。製品の値が変われば落ちる", async () => {
  const { NATIVE_DEFAULT_MAX_OUTPUT_TOKENS } = await import("./ledger.mjs");
  // judgeCandidates の sendChatMessageWithThinking の呼び出しは、出力上限の引数（requestMaxOutputTokens）を渡さない：
  // 引数は 9 個（messages・auditContext・thinkingParams・systemCacheSegments・apiVariant・systemVolatileTail・model・provider・endpointId）まで。
  const judgment = product("codex/candidateJudgment.ts");
  const call = judgment.indexOf(
    "sendChatMessageWithThinking(",
    judgment.indexOf("resolveRoleSendOverride"),
  );
  assert.ok(call > 0);
  const args = inside(judgment, judgment.indexOf("(", call));
  assert.ok(!/requestMaxOutputTokens|maxOutputTokens|max_tokens/iu.test(args));
  assert.ok(args.includes("ov.endpointId"));
  assert.ok(
    !/ov\.endpointId,\s*[^\s)]/u.test(args),
    "endpointId の後に引数が足されていない",
  );
  // 出力上限が未指定のとき、native は effective_request_max_output_tokens の既定を使う。Anthropic で thinking を常に有効にする世代
  // （sonnet-5 以降）の既定は 32,000（それ以外は 4096）。
  const rust = repoFile("src-tauri/crates/grimodex-ai/src/lib.rs");
  const fn = rust.indexOf("pub fn effective_request_max_output_tokens(");
  assert.ok(fn > 0);
  const body = inside(rust, rust.indexOf("{", fn));
  const anthropic = body.slice(body.indexOf("AiProvider::Anthropic"));
  const match =
    /anthropic_model_thinking_always_on\(params\.model\)\s*\{\s*([0-9_]+)\s*\}\s*else\s*\{\s*([0-9_]+)\s*\}/u.exec(
      anthropic,
    );
  assert.ok(match, "Anthropic の既定の max_tokens の分岐が見つからない");
  assert.equal(
    Number(match[1].replaceAll("_", "")),
    NATIVE_DEFAULT_MAX_OUTPUT_TOKENS,
  );
  assert.equal(Number(match[2].replaceAll("_", "")), 4096);
  // 世代 5 以降の sonnet は thinking を常に有効にする世代。
  const always = rust.slice(
    rust.indexOf("fn anthropic_model_thinking_always_on("),
    rust.indexOf("pub fn effective_request_max_output_tokens("),
  );
  assert.ok(/"sonnet-"/u.test(always) && /major >= 5/u.test(always));
  // 道具の測定の model は claude-sonnet-5-5。
  assert.match(tool("run-measure-b.mjs"), /MODEL = "claude-sonnet-5-5"/u);
});
