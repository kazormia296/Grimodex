import { describe, expect, it } from "vitest";
import {
  bindExistingCodexEntityProposal,
  createNewBindCodexEntityProposal,
  type BindCodexEntityPayload,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type {
  CodexEntityReviewProposal,
  CodexStructureCatalogSnapshot,
} from "../codexStructureExtractionStore";
import { buildCodexEntityProposalSafetyFlags } from "../codexStructureExtractionStore";
import {
  compileBindExistingCodexEntityOperation,
  compilePatchCodexEntryOperation,
} from "./compiler";
import {
  entitiesWithDependents,
  evaluateExactBindFromCatalog,
  recheckExactBindAgainstEntries,
  refreshEntityBindSafety,
  type CurrentCodexEntryRecord,
} from "./entityBulkSafety";

const CATALOG: CodexStructureCatalogSnapshot = {
  entities: [
    {
      ref: "K0001",
      sourceKey: "entry-minato",
      name: "ミナト",
      typeRef: "T0001",
      expectedVersion: 3,
      aliases: [],
    },
    {
      ref: "K0002",
      sourceKey: "entry-harbor",
      name: "ミナト港",
      typeRef: "T0002",
      expectedVersion: 1,
      aliases: [],
    },
    {
      ref: "K0003",
      sourceKey: "entry-riku",
      name: "リク",
      typeRef: "T0001",
      expectedVersion: 1,
      aliases: ["陸", "陸斗"],
    },
    {
      ref: "K0005",
      sourceKey: "entry-umi",
      name: "ウミ",
      typeRef: "T0002",
      expectedVersion: 1,
      aliases: [],
    },
    {
      ref: "K0004",
      sourceKey: "entry-sora",
      name: "ソラ",
      typeRef: "T0003",
      expectedVersion: 1,
      aliases: [],
    },
  ],
  types: [
    { ref: "T0001", sourceKey: "character", slug: "character", label: "人物" },
    { ref: "T0002", sourceKey: "location", slug: "location", label: "場所" },
    { ref: "T0003", sourceKey: "custom-x", slug: "custom-x", label: "独自" },
  ],
};

function bindPayload(
  name: string,
  entityRef: string,
  overrides: {
    aliasesToAdd?: readonly string[];
    summary?:
      | { readonly kind: "leave" }
      | { readonly kind: "fill-if-empty"; readonly value: string };
    aliases?: BindCodexEntityPayload["aliases"];
    narrativeEntityId?: string;
  } = {},
): BindCodexEntityPayload {
  return bindExistingCodexEntityProposal(
    {
      narrativeEntityId: overrides.narrativeEntityId ?? "ne-1",
      canonicalName: name,
      aliases: overrides.aliases ?? [],
      coarseClass: "person",
      typeResolution: { status: "resolved", typeRef: "T0001" },
      binding: {
        kind: "bind-existing",
        entityRef,
        enrichment: {
          aliasesToAdd: overrides.aliasesToAdd ?? [],
          summary: overrides.summary ?? { kind: "leave" },
        },
      },
    },
    { proposalId: "p-1" },
  ).payload;
}

describe("evaluateExactBindFromCatalog（設計 §3.2 の 3）", () => {
  it("完全一致・別名なし・要約 leave・人物の型・他に当たらない結び付けは通す", () => {
    // 「リク」は K0003 の名前に完全一致し、他の Entry に部分一致もしない。
    expect(
      evaluateExactBindFromCatalog(bindPayload("リク", "K0003"), CATALOG),
    ).toEqual({ ok: true });
  });

  it("別名に完全一致しても、結び先と同じ 1 Entry なら通す", () => {
    expect(
      evaluateExactBindFromCatalog(bindPayload("陸斗", "K0003"), CATALOG),
    ).toEqual({ ok: true });
  });

  it("1 字の表記は、完全一致でも読まずには通さない（蓮と蓮司のような部分一致を照合が数えない）", () => {
    expect(
      evaluateExactBindFromCatalog(bindPayload("陸", "K0003"), CATALOG),
    ).toEqual({ ok: false, reason: "single-char" });
    const catalog: CodexStructureCatalogSnapshot = {
      ...CATALOG,
      entities: [
        {
          ref: "K0010",
          sourceKey: "entry-ren",
          name: "蓮",
          typeRef: "T0001",
          expectedVersion: 1,
          aliases: [],
        },
        {
          ref: "K0011",
          sourceKey: "entry-renji",
          name: "蓮司",
          typeRef: "T0001",
          expectedVersion: 1,
          aliases: [],
        },
      ],
    };
    expect(
      evaluateExactBindFromCatalog(bindPayload("蓮", "K0010"), catalog),
    ).toEqual({ ok: false, reason: "single-char" });
  });

  it("(a) create-new・unresolved は対象外", () => {
    const createNew = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "リク",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "リク", aliases: [], summary: null },
        },
      },
      { proposalId: "p-1" },
    ).payload;
    expect(evaluateExactBindFromCatalog(createNew, CATALOG)).toEqual({
      ok: false,
      reason: "not-bind-existing",
    });
  });

  it("(c) 別名の追加・確認済みでない別名・要約の fill があれば対象外（patch になる）", () => {
    expect(
      evaluateExactBindFromCatalog(
        bindPayload("リク", "K0003", { aliasesToAdd: ["りっくん"] }),
        CATALOG,
      ),
    ).toEqual({ ok: false, reason: "enrichment" });
    expect(
      evaluateExactBindFromCatalog(
        bindPayload("リク", "K0003", {
          aliases: [
            {
              surface: "りっくん",
              status: "user-confirmation-required",
            },
          ],
        }),
        CATALOG,
      ),
    ).toEqual({ ok: false, reason: "enrichment" });
    expect(
      evaluateExactBindFromCatalog(
        bindPayload("リク", "K0003", {
          summary: { kind: "fill-if-empty", value: "少年" },
        }),
        CATALOG,
      ),
    ).toEqual({ ok: false, reason: "enrichment" });
  });

  it("(f) 呼び名に当たる表記は、名簿に入れた語でも対象外", () => {
    const catalog: CodexStructureCatalogSnapshot = {
      ...CATALOG,
      entities: [
        ...CATALOG.entities,
        {
          ref: "K0009",
          sourceKey: "entry-sis",
          name: "姉ちゃん",
          typeRef: "T0001",
          expectedVersion: 1,
          aliases: [],
        },
      ],
    };
    expect(
      evaluateExactBindFromCatalog(bindPayload("姉ちゃん", "K0009"), catalog),
    ).toEqual({ ok: false, reason: "relational-term" });
  });

  it("(b) 表記が結び先の名前・別名でなくなった（改名後の編集）なら対象外", () => {
    expect(
      evaluateExactBindFromCatalog(bindPayload("リクト", "K0003"), CATALOG),
    ).toEqual({ ok: false, reason: "no-exact-match" });
  });

  it("(b) 名前が A・別名が B の 2 Entry に当たる表記は対象外", () => {
    const catalog: CodexStructureCatalogSnapshot = {
      ...CATALOG,
      entities: [
        ...CATALOG.entities,
        {
          ref: "K0010",
          sourceKey: "entry-alias-holder",
          name: "ハル",
          typeRef: "T0001",
          expectedVersion: 1,
          aliases: ["リク"],
        },
      ],
    };
    expect(
      evaluateExactBindFromCatalog(bindPayload("リク", "K0003"), catalog),
    ).toEqual({ ok: false, reason: "multiple-exact" });
  });

  it("(h) 語の一部だけが当たる他の Entry がある（姓だけと姓名）なら対象外", () => {
    // 「ミナト」は K0001 に完全一致するが、K0002「ミナト港」にも部分一致する。
    expect(
      evaluateExactBindFromCatalog(bindPayload("ミナト", "K0001"), CATALOG),
    ).toEqual({ ok: false, reason: "partial-other" });
  });

  it("(g) 結び先の型が人物でない・型の一覧に無い Entry は対象外", () => {
    expect(
      evaluateExactBindFromCatalog(bindPayload("ウミ", "K0005"), CATALOG),
    ).toEqual({ ok: false, reason: "type-not-person" });
    expect(
      evaluateExactBindFromCatalog(bindPayload("ソラ", "K0004"), CATALOG),
    ).toEqual({ ok: false, reason: "type-not-person" });
    const unknownType: CodexStructureCatalogSnapshot = {
      ...CATALOG,
      entities: CATALOG.entities.map((entity) =>
        entity.ref === "K0003" ? { ...entity, typeRef: "T9999" } : entity,
      ),
    };
    expect(
      evaluateExactBindFromCatalog(bindPayload("リク", "K0003"), unknownType),
    ).toEqual({ ok: false, reason: "type-not-person" });
  });

  it("結び先が catalog に無い・catalog が無ければ対象外", () => {
    expect(
      evaluateExactBindFromCatalog(bindPayload("リク", "K0099"), CATALOG),
    ).toEqual({ ok: false, reason: "target-missing" });
    expect(
      evaluateExactBindFromCatalog(bindPayload("リク", "K0003"), null),
    ).toEqual({ ok: false, reason: "target-missing" });
  });
});

