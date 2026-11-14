import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

beforeEach(() => {
  setCurrentWorkspaceIdentity({ path: "/w", openRevision: 1 });
});

afterEach(() => {
  setCurrentWorkspaceIdentity(null);
});

const buildSnapshotMock = vi.hoisted(() => vi.fn());
const runPrepassMock = vi.hoisted(() => vi.fn());
const getProjectSettingMock = vi.hoisted(() => vi.fn());
const captureCodexCatalogRevisionMock = vi.hoisted(() => vi.fn());

vi.mock("./codexCatalogRevision", () => ({
  captureCodexCatalogRevision: captureCodexCatalogRevisionMock,
}));
vi.mock("@/application/narrative-extraction/projectSnapshotAdapter", () => ({
  buildProjectNarrativeSnapshot: buildSnapshotMock,
}));
vi.mock("./extraction/entityCandidatePrepass", () => ({
  runEntityCandidatePrepass: runPrepassMock,
}));
vi.mock("@/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/settings/api")>();
  return { ...actual, getProjectSetting: getProjectSettingMock };
});

import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
import {
  resetCodexStructureExtractionApiCachesForTests,
  startCodexStructureExtraction,
} from "./codexStructureExtractionApi";
import { DISMISSED_CANDIDATES_KEY } from "./codexCandidateDismissals";
import { resetCodexStructureExtractionStoreForTests } from "./codexStructureExtractionStore";

const TYPE_CATALOG = [
  {
    ref: "T0001",
    sourceKey: "character",
    slug: "character",
    label: "character",
    coarseClassHints: ["person" as const],
    expectedVersion: 1,
  },
];

function existingEntry(name: string, aliases: string[] = []) {
  return {
    ref: "K0001",
    sourceKey: "db:existing",
    name,
    aliases,
    typeRef: "T0001",
    expectedVersion: 1,
  };
}

/** 架空の文字列だけで、prepass の種と snapshot を組んで抽出を走らせる。 */
async function runExtraction(options: {
  /** 本文。種の surface はここに出てくる順で位置を引く。 */
  readonly text: string;
  readonly surfaces: readonly string[];
  readonly existingEntries?: ReturnType<typeof existingEntry>[];
  readonly heuristicSeeds?: Parameters<
    typeof startCodexStructureExtraction
  >[0]["heuristicSeeds"];
}) {
  const { buildNarrativeCorpusSnapshot } =
    await import("@/features/narrative-extraction/source/buildSnapshot");
  const snapshotResult = await buildNarrativeCorpusSnapshot({
    snapshotId: "snapshot-dismissals",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "p1" },
    omissions: [],
    createdAt: "2026-08-10T00:01:00.000Z",
    documents: [
      {
        sourceKey: "project:scene:s1",
        parentSourceKey: null,
        title: "Scene",
        orderIndex: 0,
        proseMirrorJson: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: options.text }],
            },
          ],
        }),
        origin: {
          kind: "project-node",
          projectId: "p1",
          nodeId: "s1",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
          sourceUri: null,
        },
      },
    ],
  });
  if (!snapshotResult.ok) throw new Error("snapshot build failed in test");
  const documentRef = snapshotResult.snapshot.documents[0]!.ref;
  buildSnapshotMock.mockResolvedValue({
    ok: true,
    snapshot: snapshotResult.snapshot,
    diagnostics: [],
  });
  runPrepassMock.mockResolvedValue({
    status: "complete",
    seeds: options.surfaces.map((surface) => {
      const starts: number[] = [];
      for (
        let at = options.text.indexOf(surface);
        at >= 0;
        at = options.text.indexOf(surface, at + surface.length)
      ) {
        starts.push(at);
      }
      return {
        seedId: `seed-${surface}`,
        surface,
        normalizedSurface: surface,
        features: {
          occurrenceCount: starts.length,
          appearsAsProperName: true,
          appearsInDialogue: false,
          appearsInNarration: true,
        },
        occurrences: starts.map((start, index) => {
          const end = start + surface.length;
          return {
            sourceRef: "S0001",
            documentRef,
            quote: surface,
            canonicalRange: { start, end },
            context: {
              prefix: options.text.slice(Math.max(0, start - 20), start),
              suffix: options.text.slice(end, end + 20),
            },
            evidence: {
              id: `ea-${surface}-${index}`,
              quote: surface,
              documentRef,
              method: "exact",
            },
          };
        }),
      };
    }),
    rejections: [],
  });
  return startCodexStructureExtraction({
    projectId: "p1",
    folderId: "f1",
    sceneIds: ["s1"],
    authority: {
      projectId: "p1",
      currentProjectId: () => "p1",
      workspacePath: "/w",
      workspaceOpenRevision: 1,
    },
    workspacePath: "/w",
    openRevision: 1,
    useAi: false,
    skipNativePersist: true,
    typeCatalog: TYPE_CATALOG,
    ...(options.existingEntries
      ? { existingEntries: options.existingEntries }
      : {}),
    ...(options.heuristicSeeds
      ? { heuristicSeeds: options.heuristicSeeds }
      : {}),
  });
}

