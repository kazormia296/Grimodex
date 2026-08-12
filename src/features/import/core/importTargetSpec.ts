export interface NewProjectImportTarget {
  readonly kind: "new-project";
  readonly title: string;
  readonly genre?: string;
  readonly language?: string;
}

export interface ExistingProjectImportTarget {
  readonly kind: "existing-project";
  readonly projectId: string;
}

export type ImportTargetSpec =
  | NewProjectImportTarget
  | ExistingProjectImportTarget;

export function isNewProjectImportTarget(
  target: ImportTargetSpec,
): target is NewProjectImportTarget {
  return target.kind === "new-project";
}

export function isExistingProjectImportTarget(
  target: ImportTargetSpec,
): target is ExistingProjectImportTarget {
  return target.kind === "existing-project";
}
