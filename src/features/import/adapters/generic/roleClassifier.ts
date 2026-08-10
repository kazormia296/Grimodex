import type { DecodedImportResource } from "../../decoders/decoderTypes";
import { extensionOfPath } from "../../decoders/decoderProbe";
import type {
  GenericImportResourceRole,
  GenericResourceRoleAssignment,
  ImportResourceDisposition,
} from "./resourceRole";
import { matchRoleRules } from "./roleRules";

export interface ResourceRoleResolution {
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly role: GenericImportResourceRole;
  readonly disposition: ImportResourceDisposition;
  readonly confidence: GenericResourceRoleAssignment["confidence"];
  readonly ruleId?: string;
  readonly candidates: readonly GenericImportResourceRole[];
  readonly status: "resolved" | "ambiguous" | "unsupported";
}

const DEFAULT_DISPOSITION: Readonly<
  Record<GenericImportResourceRole, ImportResourceDisposition>
> = {
  manuscript: "import-and-extract",
  outline: "retain-source-only",
  "character-reference": "extract-structure-only",
  "world-reference": "extract-structure-only",
  glossary: "extract-structure-only",
  "timeline-reference": "extract-structure-only",
  "plot-reference": "retain-source-only",
  "snippet-library": "import-and-extract",
  "chat-log": "import-and-extract",
  "project-metadata": "extract-structure-only",
  "research-reference": "retain-source-only",
  attachment: "ignore",
  ignore: "ignore",
  unknown: "retain-source-only",
};

export function dispositionForRole(
  role: GenericImportResourceRole,
): ImportResourceDisposition {
  return DEFAULT_DISPOSITION[role];
}

export function classifyResourceRole(
  resource: Pick<
    DecodedImportResource,
    "resourceKey" | "relativePath" | "kind" | "structuredData"
  >,
): ResourceRoleResolution {
  const extension = extensionOfPath(resource.relativePath);
  const tableHeaders =
    resource.kind === "table" &&
    resource.structuredData &&
    typeof resource.structuredData === "object" &&
    !Array.isArray(resource.structuredData) &&
    "headers" in resource.structuredData
      ? ((resource.structuredData as { headers?: string[] }).headers ?? [])
      : undefined;

  const matches = matchRoleRules({
    relativePath: resource.relativePath,
    extension,
    tableHeaders,
  });

  const candidates = [...new Set(matches.map((match) => match.role))];
  const best = matches[0];
  const role = best?.role ?? "unknown";
  const status =
    candidates.length > 1
      ? "ambiguous"
      : role === "unknown"
        ? "unsupported"
        : "resolved";

  return {
    resourceKey: resource.resourceKey,
    relativePath: resource.relativePath,
    role,
    disposition: dispositionForRole(role),
    confidence: best ? "rule" : "heuristic",
    ruleId: best?.ruleId,
    candidates: candidates.length > 0 ? candidates : [role],
    status,
  };
}

export function classifyResources(
  resources: readonly DecodedImportResource[],
): readonly ResourceRoleResolution[] {
  return resources.map((resource) => classifyResourceRole(resource));
}