describe("recheckExactBindAgainstEntries（今の Codex での再検査）", () => {
  const entries: CurrentCodexEntryRecord[] = [
    {
      id: "entry-minato",
      name: "ミナト",
      aliases: null,
      type: "character",
      version: 3,
    },
    {
      id: "entry-riku",
      name: "リク",
      aliases: '["陸"]',
      type: "character",
      version: 1,
    },
  ];
  const payload = bindPayload("リク", "K0003");

  it("今の Codex でも完全一致が結び先 1 件だけなら通す", () => {
    expect(recheckExactBindAgainstEntries(payload, CATALOG, entries)).toEqual({
      ok: true,
    });
  });

  it("run の後に同名の別 Entry が足されると外す", () => {
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [
        ...entries,
        {
          id: "entry-new",
          name: "リク",
          aliases: null,
          type: "character",
          version: 1,
        },
      ]),
    ).toEqual({ ok: false, reason: "multiple-exact" });
  });

  it("run の後に別の Entry の別名に同じ語が足されると外す", () => {
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [
        ...entries,
        {
          id: "entry-new",
          name: "ハル",
          aliases: JSON.stringify(["リク"]),
          type: "character",
          version: 1,
        },
      ]),
    ).toEqual({ ok: false, reason: "multiple-exact" });
  });

  it("run の後に語の一部が当たる Entry が足されると外す", () => {
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [
        ...entries,
        {
          id: "entry-new",
          name: "リク隊長",
          aliases: null,
          type: "character",
          version: 1,
        },
      ]),
    ).toEqual({ ok: false, reason: "partial-other" });
  });

  it("結び先が改名・型変更・削除されると外す", () => {
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [
        entries[0]!,
        { ...entries[1]!, name: "リクト", aliases: null },
      ]),
    ).toEqual({ ok: false, reason: "no-exact-match" });
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [
        entries[0]!,
        { ...entries[1]!, type: "location" },
      ]),
    ).toEqual({ ok: false, reason: "type-not-person" });
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [entries[0]!]),
    ).toEqual({ ok: false, reason: "target-missing" });
  });

  it("型の一覧に無い独自の type は、catalog では先頭の型に落ちていても今の entry.type で外す", () => {
    expect(
      recheckExactBindAgainstEntries(payload, CATALOG, [
        entries[0]!,
        { ...entries[1]!, type: "custom-x" },
      ]),
    ).toEqual({ ok: false, reason: "type-not-person" });
  });
});

