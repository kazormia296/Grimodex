import type { ImportTargetSpec } from "./importTargetSpec";
import type { ImportSourcePackage } from "./importSourcePackage";
import type { ImportDiagnostic } from "./importDiagnostics";

export type ImportSessionId = string & { readonly __brand: "ImportSessionId" };

export function createImportSessionId(value: string): ImportSessionId {
  return value as ImportSessionId;
}

export type ImportSessionState =
  | "created"
  | "package-attached"
  | "target-selected"
  | "structure-mapped"
  | "extraction-planned"
  | "commit-preview"
  | "committed"
  | "failed";

export interface ImportSession {
  readonly id: ImportSessionId;
  readonly state: ImportSessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly package?: ImportSourcePackage;
  readonly target?: ImportTargetSpec;
  readonly diagnostics: readonly ImportDiagnostic[];
}

export function createImportSession(
  now = new Date().toISOString(),
): ImportSession {
  const id = createImportSessionId(crypto.randomUUID());
  return {
    id,
    state: "created",
    createdAt: now,
    updatedAt: now,
    diagnostics: [],
  };
}

export function withImportSessionState(
  session: ImportSession,
  state: ImportSessionState,
  now = new Date().toISOString(),
): ImportSession {
  return { ...session, state, updatedAt: now };
}
