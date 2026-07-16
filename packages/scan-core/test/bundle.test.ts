import { describe, expect, it } from "vitest";
import {
  buildEditorSeed,
  buildScanBundle,
  buildPhases,
  mergeEvents,
  mergeEntities,
} from "../src/index.js";
import { parseEditorSeed } from "@grimodex/scan-contract";
import { normalizeDocument } from "../src/normalizeDocument.js";

describe("ScanBundle construction", () => {
  const document = normalizeDocument({
    title: "灯台",
    language: "ja",
    text: "# 第一章\n\n葵は灯台へ向かった。\n\n手紙が届いた。",
  });
  const evidence = {
    sectionId: document.sections[0]?.id ?? "",
    paragraphId: document.paragraphs[0]?.id ?? "",
  };

  it("resolves event participants and deduplicates repeated events", () => {
    const entities = mergeEntities([
      {
        type: "character",
        name: "葵",
        aliases: [],
        evidence: [evidence],
        confidence: 0.9,
      },
    ]);
    const events = mergeEvents(
      [
        {
          title: "灯台へ向かう",
          sectionId: evidence.sectionId,
          paragraphIds: [evidence.paragraphId],
          entityNames: ["葵"],
          evidence: [evidence],
          order: 0,
        },
        {
          title: "灯台へ向かう",
          sectionId: evidence.sectionId,
          paragraphIds: [evidence.paragraphId],
          entityNames: ["葵"],
          evidence: [evidence],
          order: 0,
        },
      ],
      entities.entities,
    );

    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.entityIds).toEqual([entities.entities[0]?.id]);
    expect(events.unresolved).toHaveLength(0);
  });

  it("builds a phase only when all entity names resolve", () => {
    const entities = mergeEntities([
      {
        type: "character",
        name: "葵",
        aliases: [],
        evidence: [evidence],
        confidence: 0.9,
      },
    ]);
    const phases = buildPhases(
      [
        {
          title: "発見",
          entityNames: ["葵"],
          anchors: [evidence],
          confidence: 0.8,
        },
      ],
      entities.entities,
    );

    expect(phases.phases).toHaveLength(1);
    expect(phases.unresolved).toHaveLength(0);
  });

  it("keeps ordered sentence anchors in the same paragraph valid", () => {
    const sentenceEvidence = [
      { ...evidence, sentenceIndex: 0 },
      { ...evidence, sentenceIndex: 1 },
    ];
    const entities = mergeEntities([
      {
        type: "character",
        name: "葵",
        aliases: [],
        evidence: [sentenceEvidence[0]!],
        confidence: 0.9,
      },
    ]);
    const phases = buildPhases(
      [
        {
          title: "発見",
          entityNames: ["葵"],
          anchors: sentenceEvidence,
          confidence: 0.8,
        },
      ],
      entities.entities,
    );

    expect(() =>
      buildScanBundle({
        document,
        entities: entities.entities,
        relations: [],
        phases: phases.phases,
        pipelineVersion: "test",
      }),
    ).not.toThrow();
  });

  it("creates a private editor seed that validates against the source paragraphs", () => {
    const entity = {
      id: "entity:11111111-1111-4111-8111-111111111111",
      type: "character" as const,
      name: "葵",
      aliases: [],
      evidence: [evidence],
      confidence: 0.9,
    };
    const bundle = buildScanBundle({
      document,
      entities: [entity],
      relations: [],
      phases: [],
      events: [],
      findings: [],
      pipelineVersion: "test",
    });
    const seed = buildEditorSeed(bundle, document);

    expect(parseEditorSeed(seed).ok).toBe(true);
  });

  it("accepts evidence for the second period-delimited English sentence", () => {
    const englishDocument = normalizeDocument({
      title: "Letters",
      language: "en",
      text: "# Chapter One\n\nAlice walks. Bob stops.",
    });
    const paragraph = englishDocument.paragraphs[0]!;
    const englishEvidence = {
      sectionId: paragraph.sectionId,
      paragraphId: paragraph.id,
      sentenceIndex: 1,
      excerpt: "Bob stops.",
    };
    const bundle = buildScanBundle({
      document: englishDocument,
      entities: [
        {
          id: "entity:11111111-1111-4111-8111-111111111111",
          type: "character",
          name: "Bob",
          aliases: [],
          evidence: [englishEvidence],
          confidence: 0.9,
        },
      ],
      relations: [],
      pipelineVersion: "test",
    });

    expect(() => buildEditorSeed(bundle, englishDocument)).not.toThrow();
  });
});
