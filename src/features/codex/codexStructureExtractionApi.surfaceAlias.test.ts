import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

beforeEach(() => {
  setCurrentWorkspaceIdentity({ path: "/w", openRevision: 1 });
});

afterEach(() => {
  setCurrentWorkspaceIdentity(null);
});

const appendHumanDecisionMock = vi.hoisted(() => vi.fn());
const appendRevisionMock = vi.hoisted(() => vi.fn());
const reviseAndDecideAsHumanMock = vi.hoisted(() => vi.fn());
const prepareApplyMock = vi.hoisted(() => vi.fn());
const listCodexContextMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/proposalRepository", () => ({
  saveProposalSet: vi.fn(),
  buildNativeReconciliationEnvelope: vi.fn(),
  buildSnapshotSourceBasis: vi.fn(),
  appendDecision: vi.fn(),
  appendHumanDecision: appendHumanDecisionMock,
  appendRevision: appendRevisionMock,
  reviseAndDecideAsHuman: reviseAndDecideAsHumanMock,
}));
vi.mock(
  "@/application/narrative-extraction/codexCommitCoordinator",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/codexCommitCoordinator")
      >();
    return {
      ...actual,
      prepareAndApplyCodexCommit: prepareApplyMock,
    };
  },
);
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listCodexContextMetadata: listCodexContextMetadataMock,
  };
});

import { bindExistingCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import {
  applyCodexStructureExtractionReview,
  CodexStructureApplyBlockedError,
  CodexSurfaceAliasNotAllowedError,
  decideCodexStructureProposal,
  readCurrentCodexEntries,
  resetCodexStructureExtractionApiCachesForTests,
  reviseCodexStructureProposal,
} from "./codexStructureExtractionApi";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
} from "./codexStructureExtractionStore";
import type { CurrentCodexEntryRecord } from "./extraction/entityBulkSafety";

const CATALOG = {
  entities: [
    {
      ref: "K0003",
      sourceKey: "entry-riku",
      name: "リク",
      typeRef: "T0001",
      expectedVersion: 1,
      aliases: [] as string[],
    },
    {
      ref: "K0005",
      sourceKey: "entry-sora",
      name: "ソラ",
      typeRef: "T0001",
      expectedVersion: 1,
      aliases: [] as string[],
    },
  ],
  types: [
    {
      ref: "T0001",
      sourceKey: "character",
      slug: "character",
      label: "character",
    },
  ],
};

const evidence = [
  {
    anchorId: "a1",
    quote: "リク",
    documentRef: "D1",
    method: "exact" as const,
  },
];

type SummaryEnrichment =
  | { readonly kind: "leave" }
  | { readonly kind: "fill-if-empty"; readonly value: string };

interface RowOptions {
  readonly entityRef?: string;
  readonly aliasesToAdd?: readonly string[];
  readonly summary?: SummaryEnrichment;
  readonly status?: "unreviewed" | "approved" | "rejected";
  readonly bulk?: boolean;
  readonly stale?: boolean;
  readonly compiledKind?: "codex.entity.bind-existing" | "codex.entry.patch";
  readonly baseVersion?: number;
}

function entryIdOf(entityRef: string) {
  return entityRef === "K0003" ? "entry-riku" : "entry-sora";
}

function bindRow(proposalId: string, name: string, options: RowOptions = {}) {
  const entityRef = options.entityRef ?? "K0003";
  const narrativeEntityId = `ne-${proposalId}`;
  return {
    proposalId,
    revisionId: `rev-${proposalId}`,
    proposalKey: `key-${proposalId}`,
    status: options.status ?? "unreviewed",
    applicability: "applicable" as const,
    displayTitle: name,
    proposal: bindExistingCodexEntityProposal(
      {
        narrativeEntityId,
        canonicalName: name,
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "bind-existing",
          entityRef,
          enrichment: {
            aliasesToAdd: options.aliasesToAdd ?? [],
            summary: options.summary ?? { kind: "leave" },
          },
        },
      },
      { proposalId },
    ),
    evidence,
    safety: buildCodexEntityProposalSafetyFlags({
      bindingKind: "bind-existing",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: true,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    }),
    ...(options.compiledKind
      ? {
          compiledOperation: {
            kind: options.compiledKind,
            payload: {
              entryId: entryIdOf(entityRef),
              narrativeEntityId,
              baseVersion: options.baseVersion ?? 1,
            },
          },
        }
      : {}),
    bulkApprovedExactBind: options.bulk ?? false,
    staleBind: options.stale ?? false,
    staleBindCause: options.stale ? "stale-version" : undefined,
  };
}