// ここで固定するのは compile の種類（別名・要約の追加が無ければ bind-existing、あれば patch）だけ。
// 「bind-existing は Codex の行を書かない」こと自体は、Rust の統合試験
// `bind_existing_undo_redo_never_touches_entry_row`（grimodex-db/tests/codex_narrative_commit.rs）が、
// apply 直後の Entry の行の指紋が変わらないことで保証する。
describe("bind-existing は Codex の行を書かない op（判定の前提）", () => {
  it("別名の追加も要約の fill も無ければ codex.entity.bind-existing になり、あれば patch になる", () => {
    const base = {
      narrativeEntityId: "ne-1",
      entryId: "entry-riku",
      baseVersion: 1,
      existingAliases: ["陸"],
    };
    // 一括の対象（(c)）は patch が null になる組だけ。
    expect(
      compilePatchCodexEntryOperation({
        ...base,
        aliasesToAdd: [],
        summary: { kind: "leave" },
      }),
    ).toBeNull();
    expect(
      compileBindExistingCodexEntityOperation({
        narrativeEntityId: "ne-1",
        entryId: "entry-riku",
        baseVersion: 1,
      }).kind,
    ).toBe("codex.entity.bind-existing");
    expect(
      compilePatchCodexEntryOperation({
        ...base,
        aliasesToAdd: ["りっくん"],
        summary: { kind: "leave" },
      })?.kind,
    ).toBe("codex.entry.patch");
    expect(
      compilePatchCodexEntryOperation({
        ...base,
        aliasesToAdd: [],
        summary: { kind: "fill-if-empty", value: "少年" },
      })?.kind,
    ).toBe("codex.entry.patch");
  });
});

