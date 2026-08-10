import type { ImportSession, ImportSessionId } from "@/features/import/core/importSession";
import {
  createImportSession,
  withImportSessionState,
} from "@/features/import/core/importSession";
import { sealImportSourcePackage } from "@/features/import/core/importSourcePackage";
import type { ImportTargetSpec } from "@/features/import/core/importTargetSpec";
import { importDiagnostic } from "@/features/import/core/importDiagnostics";

const sessions = new Map<ImportSessionId, ImportSession>();

export function createSessionInMemory(): ImportSession {
  const session = createImportSession();
  sessions.set(session.id, session);
  return session;
}

export function getImportSession(id: ImportSessionId): ImportSession | undefined {
  return sessions.get(id);
}

export function clearImportSessionsForTests(): void {
  sessions.clear();
}

export async function attachPackageToSession(
  sessionId: ImportSessionId,
  draft: Parameters<typeof sealImportSourcePackage>[0],
): Promise<ImportSession> {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Import session not found: ${sessionId}`);
  }

  const pkg = await sealImportSourcePackage(draft);
  const updated = withImportSessionState(
    { ...existing, package: pkg, diagnostics: [...existing.diagnostics, ...pkg.diagnostics] },
    "package-attached",
  );
  sessions.set(sessionId, updated);
  return updated;
}

export function attachTargetToSession(
  sessionId: ImportSessionId,
  target: ImportTargetSpec,
): ImportSession {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Import session not found: ${sessionId}`);
  }
  const updated = withImportSessionState({ ...existing, target }, "target-selected");
  sessions.set(sessionId, updated);
  return updated;
}

/** Optional native persistence hook; falls back to in-memory when unavailable. */
export async function persistImportSessionNative(
  session: ImportSession,
): Promise<void> {
  const invoke = (globalThis as { grimodex?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> } })
    .grimodex?.invoke;
  if (!invoke) return;
  try {
    await invoke("import_session_save", { session });
  } catch {
    // Native command not wired yet — in-memory session remains authoritative.
  }
}

export function failImportSession(
  sessionId: ImportSessionId,
  message: string,
): ImportSession {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Import session not found: ${sessionId}`);
  }
  const updated = withImportSessionState(
    {
      ...existing,
      diagnostics: [
        ...existing.diagnostics,
        importDiagnostic("error", "session-failed", message),
      ],
    },
    "failed",
  );
  sessions.set(sessionId, updated);
  return updated;
}