function publish(proposals: unknown[]) {
  useCodexStructureExtractionStore.getState().setProjection({
    runId: "run-alias",
    projectId: "p1",
    workspacePath: "/w",
    openRevision: 1,
    proposalSetId: "ps-alias",
    status: "completed",
    coverage: {},
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    },
    proposals: proposals as never,
    relationProposals: [],
    baseDetailProposals: [],
    phaseProposals: [],
    entityCount: proposals.length,
    relationCount: 0,
    baseDetailCount: 0,
    phaseCount: 0,
    unresolvedCount: 0,
    approvedCount: 0,
    catalog: CATALOG,
  });
}

const stored = (id: string) =>
  useCodexStructureExtractionStore
    .getState()
    .projection?.proposals.find((row) => row.proposalId === id);

function liveEntries(
  overrides: {
    readonly rikuAliases?: string | null;
    readonly rikuExcluded?: string | null;
    readonly soraAliases?: string | null;
    readonly rikuVersion?: number;
  } = {},
): CurrentCodexEntryRecord[] {
  return [
    {
      id: "entry-riku",
      name: "リク",
      aliases: overrides.rikuAliases ?? null,
      type: "character",
      version: overrides.rikuVersion ?? 1,
      excludedAliases: overrides.rikuExcluded ?? null,
    },
    {
      id: "entry-sora",
      name: "ソラ",
      aliases: overrides.soraAliases ?? null,
      type: "character",
      version: 1,
      excludedAliases: null,
    },
  ];
}

function sentEnvelope() {
  const call = appendRevisionMock.mock.calls[0]?.[0] as {
    payloadJson: {
      reviewPayload: {
        binding: { enrichment: { aliasesToAdd: string[] } };
      };
    };
  };
  return call.payloadJson.reviewPayload;
}

beforeEach(() => {
  resetCodexStructureExtractionStoreForTests();
  resetCodexStructureExtractionApiCachesForTests();
  appendRevisionMock.mockReset();
  appendRevisionMock.mockResolvedValue({ revisionId: "rev-new" });
  appendHumanDecisionMock.mockReset();
  appendHumanDecisionMock.mockResolvedValue({});
  reviseAndDecideAsHumanMock.mockReset();
  reviseAndDecideAsHumanMock.mockResolvedValue({
    proposalId: "s1",
    revisionId: "rev-s1-2",
    revisionNumber: 2,
    decisionId: "d2",
    decision: "approved",
    status: "approved",
  });
  prepareApplyMock.mockReset();
  prepareApplyMock.mockResolvedValue({
    prepared: {},
    applied: {},
    status: {},
    commitMap: { entityBindings: {} },
  });
  listCodexContextMetadataMock.mockReset();
});

describe("reviseCodexStructureProposal: 別名に足す印（打ち手 1）", () => {
  it("true で、送る payload の aliasesToAdd に表記が入り、提案は unreviewed に戻り、一括・古さの印が外れる", async () => {
    publish([
      bindRow("s1", "リクさん", {
        status: "approved",
        bulk: true,
        stale: true,
      }),
    ]);
    const readEntries = vi.fn().mockResolvedValue(liveEntries());
    await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: true },
      readEntries,
    });
    expect(readEntries).toHaveBeenCalledWith("p1");
    expect(appendRevisionMock).toHaveBeenCalledTimes(1);
    expect(sentEnvelope().binding.enrichment.aliasesToAdd).toEqual([
      "リクさん",
    ]);
    expect(stored("s1")).toMatchObject({
      revisionId: "rev-new",
      status: "unreviewed",
      bulkApprovedExactBind: false,
      staleBind: false,
    });
    expect(
      (
        stored("s1")?.proposal.payload.binding as unknown as {
          enrichment: { aliasesToAdd: string[] };
        }
      ).enrichment.aliasesToAdd,
    ).toEqual(["リクさん"]);
  });

  it("false で、aliasesToAdd から表記が外れ、一括・古さの印も外れる", async () => {
    publish([
      bindRow("s1", "リクさん", {
        status: "approved",
        aliasesToAdd: ["リクさん"],
        bulk: true,
        stale: true,
      }),
    ]);
    const readEntries = vi.fn().mockResolvedValue(liveEntries());
    await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: false },
      readEntries,
    });
    // 外すときは今の Codex を読まない（判定は入れるときだけ）。
    expect(readEntries).not.toHaveBeenCalled();
    expect(sentEnvelope().binding.enrichment.aliasesToAdd).toEqual([]);
    expect(stored("s1")).toMatchObject({
      status: "unreviewed",
      bulkApprovedExactBind: false,
      staleBind: false,
    });
  });
});

