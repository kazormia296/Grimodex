import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CodexExtractionEvidencePane } from "./CodexExtractionEvidencePane";
import { CodexEntityProposalCard } from "./CodexEntityProposalCard";
import { CodexEntityResolutionPicker } from "./CodexEntityResolutionPicker";
import {
  catalogEntityDisplayName,
  bulkApproveSafeCodexStructureProposals,
  readCurrentCodexEntries,
  decideCodexStructureProposal,
  reviseCodexStructureProposal,
  resolveCodexStructureBinding,
  surfaceAliasVerdictForReview,
  CodexSurfaceAliasNotAllowedError,
} from "./codexStructureExtractionApi";
import {
  PERSON_TYPE_SLUG,
  type CurrentCodexEntryRecord,
} from "./extraction/entityBulkSafety";
import {
  hasSurfaceAlias,
  type SurfaceAliasDecline,
} from "./extraction/surfaceAlias";
import {
  isSafeForCodexEntityBulkApprove,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexReviewEvidenceQuote,
} from "./codexStructureExtractionStore";

export interface CodexEntityProposalReviewProps {
  readonly proposals?: readonly CodexEntityReviewProposal[];
  readonly selectedProposalId?: string | null;
  readonly onSelectProposal?: (proposalId: string) => void;
  readonly onEvidenceClick?: (evidence: CodexReviewEvidenceQuote) => void;
  /** When true, reads/writes the codexStructureExtractionStore. */
  readonly boundToStore?: boolean;
  /**
   * 今の Codex の Entry の読み出し（プロジェクト全体）。一括承認の再検査と、承認で固定する op の版に
   * 使う（run 時点の版でなく今の版）。既定は DB。画面の store は検索・種別で絞られるので使わない。
   */
  readonly readEntries?: (
    projectId: string,
  ) => Promise<readonly CurrentCodexEntryRecord[]>;
}

/** 別名に足せない理由のうち、画面で作者に知らせるもの（敬称の形ではあるが足せない場合）。 */
const SURFACE_ALIAS_NOTE_KEYS: Partial<Record<SurfaceAliasDecline, string>> = {
  "same-entry-patch": "sameEntryPatch",
  "exact-other": "exactOther",
  "partial-other": "partialOther",
  excluded: "excluded",
};

/**
 * Entity Proposal list + detail split (mirrors Chronicle Proposal Review).
 */
