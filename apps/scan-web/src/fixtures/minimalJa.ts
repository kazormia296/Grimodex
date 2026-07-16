import {
  buildEditorSeed,
  buildScanBundle,
  normalizeDocument,
} from "@grimodex/scan-core";
import type { EditorSeedV1, ScanBundleV1 } from "@grimodex/scan-contract";

export function createMinimalJaDocument() {
  return normalizeDocument({
    title: "灯台の手紙",
    language: "ja",
    text: "# 第一章 灯台\n\n葵は灯台の窓を開けた。\n\n白灯台には古い手紙が残っていた。",
  });
}

export function createMinimalJaBundle(): ScanBundleV1 {
  const document = createMinimalJaDocument();
  const firstParagraph = document.paragraphs[0];
  const secondParagraph = document.paragraphs[1];
  const section = document.sections[0];
  if (!firstParagraph || !secondParagraph || !section) {
    throw new Error("minimal fixture document is unexpectedly empty");
  }
  const firstEvidence = {
    sectionId: section.id,
    paragraphId: firstParagraph.id,
    sentenceIndex: 0,
    excerpt: firstParagraph.text,
  };
  const secondEvidence = {
    sectionId: section.id,
    paragraphId: secondParagraph.id,
    excerpt: secondParagraph.text,
  };
  const aoiId = "entity:11111111-1111-4111-8111-111111111111";
  const lighthouseId = "entity:22222222-2222-4222-8222-222222222222";
  return buildScanBundle({
    document,
    entities: [
      {
        id: aoiId,
        type: "character",
        name: "葵",
        aliases: ["アオイ"],
        summary: "灯台守の娘",
        evidence: [firstEvidence],
        confidence: 0.94,
      },
      {
        id: lighthouseId,
        type: "place",
        name: "白灯台",
        aliases: [],
        summary: "海辺の灯台",
        evidence: [secondEvidence],
        confidence: 0.91,
      },
    ],
    relations: [
      {
        id: "relation:33333333-3333-4333-8333-333333333333",
        fromEntityId: aoiId,
        toEntityId: lighthouseId,
        type: "located-at",
        label: "灯台で暮らす",
        confidence: 0.78,
        evidence: [secondEvidence],
      },
    ],
    phases: [
      {
        id: "phase:44444444-4444-4444-8444-444444444444",
        title: "手紙の発見",
        entityIds: [aoiId],
        anchors: [firstEvidence, secondEvidence],
        summary: "葵が古い手紙を見つける",
        confidence: 0.8,
      },
    ],
    events: [
      {
        id: "event:55555555-5555-4555-8555-555555555555",
        title: "手紙を見つける",
        summary: "白灯台で手紙を発見する",
        sectionId: section.id,
        paragraphIds: [secondParagraph.id],
        entityIds: [aoiId],
        order: 0,
        evidence: [secondEvidence],
      },
    ],
    findings: [
      {
        id: "finding:66666666-6666-4666-8666-666666666666",
        kind: "continuity",
        status: "candidate",
        title: "手紙の宛先は要確認",
        summary: "手紙の宛先が本文からは読み取れない",
        evidence: [secondEvidence],
      },
    ],
    summary: {
      premise: "灯台に残された手紙が親子の記憶をつなぐ。",
      genreCandidates: [
        { value: "短編ドラマ", confidence: 0.83, evidence: [firstEvidence] },
      ],
      themes: [],
      strengths: [
        {
          title: "舞台の焦点",
          summary: "灯台の描写が作品の軸になっている",
          evidence: [secondEvidence],
        },
      ],
      risks: [],
    },
    pipelineVersion: "fixture-1",
  });
}

export function createMinimalJaSeed(): EditorSeedV1 {
  const document = createMinimalJaDocument();
  return buildEditorSeed(createMinimalJaBundle(), document);
}
