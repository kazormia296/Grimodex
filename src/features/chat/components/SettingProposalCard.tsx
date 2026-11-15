import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  agentSettingValuesEqual,
  getAgentSettingEntry,
  validateAgentSettingValue,
  type AgentSettingEntry,
} from "@/../electron/shared/agentSettingCatalog";
import { Button } from "@/components/ui/button";
import {
  applyAgentSettingChange,
  revertAgentSettingChange,
} from "@/features/settings/agentSettingApply";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { SettingProposal } from "../agent/agentTypes";
import { useSettingProposalStore } from "../agent/settingProposalStore";

interface SettingProposalCardProps {
  proposal: SettingProposal;
}

/** font-family の値（`"Noto Serif JP", serif` など）から先頭の family 名だけを表示用に取り出す。 */
function fontLabel(value: string): string {
  const first = value.split(",")[0]?.trim() ?? value;
  return first.replace(/^["']|["']$/g, "");
}

function useFormatValue() {
  const { t } = useTranslation();
  return (entry: AgentSettingEntry, value: string): string => {
    if (entry.type === "boolean") {
      return value === "true"
        ? t("chat.settingProposal.on")
        : t("chat.settingProposal.off");
    }
    if (entry.type === "font") return fontLabel(value);
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    if (entry.display === "px") return `${n}px`;
    if (entry.display === "percentTimes10") return `${n * 10}%`;
    return String(n);
  };
}

/**
 * agent の設定変更の提案カード（設計書 §6）。設定名・今の値→提案の値・理由と「適用」「却下」を出す。
 *
 * 描くのは executor が目録で検証して付けた提案（`ToolCallRecord.settingProposal`）だけで、
 * モデルの出力そのままからは描かない。適用は利用者のクリックだけで、適用の直前に再検証して
 * 既存の設定の書込み経路で書く。適用後は、今の値が適用した値のままなら「元に戻す」で前の値へ戻せる。
 */
export function SettingProposalCard({ proposal }: SettingProposalCardProps) {
  const { t } = useTranslation();
  const formatValue = useFormatValue();
  const entry = getAgentSettingEntry(proposal.key);
  const current = useSettingsStore((s) => (entry ? s.get(proposal.key) : ""));
  const outcome = useSettingProposalStore((s) => s.outcomes[proposal.id]);
  const record = useSettingProposalStore((s) => s.record);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 保存済みの履歴などで形が壊れた提案はカードにしない（font の選択肢は適用時に検証する）。
  if (
    !entry ||
    !validateAgentSettingValue(proposal.key, proposal.value, {
      fontFamilies: "shape-only",
    }).ok
  ) {
    return null;
  }

  const label = t(entry.labelKey);
  const alreadySet = agentSettingValuesEqual(
    proposal.key,
    current,
    proposal.value,
  );

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyAgentSettingChange(
        proposal.key,
        proposal.value,
      );
      if (result.ok) {
        record(proposal.id, {
          status: "applied",
          previous: result.previous,
          applied: result.applied,
        });
      } else {
        setError(
          t("chat.settingProposal.applyFailed", { message: result.message }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    if (outcome?.status !== "applied") return;
    const result = revertAgentSettingChange(
      proposal.key,
      outcome.applied,
      outcome.previous,
    );
    if (result.ok) {
      setError(null);
      record(proposal.id, { status: "reverted" });
    } else {
      setError(
        result.reason === "changed"
          ? t("chat.settingProposal.changedSince")
          : t("chat.settingProposal.undoFailed"),
      );
    }
  };

  const decided =
    outcome?.status === "dismissed" || outcome?.status === "reverted";
  const applied = outcome?.status === "applied";
  const canUndo =
    applied && agentSettingValuesEqual(proposal.key, current, outcome.applied);

  return (
    <section
      className="my-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
      data-testid={`setting-proposal-card-${proposal.id}`}
      aria-label={t("chat.settingProposal.aria", { label })}
    >
      <div className="text-xs text-muted-foreground">
        {t("chat.settingProposal.title")}
      </div>
      <div className="mt-0.5 font-medium text-foreground">{label}</div>
      {entry.descriptionKey && (
        <div className="text-xs text-muted-foreground">
          {t(entry.descriptionKey)}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-xs"
          data-testid="setting-proposal-before"
        >
          {formatValue(entry, applied ? outcome.previous : current)}
        </span>
        <span aria-hidden>→</span>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium"
          data-testid="setting-proposal-after"
        >
          {formatValue(entry, proposal.value)}
        </span>
      </div>
      {proposal.reason && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("chat.settingProposal.reason")}: {proposal.reason}
        </div>
      )}
      {error && (
        <div role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        {applied ? (
          <>
            <span className="mr-auto text-xs text-muted-foreground">
              {canUndo
                ? t("chat.settingProposal.applied")
                : t("chat.settingProposal.changedSince")}
            </span>
            {canUndo && (
              <Button type="button" variant="outline" size="sm" onClick={undo}>
                {t("chat.settingProposal.undo")}
              </Button>
            )}
          </>
        ) : decided ? (
          <span className="text-xs text-muted-foreground">
            {outcome.status === "dismissed"
              ? t("chat.settingProposal.dismissed")
              : t("chat.settingProposal.reverted")}
          </span>
        ) : alreadySet ? (
          <span className="text-xs text-muted-foreground">
            {t("chat.settingProposal.alreadySet")}
          </span>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => record(proposal.id, { status: "dismissed" })}
            >
              {t("chat.settingProposal.dismiss")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => void apply()}
            >
              {t("chat.settingProposal.apply")}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
