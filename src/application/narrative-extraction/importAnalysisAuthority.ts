import type { ImportSession } from "@/features/import/core/importSession";
import type { ImportSourcePackage } from "@/features/import/core/importSourcePackage";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";

export interface ImportSessionAiAnalysisAuthority {
  readonly sessionId: ImportSession["id"];
  readonly packageDigest: ImportSourcePackage["digest"];
  readonly sourceSetId: string;
  readonly authority: MutationAuthority;
  readonly pipelineVersion: "import-session-stub@1";
}

export function buildImportSessionAuthority(input: {
  readonly session: ImportSession;
  readonly authority: MutationAuthority;
}): ImportSessionAiAnalysisAuthority | null {
  const pkg = input.session.package;
  if (!pkg) return null;
  return {
    sessionId: input.session.id,
    packageDigest: pkg.digest,
    sourceSetId: pkg.identity.sourceSetId,
    authority: input.authority,
    pipelineVersion: "import-session-stub@1",
  };
}