describe("reviseCodexStructureProposal: 今の Codex での判定", () => {
  it("結び先の除外語が表記を含むと CodexSurfaceAliasNotAllowedError（excluded）で、appendRevision を呼ばない", async () => {
    publish([bindRow("s1", "リクさん")]);
    const readEntries = vi
      .fn()
      .mockResolvedValue(
        liveEntries({ rikuExcluded: JSON.stringify(["リクさん"]) }),
      );
    const error = await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: true },
      readEntries,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexSurfaceAliasNotAllowedError);
    expect((error as CodexSurfaceAliasNotAllowedError).reason).toBe("excluded");
    expect(appendRevisionMock).not.toHaveBeenCalled();
    expect(stored("s1")?.status).toBe("unreviewed");
    expect(
      (
        stored("s1")?.proposal.payload.binding as unknown as {
          enrichment: { aliasesToAdd: string[] };
        }
      ).enrichment.aliasesToAdd,
    ).toEqual([]);
  });

  it("readEntries が失敗したときは run の catalog で判定して通る", async () => {
    publish([bindRow("s1", "リクさん")]);
    const readEntries = vi.fn().mockRejectedValue(new Error("db down"));
    await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: true },
      readEntries,
    });
    expect(readEntries).toHaveBeenCalledTimes(1);
    expect(appendRevisionMock).toHaveBeenCalledTimes(1);
    expect(sentEnvelope().binding.enrichment.aliasesToAdd).toEqual([
      "リクさん",
    ]);
  });

  it("readEntries が失敗しても、catalog で条件を外れる表記（別名と一致）は止める", async () => {
    publish([bindRow("s1", "リクさん")]);
    const readEntries = vi.fn().mockRejectedValue(new Error("db down"));
    const error = await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { canonicalName: "リク", addSurfaceAlias: true },
      readEntries,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexSurfaceAliasNotAllowedError);
    expect((error as CodexSurfaceAliasNotAllowedError).reason).toBe(
      "already-alias",
    );
    expect(appendRevisionMock).not.toHaveBeenCalled();
  });
});

describe("reviseCodexStructureProposal: 同じ抽出の同じ Entry", () => {
  it("同じ Entry へ要約の fill を持つ別の提案があると same-entry-patch で拒否する", async () => {
    publish([
      bindRow("s1", "リクさん"),
      bindRow("f1", "リク", {
        summary: { kind: "fill-if-empty", value: "監察官" },
      }),
    ]);
    const readEntries = vi.fn().mockResolvedValue(liveEntries());
    const error = await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: true },
      readEntries,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexSurfaceAliasNotAllowedError);
    expect((error as CodexSurfaceAliasNotAllowedError).reason).toBe(
      "same-entry-patch",
    );
    expect(appendRevisionMock).not.toHaveBeenCalled();
  });

  it("同じ Entry への結び付けだけの別の提案、または別の Entry への fill なら通る", async () => {
    publish([
      bindRow("s1", "リクさん"),
      bindRow("b2", "リクくん"),
      bindRow("f2", "ソラ", {
        entityRef: "K0005",
        summary: { kind: "fill-if-empty", value: "操縦士" },
      }),
    ]);
    const readEntries = vi.fn().mockResolvedValue(liveEntries());
    await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: true },
      readEntries,
    });
    expect(appendRevisionMock).toHaveBeenCalledTimes(1);
    expect(sentEnvelope().binding.enrichment.aliasesToAdd).toEqual([
      "リクさん",
    ]);
  });

  it("同じ Entry への別の提案が却下済みなら数えない", async () => {
    publish([
      bindRow("s1", "リクさん"),
      bindRow("f1", "リク", {
        status: "rejected",
        summary: { kind: "fill-if-empty", value: "監察官" },
      }),
    ]);
    await reviseCodexStructureProposal({
      proposalId: "s1",
      patch: { addSurfaceAlias: true },
      readEntries: vi.fn().mockResolvedValue(liveEntries()),
    });
    expect(appendRevisionMock).toHaveBeenCalledTimes(1);
  });
});

