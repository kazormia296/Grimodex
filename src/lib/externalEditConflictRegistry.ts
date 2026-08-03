interface ExternalEditConflictRegistration {
  documentId: string;
  documentKind: string | null;
}

const conflictsByStateKey = new Map<string, ExternalEditConflictRegistration>();

export function registerExternalEditConflict(
  stateKey: string,
  registration: ExternalEditConflictRegistration,
): void {
  conflictsByStateKey.set(stateKey, registration);
}

export function unregisterExternalEditConflict(stateKey: string): void {
  conflictsByStateKey.delete(stateKey);
}

export function clearExternalEditConflictRegistry(): void {
  conflictsByStateKey.clear();
}

export function hasExternalEditConflictForId(documentId: string): boolean {
  for (const conflict of conflictsByStateKey.values()) {
    if (conflict.documentId === documentId) return true;
  }
  return false;
}

export function hasExternalEditConflictForStateKey(stateKey: string): boolean {
  return conflictsByStateKey.has(stateKey);
}

export function hasExternalEditConflictForKind(
  documentKind: string,
  options: { includeLegacy?: boolean } = {},
): boolean {
  for (const conflict of conflictsByStateKey.values()) {
    if (
      conflict.documentKind === documentKind ||
      (options.includeLegacy === true && conflict.documentKind === null)
    ) {
      return true;
    }
  }
  return false;
}
