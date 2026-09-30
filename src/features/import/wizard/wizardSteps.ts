export type ImportWizardStepId =
  | "source"
  | "parse-preview"
  | "target"
  | "structure-mapping"
  | "extraction"
  | "commit-preview";

export const IMPORT_WIZARD_STEPS: readonly {
  readonly id: ImportWizardStepId;
  readonly labelKey: string;
}[] = [
  { id: "source", labelKey: "import.wizard.step.source" },
  { id: "parse-preview", labelKey: "import.wizard.step.parsePreview" },
  { id: "target", labelKey: "import.wizard.step.target" },
  { id: "structure-mapping", labelKey: "import.wizard.step.structureMapping" },
  { id: "extraction", labelKey: "import.wizard.step.extraction" },
  { id: "commit-preview", labelKey: "import.wizard.step.commitPreview" },
] as const;

export function nextWizardStep(
  current: ImportWizardStepId,
): ImportWizardStepId | null {
  const index = IMPORT_WIZARD_STEPS.findIndex((s) => s.id === current);
  if (index < 0 || index >= IMPORT_WIZARD_STEPS.length - 1) return null;
  return IMPORT_WIZARD_STEPS[index + 1]!.id;
}

export function previousWizardStep(
  current: ImportWizardStepId,
): ImportWizardStepId | null {
  const index = IMPORT_WIZARD_STEPS.findIndex((s) => s.id === current);
  if (index <= 0) return null;
  return IMPORT_WIZARD_STEPS[index - 1]!.id;
}