describe("decideCodexStructureProposal: 印のある提案の承認", () => {
  it("今の Codex で別の Entry が同じ表記を別名に持っていれば CodexSurfaceAliasNotAllowedError（exact-other）で、decision を書かない", async () => {
    publish([bindRow("s1", "リクさん", { aliasesToAdd: ["リクさん"] })]);
    const error = await decideCodexStructureProposal({
      proposalId: "s1",
      status: "approved",
      entries: liveEntries({ soraAliases: JSON.stringify(["リクさん"]) }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexSurfaceAliasNotAllowedError);
    expect((error as CodexSurfaceAliasNotAllowedError).reason).toBe(
      "exact-other",
    );
    expect(reviseAndDecideAsHumanMock).not.toHaveBeenCalled();
    expect(appendHumanDecisionMock).not.toHaveBeenCalled();
    expect(stored("s1")?.status).toBe("unreviewed");
    expect(stored("s1")?.compiledOperation ?? null).toBeNull();
  });

  it("結び先の除外語が表記を含めば excluded で止める", async () => {
    publish([bindRow("s1", "リクさん", { aliasesToAdd: ["リクさん"] })]);
    const error = await decideCodexStructureProposal({
      proposalId: "s1",
      status: "approved",
      entries: liveEntries({ rikuExcluded: JSON.stringify(["リクさん"]) }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexSurfaceAliasNotAllowedError);
    expect((error as CodexSurfaceAliasNotAllowedError).reason).toBe("excluded");
    expect(reviseAndDecideAsHumanMock).not.toHaveBeenCalled();
  });

  it("条件を満たせば codex.entry.patch が compile され、aliases は既存と表記の和集合になる", async () => {
    publish([bindRow("s1", "リクさん", { aliasesToAdd: ["リクさん"] })]);
    await decideCodexStructureProposal({
      proposalId: "s1",
      status: "approved",
      entries: liveEntries({ rikuAliases: JSON.stringify(["りっくん"]) }),
    });
    expect(reviseAndDecideAsHumanMock).toHaveBeenCalledTimes(1);
    const call = reviseAndDecideAsHumanMock.mock.calls[0]?.[0] as {
      payloadJson: {
        compiledOperation: {
          kind: string;
          payload: {
            entryId: string;
            baseVersion: number;
            aliases: { kind: string; values: string[] };
          };
        };
      };
      decision: string;
    };
    expect(call.decision).toBe("approved");
    const operation = call.payloadJson.compiledOperation;
    expect(operation.kind).toBe("codex.entry.patch");
    expect(operation.payload.entryId).toBe("entry-riku");
    expect(operation.payload.baseVersion).toBe(1);
    expect(operation.payload.aliases.kind).toBe("set");
    expect([...operation.payload.aliases.values].sort()).toEqual(
      ["りっくん", "リクさん"].sort(),
    );
    expect(stored("s1")).toMatchObject({
      status: "approved",
      compiledOperation: { kind: "codex.entry.patch" },
    });
  });

  it("印の無い結び付けは今の Codex で条件を外れても、この検査では止めない", async () => {
    publish([bindRow("s1", "リクさん")]);
    await decideCodexStructureProposal({
      proposalId: "s1",
      status: "approved",
      entries: liveEntries({ rikuExcluded: JSON.stringify(["リクさん"]) }),
    });
    expect(reviseAndDecideAsHumanMock).toHaveBeenCalledTimes(1);
    const call = reviseAndDecideAsHumanMock.mock.calls[0]?.[0] as {
      payloadJson: { compiledOperation: { kind: string } };
    };
    expect(call.payloadJson.compiledOperation.kind).toBe(
      "codex.entity.bind-existing",
    );
  });
});

describe("applyCodexStructureExtractionReview: Apply の前の停止", () => {
  const patchRow = (
    id: string,
    name: string,
    options: Partial<RowOptions> = {},
  ) =>
    bindRow(id, name, {
      status: "approved",
      compiledKind: "codex.entry.patch",
      ...options,
    });

  it("承認済みで同じ Entry に向く patch が 2 件あると same-entry-patch で止め、commit も decision も書かない", async () => {
    publish([
      patchRow("p1", "リクさん", { aliasesToAdd: ["リクさん"] }),
      patchRow("p2", "リク隊長", {
        summary: { kind: "fill-if-empty", value: "監察官" },
      }),
    ]);
    const error = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: liveEntries(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexStructureApplyBlockedError);
    const blocked = error as CodexStructureApplyBlockedError;
    expect(blocked.kind).toBe("same-entry-patch");
    expect([...blocked.displayTitles].sort()).toEqual(
      ["リクさん", "リク隊長"].sort(),
    );
    expect(blocked.displayTitles).toHaveLength(2);
    expect(prepareApplyMock).not.toHaveBeenCalled();
    expect(appendHumanDecisionMock).not.toHaveBeenCalled();
    expect(reviseAndDecideAsHumanMock).not.toHaveBeenCalled();
    expect(stored("p1")?.status).toBe("approved");
    expect(stored("p2")?.status).toBe("approved");
  });

  it("別の Entry へ向く patch が 1 件ずつなら止めない", async () => {
    publish([
      patchRow("p1", "リクさん", { aliasesToAdd: ["リクさん"] }),
      patchRow("p2", "ソラさん", {
        entityRef: "K0005",
        aliasesToAdd: ["ソラさん"],
      }),
    ]);
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: liveEntries(),
    });
    expect(prepareApplyMock).toHaveBeenCalledTimes(1);
  });

  it("bind 2 件と patch 1 件が同じ Entry に向いても止めず、op は bind が先に並ぶ", async () => {
    publish([
      patchRow("p1", "リクさん", { aliasesToAdd: ["リクさん"] }),
      bindRow("b1", "リクくん", {
        status: "approved",
        compiledKind: "codex.entity.bind-existing",
      }),
      bindRow("b2", "リク隊長", {
        status: "approved",
        compiledKind: "codex.entity.bind-existing",
      }),
    ]);
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: liveEntries(),
    });
    expect(prepareApplyMock).toHaveBeenCalledTimes(1);
    const committed = prepareApplyMock.mock.calls[0]?.[0]?.operations ?? [];
    expect(
      committed.map(
        (item: { proposalId: string; operation: { kind: string } }) => [
          item.proposalId,
          item.operation.kind,
        ],
      ),
    ).toEqual([
      ["b1", "codex.entity.bind-existing"],
      ["b2", "codex.entity.bind-existing"],
      ["p1", "codex.entry.patch"],
    ]);
  });

  it("印のある承認済みの提案が今の Codex で条件を外れると surface-alias で止め、commit も decision も書かない", async () => {
    publish([
      patchRow("p1", "リクさん", { aliasesToAdd: ["リクさん"] }),
      bindRow("c0", "ソラ", {
        entityRef: "K0005",
        status: "approved",
        compiledKind: "codex.entity.bind-existing",
      }),
    ]);
    const error = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: liveEntries({ rikuExcluded: JSON.stringify(["リクさん"]) }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexStructureApplyBlockedError);
    const blocked = error as CodexStructureApplyBlockedError;
    expect(blocked.kind).toBe("surface-alias");
    expect(blocked.displayTitles).toEqual(["リクさん"]);
    expect(prepareApplyMock).not.toHaveBeenCalled();
    expect(appendHumanDecisionMock).not.toHaveBeenCalled();
    expect(reviseAndDecideAsHumanMock).not.toHaveBeenCalled();
  });

  it("印のある承認済みの提案が、別の Entry が同じ表記を持つようになったときも surface-alias で止める", async () => {
    publish([patchRow("p1", "リクさん", { aliasesToAdd: ["リクさん"] })]);
    const error = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: liveEntries({ soraAliases: JSON.stringify(["リクさん"]) }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexStructureApplyBlockedError);
    expect((error as CodexStructureApplyBlockedError).kind).toBe(
      "surface-alias",
    );
    expect(prepareApplyMock).not.toHaveBeenCalled();
  });

  it("印のある承認済みの提案が今の Codex でも条件を満たせば commit する", async () => {
    publish([patchRow("p1", "リクさん", { aliasesToAdd: ["リクさん"] })]);
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: liveEntries(),
    });
    expect(prepareApplyMock).toHaveBeenCalledTimes(1);
  });
});

describe("readCurrentCodexEntries: excludedAliases", () => {
  it("listCodexContextMetadata の excludedAliases を返し、無ければ null にする", async () => {
    listCodexContextMetadataMock.mockResolvedValue([
      {
        id: "entry-riku",
        name: "リク",
        aliases: null,
        type: "character",
        version: 3,
        excludedAliases: JSON.stringify(["リクさん"]),
      },
      {
        id: "entry-sora",
        name: "ソラ",
        aliases: JSON.stringify(["そら"]),
        type: "character",
        version: 1,
      },
    ]);
    const rows = await readCurrentCodexEntries("p1");
    expect(listCodexContextMetadataMock).toHaveBeenCalledWith("p1");
    expect(rows).toEqual([
      {
        id: "entry-riku",
        name: "リク",
        aliases: null,
        type: "character",
        version: 3,
        excludedAliases: JSON.stringify(["リクさん"]),
      },
      {
        id: "entry-sora",
        name: "ソラ",
        aliases: JSON.stringify(["そら"]),
        type: "character",
        version: 1,
        excludedAliases: null,
      },
    ]);
  });
});
