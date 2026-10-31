import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { TitleBar } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  exportSafeModeDiagnostics,
  listRecoveryCandidates,
  quarantineLiveDatabase,
  restoreRecoveryCandidate,
  verifyRecoveryCandidate,
} from "./api";
import type { RecoveryCandidate, RecoveryShellState } from "./types";

interface RecoveryShellProps {
  recovery: RecoveryShellState | null;
  onCandidatesUpdated?: (candidates: RecoveryCandidate[]) => void;
  onRetryOpen?: (workspacePath: string) => Promise<unknown>;
}

type BusyAction =
  | "refresh"
  | "quarantine"
  | "diagnostics"
  | "retry"
  | `verify:${string}`
  | `restore:${string}`;

export function RecoveryShell({
  recovery,
  onCandidatesUpdated,
  onRetryOpen,
}: RecoveryShellProps) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>(
    recovery?.candidates ?? [],
  );
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setCandidates(recovery?.candidates ?? []);
    setNotice(null);
  }, [recovery]);

  const preferredCandidateId = useMemo(
    () =>
      recovery?.snapshotId ??
      candidates.find((candidate) => candidate.checksumStatus === "verified")
        ?.id ??
      candidates[0]?.id ??
      null,
    [candidates, recovery?.snapshotId],
  );

  function publishCandidates(nextCandidates: RecoveryCandidate[]) {
    setCandidates(nextCandidates);
    onCandidatesUpdated?.(nextCandidates);
  }

  async function runAction<T>(
    action: BusyAction,
    work: () => Promise<T>,
  ): Promise<T | null> {
    if (busyAction) return null;
    setBusyAction(action);
    setNotice(null);
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
      setNotice(message);
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRefresh() {
    const refreshed = await runAction("refresh", listRecoveryCandidates);
    if (!refreshed) return;
    publishCandidates(refreshed);
    toast.success(t("workspace.recovery.toast.refreshed"));
  }

  async function handleVerify(candidateId: string) {
    const verified = await runAction(`verify:${candidateId}`, () =>
      verifyRecoveryCandidate(candidateId),
    );
    if (!verified) return;
    const nextCandidates = candidates.map((candidate) =>
      candidate.id === verified.id ? verified : candidate,
    );
    publishCandidates(nextCandidates);
    toast.success(t("workspace.recovery.toast.verified"));
  }

  async function handleRestore(candidateId: string) {
    const restored = await runAction(`restore:${candidateId}`, () =>
      restoreRecoveryCandidate(candidateId),
    );
    if (restored === null) return;
    const message = t("workspace.recovery.toast.restored");
    toast.success(message);
    setNotice(message);
  }

  async function handleQuarantine() {
    const fileName = await runAction("quarantine", quarantineLiveDatabase);
    if (!fileName) return;
    const message = t("workspace.recovery.toast.quarantined", { fileName });
    toast.success(message);
    setNotice(message);
  }

  async function handleExportDiagnostics() {
    const path = await runAction("diagnostics", exportSafeModeDiagnostics);
    if (!path) return;
    const message = t("workspace.recovery.toast.diagnosticsExported", { path });
    toast.success(message);
    setNotice(message);
  }

  async function handleRetryOpen() {
    if (!recovery || !onRetryOpen) return;
    await runAction("retry", () => onRetryOpen(recovery.workspacePath));
  }

  if (!recovery) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-background text-foreground">
        <TitleBar />
        <p className="text-sm text-muted-foreground">
          {t("workspace.recovery.noSession")}
        </p>
      </div>
    );
  }

  const busy = busyAction !== null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6 px-8 py-10">
        <header className="flex flex-col gap-4">
          <GrimodexLogo height={32} className="text-foreground" />
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-destructive">
              {t("workspace.recovery.band")}
            </p>
            <h1 className="mt-2 text-2xl font-semibold">
              {t("workspace.recovery.title")}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {t("workspace.recovery.description")}
            </p>
          </div>
        </header>

        <section className="grid gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <InfoRow
            label={t("workspace.recovery.info.mode")}
            value={
              recovery.mode === "safe-mode" ||
              recovery.mode === "recovery-required"
                ? t(`workspace.recovery.modes.${recovery.mode}`)
                : recovery.mode
            }
          />
          <InfoRow
            label={t("workspace.recovery.info.workspace")}
            value={recovery.workspacePath}
          />
          <InfoRow
            label={t("workspace.recovery.info.reason")}
            value={recovery.reason}
          />
          {recovery.errorCode && (
            <InfoRow
              label={t("workspace.recovery.info.errorCode")}
              value={recovery.errorCode}
            />
          )}
          {recovery.snapshotId && (
            <InfoRow
              label={t("workspace.recovery.info.preferredSnapshot")}
              value={recovery.snapshotId}
            />
          )}
        </section>

        <section className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleRefresh}
            disabled={busy}
          >
            {t("workspace.recovery.actions.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleQuarantine}
            disabled={busy}
          >
            {t("workspace.recovery.actions.quarantine")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleExportDiagnostics}
            disabled={busy}
          >
            {t("workspace.recovery.actions.diagnostics")}
          </Button>
          <Button
            type="button"
            onClick={handleRetryOpen}
            disabled={busy || !onRetryOpen}
          >
            {t("workspace.recovery.actions.retry")}
          </Button>
        </section>

        {notice && (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {notice}
          </p>
        )}

        <section className="min-h-0 overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">
                  {t("workspace.recovery.table.kind")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("workspace.recovery.table.created")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("workspace.recovery.table.schema")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("workspace.recovery.table.checksum")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("workspace.recovery.table.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {candidates.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    {t("workspace.recovery.table.empty")}
                  </td>
                </tr>
              ) : (
                candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    preferred={candidate.id === preferredCandidateId}
                    busyAction={busyAction}
                    onVerify={() => handleVerify(candidate.id)}
                    onRestore={() => handleRestore(candidate.id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

const KNOWN_KINDS: readonly string[] = [
  "automatic-backup",
  "manual-backup",
  "migration-snapshot",
];
const KNOWN_CHECKSUMS: readonly string[] = [
  "verified",
  "unverified",
  "invalid",
];

function isKnownKind(value: string): boolean {
  return KNOWN_KINDS.includes(value);
}

function isKnownChecksum(value: string): boolean {
  return KNOWN_CHECKSUMS.includes(value);
}

function CandidateRow({
  candidate,
  preferred,
  busyAction,
  onVerify,
  onRestore,
}: {
  candidate: RecoveryCandidate;
  preferred: boolean;
  busyAction: BusyAction | null;
  onVerify: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const restoreBusy = busyAction === `restore:${candidate.id}`;
  const verifyBusy = busyAction === `verify:${candidate.id}`;
  const disabled = busyAction !== null;

  return (
    <tr className={cn(preferred && "bg-primary/5")}>
      <td className="px-4 py-3 align-top">
        <div className="flex flex-col gap-1">
          <span className="font-medium">
            {isKnownKind(candidate.kind)
              ? t(`workspace.recovery.kinds.${candidate.kind}`)
              : candidate.kind}
          </span>
          {preferred && (
            <span className="text-xs text-primary">
              {t("workspace.recovery.table.recommended")}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 align-top text-muted-foreground">
        {candidate.createdAt}
      </td>
      <td className="px-4 py-3 align-top">
        {candidate.schemaVersion ?? t("workspace.recovery.table.unknownSchema")}
      </td>
      <td className="px-4 py-3 align-top">
        <span
          className={cn(
            "rounded-full px-2 py-1 text-xs font-medium",
            candidate.checksumStatus === "verified" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            candidate.checksumStatus === "unverified" &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            candidate.checksumStatus === "invalid" &&
              "bg-destructive/10 text-destructive",
          )}
        >
          {isKnownChecksum(candidate.checksumStatus)
            ? t(`workspace.recovery.checksum.${candidate.checksumStatus}`)
            : candidate.checksumStatus}
        </span>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onVerify}
            disabled={disabled}
          >
            {verifyBusy
              ? t("workspace.recovery.actions.verifying")
              : t("workspace.recovery.actions.verify")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onRestore}
            disabled={disabled || candidate.checksumStatus === "invalid"}
          >
            {restoreBusy
              ? t("workspace.recovery.actions.restoring")
              : t("workspace.recovery.actions.restore")}
          </Button>
        </div>
      </td>
    </tr>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr]">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words font-mono text-xs">{value}</dd>
    </div>
  );
}
