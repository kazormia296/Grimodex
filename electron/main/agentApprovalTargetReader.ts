import { createHash } from "node:crypto";

import type {
  AgentApprovalRequest,
  AgentApprovalTarget,
} from "./agentApprovalExchange.js";
import {
  AGENT_APPROVAL_PROTECTED_TOOLS,
  agentTreePlanRequiresVersion,
  type AgentApprovalExpected,
} from "./agentApprovalProtectedTools.js";
import type { CoreReadDbClient } from "../shared/mastraRead/ports.js";
import type { AnalysisReadBasisEntryV1 } from "../shared/agentRunTypes.js";

type TargetRequest = Pick<
  AgentApprovalRequest,
  "projectId" | "toolName" | "modelInput"
>;

/** summary に入れるのは、台帳の引数と target_basis に既にある値だけ（名前は入れない）。 */
interface SummaryTarget {
  readonly kind: string;
  readonly id: string;
}

interface TreeNode {
  readonly id: string;
  readonly version: number;
}

const MAX_ID_BYTES = 256;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_TREE_NODES = 2000;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= MAX_ID_BYTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// 交換の service はこの文字列をそのまま承認の Interaction に保存する。
function summarize(
  toolName: string,
  rawTargets: readonly SummaryTarget[],
): string {
  const targets = rawTargets.slice(0, 50).map(({ kind, id }) => ({ kind, id }));
  const serialize = () => {
    const omitted = rawTargets.length - targets.length;
    return JSON.stringify({
      v: 1,
      tool: toolName,
      count: rawTargets.length,
      targets,
      ...(omitted > 0 ? { omitted } : {}),
    });
  };
  let summary = serialize();
  while (utf8Bytes(summary) > MAX_SUMMARY_BYTES && targets.length > 0) {
    targets.pop();
    summary = serialize();
  }
  return summary;
}

