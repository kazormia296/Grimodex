import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import { invoke } from "@/lib/tauri";

export type IdentityCorrectionRuleKind =
  | "must-link-surface"
  | "cannot-link-entries"
  | "preferred-binding"
  | "preferred-canonical-name"
  | "suppressed-merge-candidate";

export interface IdentityCorrectionRuleFields {
  kind: IdentityCorrectionRuleKind;
  scopeKind: "any" | "exact";
  scopeSceneId?: string | null;
  surfaceText?: string | null;
  entryId?: string | null;
  otherEntryId?: string | null;
  canonicalName?: string | null;
  keepPreviousAsAlias?: boolean | null;
  reason?: string | null;
}

export interface IdentityCorrectionRuleRevisionRow {
  id: string;
  project_id: string;
  rule_id: string;
  revision_no: number;
  supersedes_revision_id: string | null;
  state: "active" | "retired";
  kind: IdentityCorrectionRuleKind;
  scope_kind: "any" | "exact";
  scope_scene_id: string | null;
  surface_text: string | null;
  entry_id: string | null;
  other_entry_id: string | null;
  canonical_name: string | null;
  keep_previous_as_alias: 0 | 1 | null;
  reason: string | null;
  provenance_kind: string;
  provenance_ref: string | null;
  actor_id: string;
  created_at: string;
  request_id: string;
}

function writePayload(
  projectId: string,
  fields?: IdentityCorrectionRuleFields,
  previousRevisionId?: string,
) {
  const authority = createCanonicalWriteContext("human");
  return {
    ...authority,
    projectId,
    ...(fields ? { fields } : { previousRevisionId }),
    context: { sessionId: authority.sessionId },
  };
}

export function listIdentityCorrectionRules(
  projectId: string,
): Promise<IdentityCorrectionRuleRevisionRow[]> {
  return invoke<IdentityCorrectionRuleRevisionRow[]>(
    "identity_correction_rules_list",
    { projectId },
  );
}

export function createIdentityCorrectionRule(
  projectId: string,
  fields: IdentityCorrectionRuleFields,
): Promise<IdentityCorrectionRuleRevisionRow> {
  return invoke<IdentityCorrectionRuleRevisionRow>(
    "identity_correction_rule_create",
    { payload: writePayload(projectId, fields) },
  );
}

export function supersedeIdentityCorrectionRule(
  projectId: string,
  previousRevisionId: string,
  fields: IdentityCorrectionRuleFields,
): Promise<IdentityCorrectionRuleRevisionRow> {
  return invoke<IdentityCorrectionRuleRevisionRow>(
    "identity_correction_rule_supersede",
    { previousRevisionId, payload: writePayload(projectId, fields) },
  );
}

export function retireIdentityCorrectionRule(
  projectId: string,
  previousRevisionId: string,
): Promise<IdentityCorrectionRuleRevisionRow> {
  return invoke<IdentityCorrectionRuleRevisionRow>(
    "identity_correction_rule_retire",
    { payload: writePayload(projectId, undefined, previousRevisionId) },
  );
}
