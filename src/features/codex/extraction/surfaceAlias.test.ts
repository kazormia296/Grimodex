import { describe, expect, it } from "vitest";
import {
  bindExistingCodexEntityProposal,
  createNewBindCodexEntityProposal,
  type BindCodexEntityPayload,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { patchBindCodexEntityPayload } from "./reviewEditPayload";
import {
  compilesToEntryPatch,
  evaluateSurfaceAlias,
  hasOtherPatchOnSameEntry,
  hasSurfaceAlias,
  withSurfaceAlias,
  type SameEntryProposalView,
  type SurfaceAliasRecord,
} from "./surfaceAlias";

function bindPayload(
  name: string,
  entityRef: string,
  overrides: {
    aliasesToAdd?: readonly string[];
    summary?:
      | { readonly kind: "leave" }
      | { readonly kind: "fill-if-empty"; readonly value: string };
    aliases?: BindCodexEntityPayload["aliases"];
  } = {},
): BindCodexEntityPayload {
  return bindExistingCodexEntityProposal(
    {
      narrativeEntityId: "ne-1",
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

function createNewPayload(name: string): BindCodexEntityPayload {
  return createNewBindCodexEntityProposal(
    {
      narrativeEntityId: "ne-1",
      canonicalName: name,
      aliases: [],
      coarseClass: "person",
      typeResolution: { status: "resolved", typeRef: "T0001" },
      binding: {
        kind: "create-new",
        entry: { name, aliases: [], summary: null },
      },
    },
    { proposalId: "p-1" },
  ).payload;
}

const RIKU: SurfaceAliasRecord = {
  key: "e-riku",
  name: "リク",
  aliases: ["リクさま", "陸斗"],
};
const TANAKA: SurfaceAliasRecord = {
  key: "e-tanaka",
  name: "田中",
  aliases: '["タナカ"]',
};
const MINATO: SurfaceAliasRecord = {
  key: "e-minato",
  name: "ミナト",
  aliases: [],
};

function evaluate(
  surface: string,
  targetKey: string | null,
  records: readonly SurfaceAliasRecord[],
) {
  return evaluateSurfaceAlias({ surface, targetKey, records });
}

describe("evaluateSurfaceAlias", () => {
  it("敬称を外すと結び先の名前に当たる表記は ok", () => {
    expect(evaluate("リクさん", "e-riku", [RIKU, MINATO])).toEqual({
      ok: true,
    });
    expect(evaluate("田中先生", "e-tanaka", [RIKU, TANAKA])).toEqual({
      ok: true,
    });
  });

  it("敬称を外すと結び先の別名に当たる表記も ok", () => {
    expect(evaluate("タナカさん", "e-tanaka", [TANAKA, MINATO])).toEqual({
      ok: true,
    });
    expect(evaluate("陸斗くん", "e-riku", [RIKU, MINATO])).toEqual({
      ok: true,
    });
  });

  it("表記が結び先の名前・別名に既に一致すれば already-alias", () => {
    expect(evaluate("リクさま", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "already-alias",
    });
    expect(evaluate("リク", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "already-alias",
    });
  });

  it("愛称は not-honorific-form", () => {
    expect(evaluate("りっくん", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "not-honorific-form",
    });
  });

  it("敬称を外すと 1 字になる表記は not-honorific-form", () => {
    expect(evaluate("陸さん", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "not-honorific-form",
    });
  });

  it("敬称が無く名前にも当たらない表記は not-honorific-form", () => {
    expect(evaluate("リクタ", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "not-honorific-form",
    });
  });

  it("1 字の表記は single-char", () => {
    expect(evaluate("陸", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "single-char",
    });
    expect(evaluate("  ", "e-riku", [RIKU])).toEqual({
      ok: false,
      reason: "single-char",
    });
  });

  it("敬称の形の呼び名は relational-term", () => {
    const sister: SurfaceAliasRecord = {
      key: "e-sister",
      name: "姉",
      aliases: ["あね"],
    };
    expect(evaluate("お姉さん", "e-sister", [sister])).toEqual({
      ok: false,
      reason: "relational-term",
    });
    expect(evaluate("おじさん", "e-sister", [sister])).toEqual({
      ok: false,
      reason: "relational-term",
    });
  });

  it("結び先が名簿に無い・targetKey が null なら target-missing", () => {
    expect(evaluate("リクさん", "e-nothing", [RIKU])).toEqual({
      ok: false,
      reason: "target-missing",
    });
    expect(evaluate("リクさん", null, [RIKU])).toEqual({
      ok: false,
      reason: "target-missing",
    });
  });

  it("別の Entry の別名が表記に完全一致すれば exact-other", () => {
    const other: SurfaceAliasRecord = {
      key: "e-other",
      name: "ソラ",
      aliases: ["リクさん"],
    };
    expect(evaluate("リクさん", "e-riku", [RIKU, other])).toEqual({
      ok: false,
      reason: "exact-other",
    });
  });

  it("別の Entry の名前が敬称を外した形と同じなら partial-other", () => {
    const other: SurfaceAliasRecord = {
      key: "e-other",
      name: "リク",
      aliases: [],
    };
    const target: SurfaceAliasRecord = {
      key: "e-target",
      name: "リク",
      aliases: [],
    };
    expect(evaluate("リクさん", "e-target", [target, other])).toEqual({
      ok: false,
      reason: "partial-other",
    });
  });

  it("別の Entry の名前が表記を含めば partial-other", () => {
    const other: SurfaceAliasRecord = {
      key: "e-other",
      name: "リクさん家",
      aliases: [],
    };
    expect(evaluate("リクさん", "e-riku", [RIKU, other])).toEqual({
      ok: false,
      reason: "partial-other",
    });
  });

  it("結び先の除外語（JSON 文字列）が表記を含めば excluded", () => {
    const target: SurfaceAliasRecord = {
      ...RIKU,
      excludedAliases: '["リクさんち"]',
    };
    expect(evaluate("リクさん", "e-riku", [target])).toEqual({
      ok: false,
      reason: "excluded",
    });
  });

  it("除外語が配列でも excluded、表記を含まなければ ok", () => {
    const hit: SurfaceAliasRecord = {
      ...RIKU,
      excludedAliases: ["リクさんち"],
    };
    expect(evaluate("リクさん", "e-riku", [hit])).toEqual({
      ok: false,
      reason: "excluded",
    });
    const miss: SurfaceAliasRecord = { ...RIKU, excludedAliases: ["ソラ"] };
    expect(evaluate("リクさん", "e-riku", [miss])).toEqual({ ok: true });
  });

  it("excludedAliases が undefined なら除外を見ない", () => {
    const target: SurfaceAliasRecord = { ...RIKU };
    expect("excludedAliases" in target).toBe(false);
    expect(evaluate("リクさん", "e-riku", [target])).toEqual({ ok: true });
  });

  it("aliases が JSON 文字列でも配列でも、null でも動く", () => {
    const asJson: SurfaceAliasRecord = {
      key: "e-riku",
      name: "リク",
      aliases: '["陸斗"]',
    };
    const asArray: SurfaceAliasRecord = {
      key: "e-riku",
      name: "リク",
      aliases: ["陸斗"],
    };
    const asNull: SurfaceAliasRecord = {
      key: "e-riku",
      name: "リク",
      aliases: null,
    };
    expect(evaluate("陸斗くん", "e-riku", [asJson])).toEqual({ ok: true });
    expect(evaluate("陸斗くん", "e-riku", [asArray])).toEqual({ ok: true });
    expect(evaluate("陸斗くん", "e-riku", [asNull])).toEqual({
      ok: false,
      reason: "not-honorific-form",
    });
    expect(evaluate("リクさん", "e-riku", [asNull])).toEqual({ ok: true });
  });

  it("壊れた aliases の JSON 文字列は空の別名として扱う", () => {
    const broken: SurfaceAliasRecord = {
      key: "e-riku",
      name: "リク",
      aliases: "not-json",
    };
    expect(evaluate("リクさん", "e-riku", [broken])).toEqual({ ok: true });
  });
});

describe("withSurfaceAlias", () => {
  it("bind-existing で足すと aliasesToAdd に表記が入る", () => {
    const payload = bindPayload("リクさん", "e-riku");
    const next = withSurfaceAlias(payload, true);
    expect(next).not.toBe(payload);
    expect(
      next.binding.kind === "bind-existing" &&
        next.binding.enrichment.aliasesToAdd,
    ).toEqual(["リクさん"]);
    expect(hasSurfaceAlias(next)).toBe(true);
  });

  it("既に足してあれば足しても同じ参照を返す", () => {
    const payload = bindPayload("リクさん", "e-riku", {
      aliasesToAdd: ["リクさん"],
    });
    expect(withSurfaceAlias(payload, true)).toBe(payload);
  });

  it("外すと aliasesToAdd から表記が消え、他の別名は残る", () => {
    const payload = bindPayload("リクさん", "e-riku", {
      aliasesToAdd: ["りっくん", "リクさん"],
    });
    const next = withSurfaceAlias(payload, false);
    expect(
      next.binding.kind === "bind-existing" &&
        next.binding.enrichment.aliasesToAdd,
    ).toEqual(["りっくん"]);
    expect(hasSurfaceAlias(next)).toBe(false);
  });

  it("足していなければ外しても同じ参照を返す", () => {
    const payload = bindPayload("リクさん", "e-riku");
    expect(withSurfaceAlias(payload, false)).toBe(payload);
  });

  it("AI の明示の別名と同じ表記は外さない（同じ参照を返す）", () => {
    const payload = bindPayload("リクさん", "e-riku", {
      aliasesToAdd: ["リクさん"],
      aliases: [{ surface: "リクさん", status: "explicit" }],
    });
    expect(withSurfaceAlias(payload, false)).toBe(payload);
    expect(hasSurfaceAlias(payload)).toBe(false);
  });

  it("明示でない別名候補（user-confirmation-required）は外せる", () => {
    const payload = bindPayload("リクさん", "e-riku", {
      aliasesToAdd: ["リクさん"],
      aliases: [{ surface: "リクさん", status: "user-confirmation-required" }],
    });
    const next = withSurfaceAlias(payload, false);
    expect(hasSurfaceAlias(payload)).toBe(true);
    expect(
      next.binding.kind === "bind-existing" &&
        next.binding.enrichment.aliasesToAdd,
    ).toEqual([]);
  });

  it("previousSurface を渡すと前の表記の印を外して新しい名前で決め直す", () => {
    const payload = bindPayload("リクさま", "e-riku", {
      aliasesToAdd: ["リクさん"],
    });
    const next = withSurfaceAlias(payload, true, "リクさん");
    expect(
      next.binding.kind === "bind-existing" &&
        next.binding.enrichment.aliasesToAdd,
    ).toEqual(["リクさま"]);
  });

  it("create-new では何もしない（同じ参照）", () => {
    const payload = createNewPayload("リクさん");
    expect(withSurfaceAlias(payload, true)).toBe(payload);
    expect(withSurfaceAlias(payload, false)).toBe(payload);
  });

  it("空の表記は足さない", () => {
    const payload = bindPayload("  ", "e-riku");
    expect(withSurfaceAlias(payload, true)).toBe(payload);
  });
});

describe("hasSurfaceAlias", () => {
  it("create-new は false、足していなければ false", () => {
    expect(hasSurfaceAlias(createNewPayload("リクさん"))).toBe(false);
    expect(hasSurfaceAlias(bindPayload("リクさん", "e-riku"))).toBe(false);
  });

  it("aliasesToAdd に表記が入っていれば true", () => {
    expect(
      hasSurfaceAlias(
        bindPayload("リクさん", "e-riku", { aliasesToAdd: ["リクさん"] }),
      ),
    ).toBe(true);
  });

  it("別の表記だけが入っていれば false", () => {
    expect(
      hasSurfaceAlias(
        bindPayload("リクさん", "e-riku", { aliasesToAdd: ["りっくん"] }),
      ),
    ).toBe(false);
  });
});

describe("compilesToEntryPatch", () => {
  it("別名の追加か要約の fill があれば true", () => {
    expect(
      compilesToEntryPatch(
        bindPayload("リク", "e-riku", { aliasesToAdd: ["リクさん"] }),
      ),
    ).toBe(true);
    expect(
      compilesToEntryPatch(
        bindPayload("リク", "e-riku", {
          summary: { kind: "fill-if-empty", value: "少年" },
        }),
      ),
    ).toBe(true);
  });

  it("結び付けだけ・create-new は false", () => {
    expect(compilesToEntryPatch(bindPayload("リク", "e-riku"))).toBe(false);
    expect(compilesToEntryPatch(createNewPayload("リク"))).toBe(false);
  });
});

describe("hasOtherPatchOnSameEntry", () => {
  function view(
    proposalId: string,
    payload: BindCodexEntityPayload,
    extra: { status?: string; application?: unknown } = {},
  ): SameEntryProposalView {
    return {
      proposalId,
      status: extra.status ?? "pending",
      application: extra.application,
      proposal: { payload },
    };
  }
  const patching = bindPayload("リク", "e-riku", {
    aliasesToAdd: ["リクさん"],
  });
  const bindOnly = bindPayload("リク", "e-riku");

  it("同じ Entry に patch を書く他の提案があれば true", () => {
    expect(
      hasOtherPatchOnSameEntry([view("p-2", patching)], "p-1", "e-riku"),
    ).toBe(true);
    expect(
      hasOtherPatchOnSameEntry(
        [
          view(
            "p-2",
            bindPayload("リク", "e-riku", {
              summary: { kind: "fill-if-empty", value: "少年" },
            }),
          ),
        ],
        "p-1",
        "e-riku",
      ),
    ).toBe(true);
  });

  it("結び付けだけの他の提案は数えない", () => {
    expect(
      hasOtherPatchOnSameEntry([view("p-2", bindOnly)], "p-1", "e-riku"),
    ).toBe(false);
  });

  it("却下・取り込み済みの提案は数えない", () => {
    expect(
      hasOtherPatchOnSameEntry(
        [view("p-2", patching, { status: "rejected" })],
        "p-1",
        "e-riku",
      ),
    ).toBe(false);
    expect(
      hasOtherPatchOnSameEntry(
        [view("p-2", patching, { application: { appliedAt: 1 } })],
        "p-1",
        "e-riku",
      ),
    ).toBe(false);
  });

  it("自分自身は数えない", () => {
    expect(
      hasOtherPatchOnSameEntry([view("p-1", patching)], "p-1", "e-riku"),
    ).toBe(false);
  });

  it("別の Entry の提案・create-new は数えない", () => {
    expect(
      hasOtherPatchOnSameEntry(
        [
          view(
            "p-2",
            bindPayload("ソラ", "e-sora", { aliasesToAdd: ["ソラさん"] }),
          ),
          view("p-3", createNewPayload("リクさん")),
        ],
        "p-1",
        "e-riku",
      ),
    ).toBe(false);
  });

  it("提案が空なら false", () => {
    expect(hasOtherPatchOnSameEntry([], "p-1", "e-riku")).toBe(false);
  });
});

describe("patchBindCodexEntityPayload の addSurfaceAlias", () => {
  const aliasesToAddOf = (payload: BindCodexEntityPayload) =>
    payload.binding.kind === "bind-existing"
      ? payload.binding.enrichment.aliasesToAdd
      : null;

  it("addSurfaceAlias true で表記が結び先の別名に足される", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん", "e-riku"),
      { addSurfaceAlias: true },
    );
    expect(aliasesToAddOf(next)).toEqual(["リクさん"]);
  });

  it("addSurfaceAlias false で外れる", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん", "e-riku", { aliasesToAdd: ["リクさん"] }),
      { addSurfaceAlias: false },
    );
    expect(aliasesToAddOf(next)).toEqual([]);
  });

  it("bind-existing で名前を変えると前の表記の印が外れる", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん", "e-riku", { aliasesToAdd: ["リクさん"] }),
      { canonicalName: "リクさま" },
    );
    expect(next.canonicalName).toBe("リクさま");
    expect(aliasesToAddOf(next)).toEqual([]);
  });

  it("名前を変えて同時に addSurfaceAlias true なら新しい名前で足される", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん", "e-riku", { aliasesToAdd: ["リクさん"] }),
      { canonicalName: "リクくん", addSurfaceAlias: true },
    );
    expect(aliasesToAddOf(next)).toEqual(["リクくん"]);
  });

  it("名前を変えずに要約だけ変えても印は残る", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん", "e-riku", { aliasesToAdd: ["リクさん"] }),
      { summary: "少年" },
    );
    expect(aliasesToAddOf(next)).toEqual(["リクさん"]);
    expect(
      next.binding.kind === "bind-existing" && next.binding.enrichment.summary,
    ).toEqual({ kind: "fill-if-empty", value: "少年" });
  });

  it("同じ名前を渡し直しても印は残る", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん", "e-riku", { aliasesToAdd: ["リクさん"] }),
      { canonicalName: "リクさん" },
    );
    expect(aliasesToAddOf(next)).toEqual(["リクさん"]);
  });

  it("前後に空白のある名前を保ったまま要約だけ変えても印は残る", () => {
    const next = patchBindCodexEntityPayload(
      bindPayload("リクさん ", "e-riku", { aliasesToAdd: ["リクさん"] }),
      { summary: "少年" },
    );
    expect(aliasesToAddOf(next)).toEqual(["リクさん"]);
  });

  it("create-new では addSurfaceAlias を無視する", () => {
    const next = patchBindCodexEntityPayload(createNewPayload("リクさん"), {
      addSurfaceAlias: true,
    });
    expect(next.binding.kind).toBe("create-new");
    expect(next.binding).toEqual({
      kind: "create-new",
      entry: { name: "リクさん", aliases: [], summary: null },
    });
  });
});
