import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { buildScanImportPlan } from "../scan/scanImportPlan";
import {
  applyScanImportPlan,
  ScanImportApplyError,
} from "../scan/applyScanImportPlan";
import { createScanImportOperationsForPlan } from "../scan/scanImportOperations";

interface Props {
  onClose: () => void;
}

const MAX_SEED_BYTES = 32 * 1024 * 1024;

/** Desktop-only staged import of a private Scan editor seed. */
export function ScanImportFlow({ onClose }: Props) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<ReturnType<typeof buildScanImportPlan>>();
  const [isReading, setIsReading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string>();

  async function readSeed(file: File): Promise<void> {
    setError(undefined);
    setPlan(undefined);
    if (file.size > MAX_SEED_BYTES) {
      setError(t("import.scan.tooLarge"));
      return;
    }
    setIsReading(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setPlan(buildScanImportPlan(parsed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsReading(false);
    }
  }

  async function apply(): Promise<void> {
    if (!plan || isApplying) return;
    setError(undefined);
    setIsApplying(true);
    try {
      const result = await applyScanImportPlan(
        plan,
        createScanImportOperationsForPlan(plan),
      );
      toast.success(
        t("import.scan.success", {
          scenes: result.imported.tree,
          codex: result.imported.codexEntries,
          findings: result.imported.findings,
        }),
      );
      onClose();
    } catch (cause) {
      const message =
        cause instanceof ScanImportApplyError
          ? `${cause.stage}: ${String(cause.cause ?? cause.message)}`
          : cause instanceof Error
            ? cause.message
            : String(cause);
      setError(message);
      toast.error(t("import.scan.failed"));
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t("import.scan.description")}
      </p>
      <input
        type="file"
        accept="application/json,.json,.scan.json"
        disabled={isReading || isApplying}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void readSeed(file);
          event.currentTarget.value = "";
        }}
      />
      {isReading && <p className="text-sm">{t("import.analyzing")}</p>}
      {plan && (
        <div className="rounded border border-border p-3 text-sm">
          <p className="font-medium">{plan.projectTitle}</p>
          <p className="text-muted-foreground">
            {t("import.scan.preview", {
              sections: plan.nodes.length,
              codex: plan.codexEntries.length,
              events: plan.events.length,
              findings: plan.findings.length,
            })}
          </p>
          {plan.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded border px-3 py-1.5 text-sm"
          onClick={onClose}
        >
          {t("import.cancel")}
        </button>
        <button
          type="button"
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          disabled={!plan || isApplying || isReading}
          onClick={() => void apply()}
        >
          {isApplying ? t("import.importing") : t("import.scan.importButton")}
        </button>
      </div>
    </div>
  );
}