function dismissedAs(keys: readonly string[]) {
  getProjectSettingMock.mockResolvedValue(JSON.stringify(keys));
}

function titlesOf(projection: {
  proposals: readonly { displayTitle: string }[];
}) {
  return projection.proposals.map((row) => row.displayTitle);
}

describe("startCodexStructureExtraction: 見送り済みの表記を畳む（打ち手 3）", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    buildSnapshotMock.mockReset();
    runPrepassMock.mockReset();
    getProjectSettingMock.mockReset();
    getProjectSettingMock.mockResolvedValue(null);
    captureCodexCatalogRevisionMock.mockReset();
    captureCodexCatalogRevisionMock.mockImplementation(
      async (input: { projectId: string }) => ({
        sourceKind: "codex-catalog",
        sourceKey: `project:codex-catalog:${input.projectId}`,
        revisionToken:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      }),
    );
  });

  it("却下済みで名簿に当たらない種を提案から外し、{surface,key} で run に残す", async () => {
    dismissedAs(["ミナト"]);
    const projection = await runExtraction({
      text: "ミナトとライカが歩く",
      surfaces: ["ミナト", "ライカ"],
    });
    expect(getProjectSettingMock).toHaveBeenCalledWith(
      "p1",
      DISMISSED_CANDIDATES_KEY,
    );
    expect(titlesOf(projection)).toEqual(["ライカ"]);
    expect(projection.foldedDismissedSurfaces).toEqual([
      { surface: "ミナト", key: "ミナト" },
    ]);
    expect(projection.dismissalsUnavailable).toBeUndefined();
  });

  it("名簿に完全一致する種は、却下済みでも畳まない", async () => {
    dismissedAs(["ミナト"]);
    const projection = await runExtraction({
      text: "ミナトとライカが歩く",
      surfaces: ["ミナト", "ライカ"],
      existingEntries: [existingEntry("ミナト")],
    });
    expect(titlesOf(projection)).toContain("ミナト");
    const minato = projection.proposals.find(
      (row) => row.displayTitle === "ミナト",
    );
    expect(minato?.proposal.payload.binding.kind).toBe("bind-existing");
    expect(projection.foldedDismissedSurfaces).toBeUndefined();
  });

  it("別名に完全一致する種も、却下済みでも畳まない", async () => {
    dismissedAs(["みな"]);
    const projection = await runExtraction({
      text: "みなが歩く",
      surfaces: ["みな"],
      existingEntries: [existingEntry("ミナト", ["みな"])],
    });
    expect(titlesOf(projection)).toEqual(["みな"]);
    expect(projection.proposals[0]?.proposal.payload.binding.kind).toBe(
      "bind-existing",
    );
    expect(projection.foldedDismissedSurfaces).toBeUndefined();
  });

  it.each([
    ["敬称付き", "ミナトさん", "ミナト"],
    ["名簿の名前の接頭", "ミナ", "ミナトカゼ"],
    ["部分一致", "トカ", "ミナトカゼ"],
  ])(
    "名簿に %s で当たる種（ambiguous／resolved）は、却下済みでも畳まない",
    async (_label, surface, entryName) => {
      dismissedAs([surface]);
      const projection = await runExtraction({
        text: `${surface}が歩く`,
        surfaces: [surface],
        existingEntries: [existingEntry(entryName)],
      });
      expect(titlesOf(projection)).toEqual([surface]);
      expect(projection.proposals[0]?.proposal.payload.binding.kind).not.toBe(
        "create-new",
      );
      expect(projection.foldedDismissedSurfaces).toBeUndefined();
    },
  );

  it.each([
    ["行が無い", null],
    ["空の配列", "[]"],
    ["壊れた JSON", "{not json"],
    ["配列でない JSON", '{"a":1}'],
  ])("却下の記録が %s ときは従来どおり全件を出す", async (_label, raw) => {
    getProjectSettingMock.mockResolvedValue(raw);
    const projection = await runExtraction({
      text: "ミナトとライカが歩く",
      surfaces: ["ミナト", "ライカ"],
    });
    expect(titlesOf(projection).sort()).toEqual(["ミナト", "ライカ"].sort());
    expect(projection.foldedDismissedSurfaces).toBeUndefined();
    expect(projection.dismissalsUnavailable).toBeUndefined();
  });

  it("getProjectSetting が reject しても抽出は全件で完了し、dismissalsUnavailable を立てる", async () => {
    getProjectSettingMock.mockRejectedValue(new Error("db locked"));
    const projection = await runExtraction({
      text: "ミナトとライカが歩く",
      surfaces: ["ミナト", "ライカ"],
    });
    expect(titlesOf(projection).sort()).toEqual(["ミナト", "ライカ"].sort());
    expect(projection.dismissalsUnavailable).toBe(true);
    expect(projection.foldedDismissedSurfaces).toBeUndefined();
  });

  it("注入された heuristicSeeds は、却下済みでも畳まない", async () => {
    dismissedAs(["リク"]);
    const projection = await runExtraction({
      text: "リクが歩く",
      surfaces: [],
      heuristicSeeds: [
        {
          surface: "リク",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "リク",
              documentRef: "D000001",
              method: "exact" as const,
            },
          ],
        },
      ],
    });
    expect(runPrepassMock).not.toHaveBeenCalled();
    expect(titlesOf(projection)).toEqual(["リク"]);
    expect(projection.foldedDismissedSurfaces).toBeUndefined();
  });

  it("畳んだ種を端点とする関係の提案を作らない（畳まなければ作られる）", async () => {
    const text = "ライカとベルカは友人だ。ミナトとベルカは友人だ。";
    // 対照：見送りが無ければ、ミナトを端点にする関係の提案がある。
    const control = await runExtraction({
      text,
      surfaces: ["ライカ", "ベルカ", "ミナト"],
    });
    expect(
      control.relationProposals.filter(
        (item) =>
          item.subjectLabel === "ミナト" || item.objectLabel === "ミナト",
      ).length,
    ).toBeGreaterThan(0);

    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    dismissedAs(["ミナト"]);
    const folded = await runExtraction({
      text,
      surfaces: ["ライカ", "ベルカ", "ミナト"],
    });
    expect(titlesOf(folded)).not.toContain("ミナト");
    expect(folded.foldedDismissedSurfaces).toEqual([
      { surface: "ミナト", key: "ミナト" },
    ]);
    // 残りの 2 人の関係は引き続き作られ、ミナトを端点とするものだけが無い。
    expect(folded.relationProposals.length).toBeGreaterThan(0);
    expect(
      folded.relationProposals.filter(
        (item) =>
          item.subjectLabel === "ミナト" || item.objectLabel === "ミナト",
      ),
    ).toEqual([]);
    expect(folded.relationProposals.length).toBeLessThan(
      control.relationProposals.length,
    );
  }, 15_000);

  it("ASCII の大文字小文字と NFD の表記でも candidateKey で一致して畳まれる", async () => {
    const nfdSurface = "ガブ".normalize("NFD");
    expect(nfdSurface).not.toBe("ガブ");
    dismissedAs(["alice", "ガブ"]);
    const projection = await runExtraction({
      text: `Alice と ${nfdSurface} と ライカ`,
      surfaces: ["Alice", nfdSurface, "ライカ"],
    });
    expect(titlesOf(projection)).toEqual(["ライカ"]);
    expect(projection.foldedDismissedSurfaces).toEqual([
      { surface: "Alice", key: "alice" },
      { surface: nfdSurface, key: "ガブ" },
    ]);
  });

  it("関係の呼び名は、却下より先に skippedRelationalTerms に入る", async () => {
    dismissedAs(["姉ちゃん"]);
    const projection = await runExtraction({
      text: "姉ちゃんとライカが歩く",
      surfaces: ["姉ちゃん", "ライカ"],
    });
    expect(titlesOf(projection)).toEqual(["ライカ"]);
    expect(projection.skippedRelationalTerms).toEqual([
      { surface: "姉ちゃん", kind: "kinship" },
    ]);
    expect(projection.foldedDismissedSurfaces).toBeUndefined();
  });
});
