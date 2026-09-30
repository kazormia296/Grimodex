import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { proseStaging } from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { PendingProseProposal } from "./proseStagingStore";

export type ProseStagingMode = "append" | "insert" | "replace";

export interface AgentProposeSceneBodyInput {
  requestId?: string;
  sceneId: string;
  text: string;
  mode?: ProseStagingMode;
  replaceFrom?: number;
  replaceTo?: number;
  sourceSurface?: "in-app-agent" | "mcp";
  /** Main-issued capability for the exact interactive agent tool call. */
  agentAuthorityCapability?: string;
  chatMessageId?: string;
  toolCallId?: string;
  executionId?: string;
  mainOwnedProvenanceId?: string;
}

export interface ProseStageResult {
  stagingId: string;
  sceneId: string;
  status: string;
}

export interface ParsedProseProposal {
  mode: ProseStagingMode;
  text: string;
  replaceFrom?: number;
  replaceTo?: number;
  anchorText?: string;
  anchorPosition?: "before" | "after";
}

export function parseProposedContent(raw: string): ParsedProseProposal {
  try {
    const parsed = JSON.parse(raw) as {
      mode?: string;
      text?: string;
      replaceFrom?: number;
      replaceTo?: number;
      anchorText?: string;
      anchorPosition?: string;
    };
    const mode =
      parsed.mode === "replace" || parsed.mode === "insert"
        ? parsed.mode
        : "append";
    const anchorText =
      typeof parsed.anchorText === "string" && parsed.anchorText.length > 0
        ? parsed.anchorText
        : undefined;
    const anchorPosition =
      parsed.anchorPosition === "before" ? "before" : "after";
    return {
      mode,
      text: String(parsed.text ?? ""),
      replaceFrom: parsed.replaceFrom,
      replaceTo: parsed.replaceTo,
      anchorText,
      anchorPosition: anchorText ? anchorPosition : undefined,
    };
  } catch {
    return { mode: "append", text: raw };
  }
}

function assertSceneAllowsProseStaging(sceneId: string): void {
  const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
  if (node && isFileBackedNode(node.sourceUri)) {
    throw new Error(
      "file-backed scenes are excluded from agent prose staging (v1)",
    );
  }
}

export async function agentProposeSceneBody(
  input: AgentProposeSceneBodyInput,
): Promise<ProseStageResult> {
  if (blockIfPolicyOff("bodyWrite")) {
    throw new Error("bodyWrite policy is off");
  }

  assertSceneAllowsProseStaging(input.sceneId);

  const projectId = getCurrentProjectId();
  const mode = input.mode ?? "append";

  return invoke<ProseStageResult>("agent_propose_scene_body", {
    payload: {
      ...(input.requestId ? { requestId: input.requestId } : {}),
      projectId,
      sessionId: getRecorderSessionId(),
      sceneId: input.sceneId,
      proposedContent: input.text,
      mode,
      sourceSurface: input.sourceSurface ?? "in-app-agent",
      ...(input.agentAuthorityCapability
        ? { agentAuthorityCapability: input.agentAuthorityCapability }
        : {}),
      ...(input.chatMessageId ? { chatMessageId: input.chatMessageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.mainOwnedProvenanceId
        ? { mainOwnedProvenanceId: input.mainOwnedProvenanceId }
        : {}),
      replaceFrom: input.replaceFrom ?? null,
      replaceTo: input.replaceTo ?? null,
    },
  });
}

export async function agentAcceptProseStage(
  stagingId: string,
): Promise<ProseStageResult> {
  const projectId = getCurrentProjectId();
  return invoke<ProseStageResult>("agent_accept_prose_stage", {
    payload: {
      requestId: crypto.randomUUID(),
      projectId,
      sessionId: getRecorderSessionId(),
      stagingId,
    },
  });
}

export async function agentDiscardProseStage(
  stagingId: string,
): Promise<ProseStageResult> {
  const projectId = getCurrentProjectId();
  return invoke<ProseStageResult>("agent_discard_prose_stage", {
    payload: {
      projectId,
      sessionId: getRecorderSessionId(),
      stagingId,
    },
  });
}

/** Load the latest proposed staging row for a scene (MCP / deferred review). */
export async function loadLatestProposedProse(
  sceneId: string,
): Promise<PendingProseProposal | null> {
  const projectId = getCurrentProjectId();
  const rows = await db
    .select()
    .from(proseStaging)
    .where(
      and(
        eq(proseStaging.projectId, projectId),
        eq(proseStaging.sceneId, sceneId),
        eq(proseStaging.status, "proposed"),
      ),
    )
    .orderBy(desc(proseStaging.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const parsed = parseProposedContent(row.proposedContent);
  return {
    stagingId: row.id,
    sceneId: row.sceneId,
    text: parsed.text,
    mode: parsed.mode,
    replaceFrom: parsed.replaceFrom,
    replaceTo: parsed.replaceTo,
    anchorText: parsed.anchorText,
    anchorPosition: parsed.anchorPosition,
    // propose 時点の tree_nodes.version。headless 自動適用の stale 検知に使う。
    baseVersion: row.baseVersion,
  };
}

/**
 * Load every `proposed` staging row for a project (all scenes), oldest first.
 * Used by the headless auto-apply consumer to drain the backlog accumulated
 * while the app was closed (the change-event poller only sees rows newer than
 * its start cursor, so pre-existing proposals would otherwise be missed).
 */
export async function loadAllProposedProse(
  projectId: string,
): Promise<PendingProseProposal[]> {
  const rows = await db
    .select()
    .from(proseStaging)
    .where(
      and(
        eq(proseStaging.projectId, projectId),
        eq(proseStaging.status, "proposed"),
      ),
    )
    .orderBy(asc(proseStaging.createdAt));

  return rows.map((row) => {
    const parsed = parseProposedContent(row.proposedContent);
    return {
      stagingId: row.id,
      sceneId: row.sceneId,
      text: parsed.text,
      mode: parsed.mode,
      replaceFrom: parsed.replaceFrom,
      replaceTo: parsed.replaceTo,
      anchorText: parsed.anchorText,
      anchorPosition: parsed.anchorPosition,
      // propose 時点の tree_nodes.version。headless 自動適用の stale 検知に使う。
      baseVersion: row.baseVersion,
    };
  });
}