function reviewProposal(
  proposalId: string,
  payload: BindCodexEntityPayload,
): CodexEntityReviewProposal {
  const proposal = bindExistingCodexEntityProposal(
    {
      ...payload,
      binding:
        payload.binding.kind === "bind-existing"
          ? payload.binding
          : {
              kind: "bind-existing",
              entityRef: "K0003",
              enrichment: { aliasesToAdd: [], summary: { kind: "leave" } },
            },
    },
    { proposalId },
  );
  return {
    proposalId,
    revisionId: `rev-${proposalId}`,
    proposalKey: `h-${proposalId}`,
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: payload.canonicalName,
    proposal,
    evidence: [],
    safety: buildCodexEntityProposalSafetyFlags({
      bindingKind: "bind-existing",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: true,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    }),
  };
}

describe("依存 (e) と旗の引き直し", () => {
  const entity = reviewProposal(
    "prop-entity-1",
    bindPayload("リク", "K0003", { narrativeEntityId: "ne-1" }),
  );
  const projectionBase = {
    proposals: [entity],
    relationProposals: [],
    baseDetailProposals: [],
    phaseProposals: [],
    catalog: CATALOG,
  };

  it("依存する提案が無ければ existingExactBind と existingBindNoDependents が立つ", () => {
    const refreshed = refreshEntityBindSafety(projectionBase);
    expect(refreshed.proposals[0]?.safety.existingExactBind).toBe(true);
    expect(refreshed.proposals[0]?.safety.existingBindNoDependents).toBe(true);
  });

  it("関係の端点・依存、Base Detail、Phase のどれかに実体が出ると existingBindNoDependents が落ちる", () => {
    const relation = {
      proposalId: "r1",
      proposal: {
        payload: { subjectEntityId: "ne-1", objectEntityId: "ne-2" },
        dependencies: [],
      },
    };
    const viaDependency = {
      proposalId: "r2",
      proposal: {
        payload: { subjectEntityId: "ne-8", objectEntityId: "ne-9" },
        dependencies: [
          { kind: "requires-resolution", proposalId: "prop-entity-1" },
        ],
      },
    };
    const detail = {
      proposal: { payload: { narrativeEntityId: "ne-1" }, dependencies: [] },
    };
    const phase = {
      proposal: { payload: { narrativeEntityId: "ne-1" }, dependencies: [] },
    };
    const cast = <T>(value: unknown) => value as T;
    type P = Parameters<typeof entitiesWithDependents>[0];
    for (const variant of [
      { relationProposals: [relation] },
      { relationProposals: [viaDependency] },
      { baseDetailProposals: [detail] },
      { phaseProposals: [phase] },
    ]) {
      const set = entitiesWithDependents(
        cast<P>({ ...projectionBase, ...variant }),
      );
      expect(set.has("ne-1")).toBe(true);
    }
    const refreshed = refreshEntityBindSafety(
      cast<typeof projectionBase>({
        ...projectionBase,
        relationProposals: [relation],
      }),
    );
    expect(refreshed.proposals[0]?.safety.existingBindNoDependents).toBe(false);
    // 静的な照合の旗は依存では変わらない。
    expect(refreshed.proposals[0]?.safety.existingExactBind).toBe(true);
  });

  it("旗を引き直しても新規作成の noRelationDeps は変えない（関係を持つ新規作成は今までどおり対象）", () => {
    const refreshed = refreshEntityBindSafety({
      ...projectionBase,
      proposals: [
        {
          ...entity,
          safety: { ...entity.safety, noRelationDeps: true, createNew: true },
        },
      ],
      relationProposals: [
        {
          proposalId: "r1",
          proposal: {
            payload: { subjectEntityId: "ne-1", objectEntityId: "ne-2" },
            dependencies: [],
          },
        } as never,
      ],
    });
    expect(refreshed.proposals[0]?.safety.noRelationDeps).toBe(true);
  });

  it("変わらない投影は同じ参照を返す（冪等）", () => {
    const once = refreshEntityBindSafety(projectionBase);
    expect(refreshEntityBindSafety(once)).toBe(once);
  });
});
