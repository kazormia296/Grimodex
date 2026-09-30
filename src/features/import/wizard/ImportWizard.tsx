import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listImportAdapters, getImportAdapter } from "../adapters/registry";
import type { ImportSourcePackageDraft } from "../core/importSourcePackage";
import type { ImportDiagnostic } from "../core/importDiagnostics";
import {
  IMPORT_WIZARD_STEPS,
  nextWizardStep,
  previousWizardStep,
  type ImportWizardStepId,
} from "./wizardSteps";
import { ImportSourceStep } from "./ImportSourceStep";
import { ImportParsePreviewStep } from "./ImportParsePreviewStep";
import {
  ImportTargetStep,
  buildTargetSpecFromWizard,
} from "./ImportTargetStep";
import { ImportStructureMappingStep } from "./ImportStructureMappingStep";
import { ImportExtractionStep } from "./ImportExtractionStep";
import { ImportCommitPreviewStep } from "./ImportCommitPreviewStep";
import type { ImportTargetSpec } from "../core/importTargetSpec";
import { markdownImportAdapter } from "../adapters/markdown/markdownImportAdapter";
import { GenericImportWizardPreview } from "./generic/GenericImportWizardPreview";

interface Props {
  readonly onClose: () => void;
}

export function ImportWizard({ onClose }: Props) {
  const { t } = useTranslation();
  const adapters = useMemo(() => listImportAdapters(), []);
  const [step, setStep] = useState<ImportWizardStepId>("source");
  const [selectedAdapterId, setSelectedAdapterId] = useState<string | null>(
    adapters[0]?.id ?? null,
  );
  const [draft, setDraft] = useState<ImportSourcePackageDraft | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly ImportDiagnostic[]>(
    [],
  );
  const [targetKind, setTargetKind] = useState<
    "new-project" | "existing-project"
  >("new-project");
  const [title, setTitle] = useState("Imported");
  const [target, setTarget] = useState<ImportTargetSpec | null>(null);

  const runSoftParse = useCallback(async () => {
    const adapter =
      getImportAdapter(selectedAdapterId ?? "", "1") ?? markdownImportAdapter;
    const result = await Promise.resolve(
      adapter.parse({
        kind: "plain-text",
        label: "wizard-preview",
        data: { title, text: "" },
      }),
    );
    setDraft(result.draft ?? null);
    setDiagnostics(result.diagnostics);
  }, [selectedAdapterId, title]);

  const handleNext = useCallback(() => {
    if (step === "source") {
      void runSoftParse();
    }
    if (step === "target") {
      setTarget(buildTargetSpecFromWizard({ targetKind, title }));
    }
    const next = nextWizardStep(step);
    if (next) setStep(next);
  }, [runSoftParse, step, targetKind, title]);

  const handleBack = useCallback(() => {
    const prev = previousWizardStep(step);
    if (prev) setStep(prev);
  }, [step]);

  const stepIndex = IMPORT_WIZARD_STEPS.findIndex((s) => s.id === step);
  const isGenericAdapter = selectedAdapterId === "generic";

  if (isGenericAdapter && step === "source") {
    return <GenericImportWizardPreview onClose={onClose} />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="import-wizard"
    >
      <div className="flex shrink-0 flex-wrap gap-1">
        {IMPORT_WIZARD_STEPS.map((wizardStep, index) => (
          <span
            key={wizardStep.id}
            className={`rounded px-2 py-0.5 text-[10px] ${
              wizardStep.id === step
                ? "bg-primary text-primary-foreground"
                : index < stepIndex
                  ? "bg-muted text-foreground"
                  : "bg-muted/50 text-muted-foreground"
            }`}
          >
            {t(wizardStep.labelKey, wizardStep.id)}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === "source" && (
          <ImportSourceStep
            adapters={adapters}
            selectedAdapterId={selectedAdapterId}
            onSelectAdapter={setSelectedAdapterId}
          />
        )}
        {step === "parse-preview" && (
          <ImportParsePreviewStep draft={draft} diagnostics={diagnostics} />
        )}
        {step === "target" && (
          <ImportTargetStep
            targetKind={targetKind}
            title={title}
            onTargetKindChange={setTargetKind}
            onTitleChange={setTitle}
          />
        )}
        {step === "structure-mapping" && (
          <ImportStructureMappingStep nodes={draft?.nodes ?? []} />
        )}
        {step === "extraction" && (
          <ImportExtractionStep
            codexCount={draft?.structure.codexEntries.length ?? 0}
            snippetCount={draft?.structure.snippets.length ?? 0}
          />
        )}
        {step === "commit-preview" && (
          <ImportCommitPreviewStep draft={draft} target={target} />
        )}
      </div>

      <div className="flex shrink-0 justify-between gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
          onClick={onClose}
        >
          {t("common.cancel", "キャンセル")}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="import-wizard-back"
            disabled={stepIndex <= 0}
            onClick={handleBack}
            className="rounded bg-muted px-3 py-1.5 text-xs disabled:opacity-40"
          >
            戻る
          </button>
          <button
            type="button"
            data-testid="import-wizard-next"
            disabled={step === "commit-preview"}
            onClick={handleNext}
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}
