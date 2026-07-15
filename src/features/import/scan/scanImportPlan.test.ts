import { describe, expect, it } from "vitest";
import {
  buildEditorSeed,
  buildScanBundle,
  normalizeDocument,
} from "@grimodex/scan-core";
import type { EditorSeedV1 } from "@grimodex/scan-contract";
import { buildScanImportPlan } from "./scanImportPlan";

function makeSeed(): EditorSeedV1 {
  const document = normalizeDocument({
    title: "灯台の手紙",
    language: "ja",
    text: "# 第一章\n\n葵は灯台へ向かった。\n\n# 第二章\n\n手紙を見つけた。",
  });
  const first = document.paragraphs[0]!;
  const second = document.paragraphs[1]!;
  const section = document.sections[0]!;
  const secondSection = document.sections[1]!;
  const evidence = {
    sectionId: section.id,
    paragraphId: first.id,
    sentenceIndex: 0,
    excerpt: first.text,
  };
  const secondEvidence = {
    sectionId: secondSection.id,
    paragraphId: second.id,
    excerpt: second.text,
  };
  const entityId = "entity:11111111-1111-4111-8111-111111111111";
  const bundle = buildScanBundle({
    document,
    entities: [
      {
        id: entityId,
        type: "character",
        name: "葵",
        aliases: ["アオイ"],
        summary: "主人公",
        evidence: [evidence],
        confidence: 0.9,
      },
    ],
    relations: [],
    phases: [
      {
        id: "phase:22222222-2222-4222-8222-222222222222",
        title: "旅立ち",
        entityIds: [entityId],
        anchors: [evidence],
        confidence: 0.8,
      },
    ],
    events: [
      {
        id: "event:33333333-3333-4333-8333-333333333333",
        title: "灯台へ向かう",
        sectionId: section.id,
        paragraphIds: [first.id],
        entityIds: [entityId],
        order: 0,
        evidence: [evidence],
      },
    ],
    findings: [
      {
        id: "finding:44444444-4444-4444-8444-444444444444",
        kind: "continuity",
        status: "candidate",
        title: "宛先",
        summary: "要確認",
        evidence: [secondEvidence],
      },
    ],
    pipelineVersion: "test",
  });
  return buildEditorSeed(bundle, document);
}

describe("buildScanImportPlan", () => {
  it("maps the private seed into explicit tree, codex, relation, phase, event and finding plans", () => {
    const plan = buildScanImportPlan(makeSeed());

    expect(plan.projectTitle).toBe("灯台の手紙");
    expect(plan.nodes).toHaveLength(2);
    const firstNode = plan.nodes[0];
    expect(firstNode?.kind).toBe("folder");
    if (!firstNode || firstNode.kind !== "folder")
      throw new Error("expected folder");
    expect(firstNode.children[0]).toMatchObject({
      kind: "scene",
      body: "葵は灯台へ向かった。",
    });
    expect(plan.codexEntries[0]).toMatchObject({
      type: "character",
      name: "葵",
      aliases: ["アオイ"],
    });
    expect(plan.phases[0]?.entityIds).toEqual([
      plan.idMap.entities["entity:11111111-1111-4111-8111-111111111111"],
    ]);
    expect(plan.events[0]?.sectionId).toBe(
      plan.idMap.sections[sectionIdFor(plan, 0)],
    );
    expect(plan.findings[0]?.status).toBe("candidate");
    expect(
      plan.idMap.entities["entity:11111111-1111-4111-8111-111111111111"],
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a seed whose bundle and source no longer agree before producing a plan", () => {
    const seed = makeSeed();
    const invalid = {
      ...seed,
      source: {
        ...seed.source,
        paragraphs: seed.source.paragraphs.map((paragraph, index) =>
          index === 0 ? { ...paragraph, text: "改変された本文" } : paragraph,
        ),
      },
    };

    expect(() => buildScanImportPlan(invalid)).toThrow(
      "Scan editor seed is invalid",
    );
  });
});

function sectionIdFor(
  plan: ReturnType<typeof buildScanImportPlan>,
  index: number,
): string {
  return Object.keys(plan.idMap.sections).sort((left, right) =>
    left.localeCompare(right),
  )[index]!;
}