export function CodexEntityProposalReview({
  proposals: proposalsProp,
  selectedProposalId: selectedProp,
  onSelectProposal,
  onEvidenceClick,
  boundToStore = true,
  readEntries = readCurrentCodexEntries,
}: CodexEntityProposalReviewProps) {
  const { t } = useTranslation();
  const storeProjection = useCodexStructureExtractionStore((s) => s.projection);
  const storeSelected = useCodexStructureExtractionStore(
    (s) => s.selectedProposalId,
  );
  const selectProposal = useCodexStructureExtractionStore(
    (s) => s.selectProposal,
  );
  const proposals = proposalsProp ?? storeProjection?.proposals ?? [];
  const selectedProposalId =
    selectedProp !== undefined
      ? selectedProp
      : boundToStore
        ? storeSelected
        : (proposals[0]?.proposalId ?? null);

  const selected = useMemo(
    () =>
      proposals.find(
        (proposal) => proposal.proposalId === selectedProposalId,
      ) ?? null,
    [proposals, selectedProposalId],
  );

  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftSummary, setDraftSummary] = useState<string | null>(null);
  const [bulkApproving, setBulkApproving] = useState(false);

  const nameValue =
    draftName ??
    selected?.proposal.payload.canonicalName ??
    selected?.displayTitle ??
    "";
  const summaryValue = (() => {
    if (draftSummary !== null) return draftSummary;
    if (!selected) return "";
    const binding = selected.proposal.payload.binding;
    if (binding.kind === "create-new") return binding.entry.summary ?? "";
    if (
      binding.kind === "bind-existing" &&
      binding.enrichment.summary.kind === "fill-if-empty"
    ) {
      return binding.enrichment.summary.value;
    }
    return "";
  })();

  const handleSelect = (proposalId: string) => {
    setDraftName(null);
    setDraftSummary(null);
    if (onSelectProposal) onSelectProposal(proposalId);
    else if (boundToStore) selectProposal(proposalId);
  };

  const safeProposals = proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "unreviewed" &&
      isSafeForCodexEntityBulkApprove(proposal.safety),
  );
  const safeCount = safeProposals.length;
  const safeBindCount = safeProposals.filter(
    (proposal) => proposal.proposal.payload.binding.kind === "bind-existing",
  ).length;
  const safeCreateCount = safeCount - safeBindCount;
  // 一括で通した結び付け（取り込み前）。作者が見返す一覧（T3）。
  const bulkBound = proposals.filter(
    (proposal) =>
      proposal.bulkApprovedExactBind === true &&
      proposal.status === "approved" &&
      !proposal.application,
  );

  const applied = Boolean(selected?.application);
  const unresolvedBinding =
    !applied && selected?.proposal.payload.binding.kind === "unresolved"
      ? selected.proposal.payload.binding
      : null;

  const candidateLabels = useMemo(() => {
    const catalog = storeProjection?.catalog;
    if (!catalog) return undefined;
    return new Map(
      catalog.entities.map((entity) => [
        entity.ref,
        catalogEntityDisplayName(entity.ref, catalog),
      ]),
    );
  }, [storeProjection?.catalog]);

  const targetNameOf = (proposal: CodexEntityReviewProposal) => {
    const binding = proposal.proposal.payload.binding;
    if (binding.kind !== "bind-existing") return undefined;
    return catalogEntityDisplayName(
      binding.entityRef,
      storeProjection?.catalog,
    );
  };

  // 打ち手 1：結び先に選んだ表記を別名にも足すか（既定 OFF）。画面の判定は run の catalog での
  // 見込み（除外語は見ない）。チェックを入れる時・承認時・Apply の前に、今の Codex で確かめ直す。
  const surfaceAlias = (() => {
    if (
      !selected ||
      applied ||
      !boundToStore ||
      !storeProjection ||
      selected.proposal.payload.binding.kind !== "bind-existing"
    ) {
      return null;
    }
    const payload = selected.proposal.payload;
    // AI の明示の別名に同じ表記があれば、既に足される（チェックは効かない）ので出さない。
    if (
      payload.aliases.some(
        (alias) =>
          alias.status === "explicit" &&
          alias.surface === payload.canonicalName.trim(),
      )
    ) {
      return null;
    }
    const on = hasSurfaceAlias(payload);
    const base = surfaceAliasVerdictForReview(
      selected,
      storeProjection,
      undefined,
      { sameEntry: false },
    );
    const verdict = base.ok
      ? surfaceAliasVerdictForReview(selected, storeProjection)
      : base;
    const noteKey = verdict.ok
      ? undefined
      : SURFACE_ALIAS_NOTE_KEYS[verdict.reason];
    if (!on && !verdict.ok && !noteKey) return null;
    // 一括承認（打ち手 2）は結び先が人物の型のときだけなので、連鎖の文言もそのときだけ出す。
    const binding = payload.binding;
    const targetTypeRef =
      binding.kind === "bind-existing"
        ? storeProjection.catalog?.entities.find(
            (entity) => entity.ref === binding.entityRef,
          )?.typeRef
        : undefined;
    const targetIsPerson =
      storeProjection.catalog?.types.find((type) => type.ref === targetTypeRef)
        ?.slug === PERSON_TYPE_SLUG;
    return {
      on,
      verdict,
      noteKey,
      targetIsPerson,
      surface: payload.canonicalName,
      name: targetNameOf(selected) ?? "",
    };
  })();

  const surfaceAliasErrorMessage = (error: unknown) => {
    if (error instanceof CodexSurfaceAliasNotAllowedError) {
      return t(
        `codex.structureReview.surfaceAlias.notAllowed.${
          SURFACE_ALIAS_NOTE_KEYS[error.reason] ?? "generic"
        }`,
      );
    }
    return error instanceof Error
      ? error.message
      : t("codex.structureReview.surfaceAlias.saveFailed");
  };

  return (
    <div
      className="grid min-h-[220px] grid-cols-1 gap-2 overflow-hidden rounded border border-border md:grid-cols-[minmax(180px,38%)_1fr]"
      data-testid="codex-entity-proposal-review"
    >
      <div className="flex max-h-80 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            Entity Proposal
          </span>
          {boundToStore && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeCount === 0 || bulkApproving}
              onClick={() => {
                setBulkApproving(true);
                void bulkApproveSafeCodexStructureProposals({ readEntries })
                  .then((result) => {
                    if (result.failed.length > 0) {
                      toast.error(
                        `${result.failed.length}件の提案を承認できませんでした`,
                      );
                    }
                    if (result.approvedBindExisting > 0) {
                      toast.success(
                        t("codex.structureReview.bulkApproved", {
                          count: result.approved,
                          createCount: result.approvedCreateNew,
                          bindCount: result.approvedBindExisting,
                        }),
                      );
                    }
                    const excluded = result.excluded;
                    const unreadable = excluded.filter(
                      (item) => item.reason === "codex-unreadable",
                    ).length;
                    const noLongerSafe = excluded.filter(
                      (item) => item.reason === "no-longer-safe",
                    ).length;
                    const rechecked =
                      excluded.length - unreadable - noLongerSafe;
                    if (unreadable > 0) {
                      toast.warning(
                        t("codex.structureReview.bulkCodexUnreadable", {
                          count: unreadable,
                        }),
                      );
                    }
                    if (rechecked > 0) {
                      toast.warning(
                        t("codex.structureReview.bulkExcluded", {
                          count: rechecked,
                        }),
                      );
                    }
                    if (noLongerSafe > 0) {
                      toast.warning(
                        t("codex.structureReview.bulkNoLongerSafe", {
                          count: noLongerSafe,
                        }),
                      );
                    }
                  })
                  .catch((error) => {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "まとめて承認に失敗しました",
                    );
                  })
                  .finally(() => {
                    setBulkApproving(false);
                  });
              }}
              data-testid="codex-bulk-approve-safe"
            >
              安全な提案をまとめて承認
              {safeCount > 0 ? ` (${safeCount})` : ""}
            </button>
          )}
        </div>
        {boundToStore && safeCount > 0 && (
          <p
            className="border-b border-border px-2 py-1 text-[10px] text-muted-foreground"
            data-testid="codex-bulk-approve-breakdown"
          >
            {t("codex.structureReview.bulkBreakdown", {
              createCount: safeCreateCount,
              bindCount: safeBindCount,
            })}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              抽出できる Entity が見つかりませんでした。
            </p>
          ) : (
            proposals.map((proposal) => (
              <CodexEntityProposalCard
                key={proposal.proposalId}
                proposal={proposal}
                selected={proposal.proposalId === selectedProposalId}
                targetName={targetNameOf(proposal)}
                onSelect={() => handleSelect(proposal.proposalId)}
                onDecide={(status) => {
                  if (!boundToStore) return;
                  void (async () => {
                    // 既存 Entry への結び付けの承認は、今の Codex の版で op を固定する。
                    // 読めなければ run 時点の版のまま承認し、古ければ Apply の前に外れる。
                    let entries: readonly CurrentCodexEntryRecord[] | undefined;
                    if (
                      status === "approved" &&
                      proposal.proposal.payload.binding.kind ===
                        "bind-existing" &&
                      storeProjection
                    ) {
                      try {
                        entries = await readEntries(storeProjection.projectId);
                      } catch {
                        entries = undefined;
                      }
                    }
                    await decideCodexStructureProposal({
                      proposalId: proposal.proposalId,
                      status,
                      ...(entries ? { entries } : {}),
                    });
                  })().catch((error) => {
                    toast.error(
                      error instanceof CodexSurfaceAliasNotAllowedError
                        ? surfaceAliasErrorMessage(error)
                        : error instanceof Error
                          ? error.message
                          : t("codex.structureReview.errorSave"),
                    );
                  });
                }}
              />
            ))
          )}
          {bulkBound.length > 0 && (
            <details
              className="border-t border-border px-2 py-1.5"
              data-testid="codex-bulk-bound-list"
            >
              <summary className="cursor-pointer text-[11px] font-medium text-foreground">
                {t("codex.structureReview.boundList.title", {
                  count: bulkBound.length,
                })}
              </summary>
              <p className="py-1 text-[10px] text-muted-foreground">
                {t("codex.structureReview.boundList.hint")}
              </p>
              <ul className="flex flex-col gap-0.5">
                {bulkBound.map((proposal) => (
                  <li key={proposal.proposalId}>
                    <button
                      type="button"
                      className="w-full truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent/40"
                      onClick={() => handleSelect(proposal.proposalId)}
                      data-testid={`codex-bulk-bound-item-${proposal.proposalId}`}
                    >
                      {t("codex.structureReview.boundList.item", {
                        surface: proposal.proposal.payload.canonicalName,
                        target: targetNameOf(proposal) ?? "",
                      })}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      <div className="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto px-3 py-2">
        <span className="text-xs font-medium text-foreground">詳細</span>
        {!selected ? (
          <p className="text-xs text-muted-foreground">
            提案を選択してください
          </p>
        ) : (
          <>
            {applied && (
              <p
                className="text-[10px] text-muted-foreground"
                data-testid="codex-entity-applied-readonly"
              >
                適用済みのため編集できません
              </p>
            )}
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Canonical Name</span>
              <input
                className="rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
                value={nameValue}
                disabled={applied}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => {
                  if (!boundToStore || applied || draftName === null) return;
                  void reviseCodexStructureProposal({
                    proposalId: selected.proposalId,
                    patch: { canonicalName: draftName },
                  })
                    .catch((error) => {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Entity 名の保存に失敗しました",
                      );
                    })
                    .finally(() => setDraftName(null));
                }}
                data-testid="codex-entity-name-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Summary</span>
              <textarea
                className="min-h-[64px] rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
                value={summaryValue}
                disabled={applied}
                onChange={(event) => setDraftSummary(event.target.value)}
                onBlur={() => {
                  if (!boundToStore || applied || draftSummary === null) return;
                  void reviseCodexStructureProposal({
                    proposalId: selected.proposalId,
                    patch: { summary: draftSummary },
                  })
                    .catch((error) => {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Summary の保存に失敗しました",
                      );
                    })
                    .finally(() => setDraftSummary(null));
                }}
                data-testid="codex-entity-summary-input"
              />
            </label>

            {!applied &&
              selected.proposal.payload.typeResolution.status !== "resolved" &&
              boundToStore &&
              storeProjection?.catalog?.types &&
              storeProjection.catalog.types.length > 0 && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Codex Type</span>
                  <select
                    className="rounded border border-input bg-background px-2 py-1 text-sm"
                    value=""
                    onChange={(event) => {
                      const typeRef = event.target.value;
                      if (!typeRef) return;
                      void reviseCodexStructureProposal({
                        proposalId: selected.proposalId,
                        patch: { typeRef },
                      }).catch((error) => {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "Type の保存に失敗しました",
                        );
                      });
                    }}
                    data-testid="codex-entity-type-select"
                  >
                    <option value="">選択してください</option>
                    {storeProjection.catalog.types.map((type) => (
                      <option key={type.ref} value={type.ref}>
                        {type.label} ({type.ref})
                      </option>
                    ))}
                  </select>
                </label>
              )}

            {unresolvedBinding && boundToStore && (
              <CodexEntityResolutionPicker
                allowCreateNew={unresolvedBinding.allowCreateNew}
                candidates={unresolvedBinding.candidates}
                candidateLabels={candidateLabels}
                onCreateNew={() =>
                  void resolveCodexStructureBinding({
                    proposalId: selected.proposalId,
                    resolution: { kind: "create-new" },
                  }).catch((error) => {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Binding 解決に失敗しました",
                    );
                  })
                }
                onUseExisting={(entityRef) =>
                  void resolveCodexStructureBinding({
                    proposalId: selected.proposalId,
                    resolution: { kind: "bind-existing", entityRef },
                  }).catch((error) => {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Binding 解決に失敗しました",
                    );
                  })
                }
              />
            )}

            {surfaceAlias &&
              (surfaceAlias.on || surfaceAlias.verdict.ok ? (
                <div
                  className="flex flex-col gap-1 rounded border border-border px-2 py-1.5 text-xs"
                  data-testid="codex-surface-alias"
                >
                  <label className="flex items-center gap-2 text-foreground">
                    <input
                      type="checkbox"
                      checked={surfaceAlias.on}
                      onChange={(event) => {
                        void reviseCodexStructureProposal({
                          proposalId: selected.proposalId,
                          patch: { addSurfaceAlias: event.target.checked },
                          readEntries,
                        }).catch((error) => {
                          toast.error(surfaceAliasErrorMessage(error));
                        });
                      }}
                      data-testid="codex-surface-alias-toggle"
                    />
                    {t("codex.structureReview.surfaceAlias.label", {
                      surface: surfaceAlias.surface,
                      name: surfaceAlias.name,
                    })}
                  </label>
                  <span className="text-muted-foreground">
                    {t(
                      surfaceAlias.targetIsPerson
                        ? "codex.structureReview.surfaceAlias.hint"
                        : "codex.structureReview.surfaceAlias.hintNoBulk",
                      {
                        surface: surfaceAlias.surface,
                        name: surfaceAlias.name,
                      },
                    )}
                  </span>
                  {surfaceAlias.on && !surfaceAlias.verdict.ok && (
                    <span
                      className="text-destructive"
                      data-testid="codex-surface-alias-warning"
                    >
                      {t(
                        `codex.structureReview.surfaceAlias.notAllowed.${
                          surfaceAlias.noteKey ?? "generic"
                        }`,
                      )}
                    </span>
                  )}
                </div>
              ) : (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="codex-surface-alias-note"
                >
                  {t(
                    `codex.structureReview.surfaceAlias.notAllowed.${surfaceAlias.noteKey}`,
                  )}
                </p>
              ))}

            <CodexExtractionEvidencePane
              proposal={selected}
              onEvidenceClick={onEvidenceClick}
            />
          </>
        )}
      </div>
    </div>
  );
}