function target(
  toolName: string,
  targets: readonly SummaryTarget[],
  basis: readonly AnalysisReadBasisEntryV1[] | null,
  baseVersions:
    | readonly { readonly id: string; readonly version: number }[]
    | null,
  expected: AgentApprovalExpected | null = null,
): AgentApprovalTarget {
  return {
    summary: summarize(toolName, targets),
    basis,
    baseVersions,
    expected,
  };
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function versionedTarget(
  toolName: string,
  kind: string,
  id: unknown,
  version: unknown,
): AgentApprovalTarget | null {
  if (!isId(id) || !isVersion(version)) return null;
  return target(
    toolName,
    [{ kind, id }],
    [{ sourceKind: kind, sourceId: id, version: String(version) }],
    [{ id, version }],
  );
}

function firstRow(rows: unknown[][]): unknown[] | null {
  return rows.length === 1 ? rows[0]! : null;
}

export function createAgentApprovalTargetReader({
  readDb,
}: {
  readonly readDb: CoreReadDbClient;
}): (request: TargetRequest) => Promise<AgentApprovalTarget | null> {
  return async ({ projectId, toolName, modelInput }) => {
    if (
      !isId(projectId) ||
      !AGENT_APPROVAL_PROTECTED_TOOLS.has(toolName) ||
      !isRecord(modelInput)
    ) {
      return null;
    }

    if (
      toolName === "create_codex_entry" ||
      toolName === "create_foreshadow" ||
      toolName === "create_snippet" ||
      toolName === "create_event"
    ) {
      return target(toolName, [], null, null);
    }

    try {
      if (toolName === "update_codex_entry") {
        const id = modelInput.id;
        if (!isId(id)) return null;
        const { rows } = await readDb(
          "SELECT id, version FROM codex_entries WHERE project_id = ? AND id = ? LIMIT 1",
          [projectId, id],
          "all",
        );
        const row = firstRow(rows);
        return row
          ? versionedTarget(toolName, "codex_entry", row[0], row[1])
          : null;
      }

      if (toolName === "update_foreshadow") {
        const id = modelInput.id;
        if (!isId(id)) return null;
        const { rows } = await readDb(
          "SELECT id, version FROM foreshadows WHERE project_id = ? AND id = ? LIMIT 1",
          [projectId, id],
          "all",
        );
        const row = firstRow(rows);
        return row
          ? versionedTarget(toolName, "foreshadow", row[0], row[1])
          : null;
      }

      if (
        toolName === "update_event" ||
        toolName === "delete_event" ||
        toolName === "set_event_participants"
      ) {
        const id = modelInput.eventId;
        if (!isId(id)) return null;
        const { rows } = await readDb(
          "SELECT id, version FROM events WHERE project_id = ? AND id = ? LIMIT 1",
          [projectId, id],
          "all",
        );
        const row = firstRow(rows);
        return row ? versionedTarget(toolName, "event", row[0], row[1]) : null;
      }

      if (
        toolName === "stamp_scene_event" ||
        toolName === "unstamp_scene_event"
      ) {
        const sceneId = modelInput.sceneId;
        const eventId = modelInput.eventId;
        if (!isId(sceneId) || !isId(eventId)) return null;
        const sourceId = JSON.stringify([sceneId, eventId]);
        if (!isId(sourceId)) return null;
        const { rows } = await readDb(
          "SELECT s.id AS scene_id, e.id AS event_id, e.version AS event_version, l.scene_id AS link_scene_id, l.incarnation_token AS link_incarnation FROM tree_nodes AS s JOIN events AS e ON e.id = ? AND e.project_id = ? LEFT JOIN scene_events AS l ON l.scene_id = s.id AND l.event_id = e.id WHERE s.project_id = ? AND s.id = ? LIMIT 1",
          [eventId, projectId, projectId, sceneId],
          "all",
        );
        const row = firstRow(rows);
        if (
          !row ||
          row[0] !== sceneId ||
          row[1] !== eventId ||
          !isVersion(row[2])
        ) {
          return null;
        }
        const linked = row[3] !== null;
        if (linked && (row[3] !== sceneId || typeof row[4] !== "string"))
          return null;
        const linkIncarnation = linked ? (row[4] as string) : null;
        const expected: AgentApprovalExpected = {
          kind: "scene_event_link",
          linkIncarnation,
          eventVersion: row[2],
        };
        return target(
          toolName,
          [{ kind: "scene_event_link", id: sourceId }],
          [
            {
              sourceKind: "event",
              sourceId: eventId,
              version: String(row[2]),
            },
            {
              sourceKind: "scene_event_link",
              sourceId,
              contentHash: contentHash({ linked, linkIncarnation }),
            },
          ],
          null,
          expected,
        );
      }

      if (
        toolName === "add_event_relation" ||
        toolName === "remove_event_relation"
      ) {
        const causeEventId = modelInput.causeEventId;
        const effectEventId = modelInput.effectEventId;
        if (
          !isId(causeEventId) ||
          !isId(effectEventId) ||
          causeEventId === effectEventId
        ) {
          return null;
        }
        const sourceId = JSON.stringify([causeEventId, effectEventId]);
        if (!isId(sourceId)) return null;
        // 関係の有無は Native の writer と同じく両端の組だけで決める
        // （作品の縛りは両端の出来事に掛かっている）。
        const { rows } = await readDb(
          "SELECT c.id AS cause_id, c.version AS cause_version, e.id AS effect_id, e.version AS effect_version, r.cause_event_id AS relation_cause_id FROM events AS c JOIN events AS e ON e.id = ? AND e.project_id = ? LEFT JOIN event_relations AS r ON r.cause_event_id = c.id AND r.effect_event_id = e.id WHERE c.project_id = ? AND c.id = ? LIMIT 1",
          [effectEventId, projectId, projectId, causeEventId],
          "all",
        );
        const row = firstRow(rows);
        if (
          !row ||
          row[0] !== causeEventId ||
          !isVersion(row[1]) ||
          row[2] !== effectEventId ||
          !isVersion(row[3])
        ) {
          return null;
        }
        const related = row[4] !== null;
        if (related && row[4] !== causeEventId) return null;
        const expected: AgentApprovalExpected = {
          kind: "event_relation",
          related,
          causeVersion: row[1],
          effectVersion: row[3],
        };
        return target(
          toolName,
          [{ kind: "event_relation", id: sourceId }],
          [
            {
              sourceKind: "event",
              sourceId: causeEventId,
              version: String(row[1]),
            },
            {
              sourceKind: "event",
              sourceId: effectEventId,
              version: String(row[3]),
            },
            {
              sourceKind: "event_relation",
              sourceId,
              contentHash: contentHash({
                causeEventId,
                effectEventId,
                related,
              }),
            },
          ],
          null,
          expected,
        );
      }

      if (toolName === "apply_ai_tree_plan") {
        const ops = modelInput.ops;
        const requiresVersion = agentTreePlanRequiresVersion(ops);
        if (requiresVersion === null) return null;
        if (!requiresVersion) return target(toolName, [], null, null);
        const ids = [
          ...new Set(
            (ops as Array<{ op: string; nodeId?: unknown }>).flatMap((op) =>
              op.op === "move" || op.op === "rename"
                ? [op.nodeId as string]
                : [],
            ),
          ),
        ].sort(compareCodeUnits);
        if (
          ids.length === 0 ||
          ids.length > MAX_TREE_NODES ||
          ids.some((id) => !isId(id))
        )
          return null;

        const { rows } = await readDb(
          `SELECT id, version FROM tree_nodes WHERE project_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
          [projectId, ...ids],
          "all",
        );
        if (rows.length !== ids.length) return null;
        const nodes = new Map<string, TreeNode>();
        for (const [id, version] of rows) {
          if (
            !isId(id) ||
            !ids.includes(id) ||
            !isVersion(version) ||
            nodes.has(id)
          ) {
            return null;
          }
          nodes.set(id, { id, version });
        }
        if (nodes.size !== ids.length) return null;
        const ordered = ids.map((id) => nodes.get(id)!);
        const versions = ordered.map(({ id, version }) => ({ id, version }));
        const basis: readonly AnalysisReadBasisEntryV1[] = ordered.map(
          ({ id, version }) => ({
            sourceKind: "tree_node",
            sourceId: id,
            version: String(version),
          }),
        );
        const boundedBasis =
          basis.length <= 64 && utf8Bytes(JSON.stringify(basis)) <= 32 * 1024
            ? basis
            : [
                {
                  sourceKind: "tree_node_set",
                  sourceId: projectId,
                  contentHash: contentHash(
                    versions.map(({ id, version }) => ({ id, version })),
                  ),
                },
              ];
        return target(
          toolName,
          ordered.map(({ id }) => ({ kind: "tree_node", id })),
          boundedBasis,
          versions,
        );
      }

      return null;
    } catch {
      return null;
    }
  };
}
