import { describe, expect, it } from "vitest";
import {
  buildEditorSeed,
  buildScanBundle,
  normalizeDocument,
} from "@grimodex/scan-core";
import type { EditorSeedV1, ScanLanguage } from "@grimodex/scan-contract";
import {
  buildScanImportPlan,
  deriveScanImportId,
  rebuildScanImportPlan,
} from "./scanImportPlan";

function makeSeed(language: ScanLanguage = "ja"): EditorSeedV1 {
  const document = normalizeDocument({
    title: "灯台の手紙",
    language,
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

  it("scopes every generated ID to one import instance while preserving internal references", () => {
    const seed = makeSeed();
    const sourceEntityId = seed.bundle.entities[0]!.id;
    const sourceEventId = seed.bundle.events[0]!.id;
    const sourceRelationId = "relation:55555555-5555-4555-8555-555555555555";
    seed.bundle.relations.push({
      id: sourceRelationId,
      fromEntityId: sourceEntityId,
      toEntityId: sourceEntityId,
      type: "self",
      evidence: seed.bundle.entities[0]!.evidence,
      confidence: 0.7,
    });
    seed.bundle.findings[0]!.relatedEntityIds = [sourceEntityId];
    seed.bundle.findings[0]!.relatedEventIds = [sourceEventId];

    const first = buildScanImportPlan(seed, { importInstanceId: "import-a" });
    const repeated = buildScanImportPlan(seed, {
      importInstanceId: "import-a",
    });
    const second = buildScanImportPlan(seed, { importInstanceId: "import-b" });

    expect(first.idMap).toEqual(repeated.idMap);
    expect(
      deriveScanImportId(
        first.sourceFingerprint,
        "findings-note",
        "report",
        first.importInstanceId,
      ),
    ).not.toBe(
      deriveScanImportId(
        second.sourceFingerprint,
        "findings-note",
        "report",
        second.importInstanceId,
      ),
    );
    for (const namespace of Object.keys(first.idMap) as Array<
      keyof typeof first.idMap
    >) {
      for (const [sourceId, importedId] of Object.entries(
        first.idMap[namespace],
      )) {
        expect(second.idMap[namespace][sourceId]).not.toBe(importedId);
      }
    }

    const event = first.events[0]!;
    const folder = first.nodes.find(
      (node) => node.id === first.idMap.sections[event.sourceSectionId],
    );
    expect(folder?.kind).toBe("folder");
    if (!folder || folder.kind !== "folder") {
      throw new Error("expected event section folder");
    }
    const scene = folder.children[0];
    expect(scene?.kind).toBe("scene");
    expect(event.sceneId).toBe(scene?.id);
    expect(event.paragraphIds).toEqual(
      seed.bundle.events[0]!.paragraphIds.map(
        (paragraphId) => first.idMap.paragraphs[paragraphId],
      ),
    );
    expect(event.entityIds).toEqual([first.idMap.entities[sourceEntityId]]);
    expect(first.relations[0]).toMatchObject({
      id: first.idMap.relations[sourceRelationId],
      fromCodexId: first.idMap.entities[sourceEntityId],
      toCodexId: first.idMap.entities[sourceEntityId],
    });
    expect(first.phases[0]?.anchorNodeId).toBe(scene?.id);
    expect(first.phases[0]?.anchorNodeIds).toContain(scene?.id);
    expect(first.findings[0]?.relatedEntityIds).toEqual([
      first.idMap.entities[sourceEntityId],
    ]);
    expect(first.findings[0]?.relatedEventIds).toEqual([
      first.idMap.events[sourceEventId],
    ]);
  });

  it("rejects unsupported source languages instead of silently importing them as Japanese", () => {
    expect(() =>
      buildScanImportPlan(makeSeed("other"), {
        importInstanceId: "import-other",
      }),
    ).toThrow("unsupported language: other");
  });

  it("rebuilds a persisted plan with the original import instance IDs", () => {
    const seed = makeSeed();
    const persisted = buildScanImportPlan(seed, {
      importInstanceId: "browser-workspace-1",
    });

    const restored = rebuildScanImportPlan(seed, persisted);

    expect(restored.importInstanceId).toBe("browser-workspace-1");
    expect(restored.idMap).toEqual(persisted.idMap);
    expect(restored.nodes).toEqual(persisted.nodes);
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
