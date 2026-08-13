// extract_codex_candidates (Phase 3 Batch 4) の実 .node roundtrip。
//
// shared grimodex-semantic core が workspace DB を読み、UniDic 解析を DB lock 外で
// 実行して camelCase CodexCandidate[] を返す NAPI 境界を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-candidates-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    // On Windows the N-API finalizer releases the active SQLite handle after
    // JS exit listeners. The OS temp fixture is therefore best-effort only.
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

const backend = new Backend(join(root, "app-data"));
const workspace = join(root, "workspace");

function mutationIdentity(
  requestId,
  projectId = "default-project",
  origin = "human",
) {
  return {
    requestId,
    projectId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin,
    originalTransactionId: null,
    undoJournalId: null,
  };
}

async function exec(sql, params = [], method = "run") {
  return JSON.parse(await backend.dbExecute(sql, params, method)).rows;
}

function proseDoc(text) {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

test("workspace 未オープンは Tauri と同じエラーマーカーで reject する", async () => {
  await assert.rejects(
    backend.extractCodexCandidates("default-project", 2),
    /No workspace is open/,
  );
});

test("canonical source からの entity seed 抽出は workspace 非依存で実 .node を roundtrip する", async () => {
  const text = "🎉京都から京都へ。";
  const response = JSON.parse(
    await backend.extractCodexEntitySeeds({
      schemaVersion: 1,
      normalizerVersion: "gdx-canonical-text/1",
      language: "ja",
      minimumOccurrenceCount: 2,
      sources: [
        {
          sourceRef: "urn:gdx:opaque/source?window=1#根拠",
          documentRef: "doc:opaque",
          documentRange: { start: 7, end: 7 + text.length },
          text,
        },
      ],
    }),
  );

  assert.equal(response.schemaVersion, 1);
  const kyoto = response.seeds.find((seed) => seed.surface === "京都");
  assert.ok(kyoto, "京都 seed is returned through the N-API wire");
  assert.equal(kyoto.features.occurrenceCount, 2);
  assert.equal(kyoto.occurrences.length, 2);
  assert.equal(
    kyoto.occurrences[0].sourceRef,
    "urn:gdx:opaque/source?window=1#根拠",
  );
  assert.deepEqual(kyoto.occurrences[0].canonicalRange, {
    start: 9,
    end: 11,
  });
});

test("entity seed DTO は unknown field と lone surrogate を native 境界で拒否する", async () => {
  const baseRequest = {
    schemaVersion: 1,
    normalizerVersion: "gdx-canonical-text/1",
    language: "ja",
    minimumOccurrenceCount: 1,
    sources: [],
  };

  await assert.rejects(
    backend.extractCodexEntitySeeds({ ...baseRequest, unexpected: true }),
    /invalid request|unknown field/i,
  );
  await assert.rejects(
    backend.extractCodexEntitySeeds({ ...baseRequest, sources: {} }),
    /sources must be an array/i,
  );
  await assert.rejects(
    backend.extractCodexEntitySeeds({
      ...baseRequest,
      sources: [
        {
          sourceRef: "x".repeat(1025),
          documentRef: "doc:oversized-ref",
          documentRange: { start: 0, end: 0 },
          text: "",
        },
      ],
    }),
    /1024 UTF-8 bytes/i,
  );
  const oversizedText = "x".repeat(8 * 1024 * 1024 + 1);
  await assert.rejects(
    backend.extractCodexEntitySeeds({
      ...baseRequest,
      sources: [
        {
          sourceRef: "source:oversized-request",
          documentRef: "doc:oversized-request",
          documentRange: { start: 0, end: oversizedText.length },
          text: oversizedText,
        },
      ],
    }),
    /8 MiB wire budget/i,
  );
  await assert.rejects(
    backend.extractCodexEntitySeeds({
      ...baseRequest,
      sources: [
        {
          sourceRef: "source:lone-surrogate",
          documentRef: "doc:lone-surrogate",
          documentRange: { start: 0, end: 1 },
          text: "\uD800",
        },
      ],
    }),
    /lone surrogate|utf-?16|replacement character/i,
  );

  const replacementCharacter = JSON.parse(
    await backend.extractCodexEntitySeeds({
      ...baseRequest,
      language: "en",
      sources: [
        {
          sourceRef: "source:replacement-character",
          documentRef: "doc:replacement-character",
          documentRange: { start: 0, end: 1 },
          text: "�",
        },
      ],
    }),
  );
  assert.deepEqual(
    replacementCharacter.seeds,
    [],
    "a valid U+FFFD scalar is not confused with a lone surrogate",
  );
});

test("既知名を除外し、未知固有名詞を count/初出/context 付きで返す", async () => {
  await backend.openWorkspace(workspace);
  await backend.agentCodexCreate({
    ...mutationIdentity("fixture:known-tokyo", "default-project", "ai-apply"),
    requestId: "fixture:known-tokyo",
    entryId: "known-tokyo",
    projectId: "default-project",
    sessionId: "fixture:codex-candidates",
    surface: "manual",
    typeSlug: "character",
    name: "東京",
    aliases: "[]",
    authorshipSpans: [],
  });
  await backend.treeNodeCreate({
    ...mutationIdentity("fixture:scene-1"),
    id: "scene-1",
    projectId: "default-project",
    parentId: null,
    nodeType: "scene",
    title: "第一場",
    sortOrder: "a0",
    content: proseDoc("東京から京都へ行った。京都では雨が降った。"),
  });

  const candidates = JSON.parse(
    await backend.extractCodexCandidates("default-project", 2),
  );
  const kyoto = candidates.find((candidate) => candidate.surface === "京都");
  assert.ok(kyoto, "未知の固有名詞 京都 が候補に含まれる");
  assert.equal(typeof kyoto.lemma, "string");
  assert.ok(kyoto.lemma.length > 0, "UniDic 語彙素が入る");
  assert.equal(kyoto.count, 2);
  assert.equal(kyoto.firstSceneId, "scene-1");
  assert.match(kyoto.context, /京都/);
  assert.equal(
    candidates.some((candidate) => candidate.surface === "東京"),
    false,
    "既知 Codex 名は除外される",
  );
});

test("新 entity seed core から旧 CodexCandidate wire への投影は既存 command と一致する", async () => {
  const text = "東京から京都へ行った。京都では雨が降った。";
  const legacy = JSON.parse(
    await backend.extractCodexCandidates("default-project", 2),
  );
  const response = JSON.parse(
    await backend.extractCodexEntitySeeds({
      schemaVersion: 1,
      normalizerVersion: "gdx-canonical-text/1",
      language: "ja",
      minimumOccurrenceCount: 2,
      sources: [
        {
          sourceRef: "scene-1",
          documentRef: "doc:scene-1",
          documentRange: { start: 0, end: text.length },
          text,
        },
      ],
    }),
  );

  const legacyKyoto = legacy.find((candidate) => candidate.surface === "京都");
  const seedKyoto = response.seeds.find((seed) => seed.surface === "京都");
  assert.ok(legacyKyoto, "legacy command returns the existing 京都 candidate");
  assert.ok(seedKyoto, "new core returns the corresponding 京都 seed");
  assert.equal(seedKyoto.surface, legacyKyoto.surface);
  assert.equal(seedKyoto.features.occurrenceCount, legacyKyoto.count);
  assert.equal(seedKyoto.occurrences[0].sourceRef, legacyKyoto.firstSceneId);
  assert.match(legacyKyoto.context, new RegExp(seedKyoto.occurrences[0].quote));
});

test("非日本語 project は解析せず空配列を返す", async () => {
  await backend.scanStagingProjectCreate({
    id: "english-project",
    title: "English project",
    language: "en",
    createdAt: new Date().toISOString(),
  });
  const candidates = JSON.parse(
    await backend.extractCodexCandidates("english-project", undefined),
  );
  assert.deepEqual(candidates, []);
});
