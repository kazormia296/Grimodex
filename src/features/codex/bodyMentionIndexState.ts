import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { projectSettings, treeNodes } from "@/db/schema";
import { parseAliases, type CodexMatchTarget } from "./codexMatcher";

const BODY_MENTION_INDEX_STATE_KEY = "internal.codex.bodyMentionIndex.v1";

export interface BodyMentionSceneRevision {
  sceneId: string;
  version: number;
  updatedAt: string;
}

interface StoredSceneRevision {
  version: number;
  updatedAt: string;
}

interface BodyMentionIndexState {
  format: 1;
  matcherHash: string;
  scenes: Record<string, StoredSceneRevision>;
}

const updateChains = new Map<string, Promise<void>>();

async function matcherHash(
  entries: readonly CodexMatchTarget[],
): Promise<string> {
  const canonical = [...entries]
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      aliases: parseAliases(entry.aliases).sort(),
      excludedAliases: parseAliases(entry.excludedAliases).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseState(raw: string | null): BodyMentionIndexState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const candidate = value as Partial<BodyMentionIndexState>;
    if (
      candidate.format !== 1 ||
      typeof candidate.matcherHash !== "string" ||
      !candidate.scenes ||
      typeof candidate.scenes !== "object" ||
      Array.isArray(candidate.scenes)
    ) {
      return null;
    }
    for (const revision of Object.values(candidate.scenes)) {
      if (
        !revision ||
        typeof revision.version !== "number" ||
        typeof revision.updatedAt !== "string"
      ) {
        return null;
      }
    }
    return candidate as BodyMentionIndexState;
  } catch {
    return null;
  }
}

async function loadState(
  projectId: string,
): Promise<BodyMentionIndexState | null> {
  const rows = await db
    .select({ value: projectSettings.value })
    .from(projectSettings)
    .where(
      and(
        eq(projectSettings.projectId, projectId),
        eq(projectSettings.key, BODY_MENTION_INDEX_STATE_KEY),
      ),
    );
  return parseState(rows[0]?.value ?? null);
}

async function saveState(
  projectId: string,
  state: BodyMentionIndexState,
): Promise<void> {
  const value = JSON.stringify(state);
  await db
    .insert(projectSettings)
    .values({ projectId, key: BODY_MENTION_INDEX_STATE_KEY, value })
    .onConflictDoUpdate({
      target: [projectSettings.projectId, projectSettings.key],
      set: { value },
    });
}

async function serializeStateUpdate(
  projectId: string,
  update: () => Promise<void>,
): Promise<void> {
  const previous = updateChains.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(update);
  updateChains.set(projectId, next);
  try {
    await next;
  } finally {
    if (updateChains.get(projectId) === next) updateChains.delete(projectId);
  }
}

/**
 * Record successful scans against the exact scene revisions and matcher inputs
 * they used. Scenes with zero matches are represented here even though
 * scene_codex_mentions intentionally has no sentinel row for them.
 */
export async function recordBodyMentionScans(
  projectId: string,
  entries: readonly CodexMatchTarget[],
  scans: readonly BodyMentionSceneRevision[],
): Promise<void> {
  if (scans.length === 0) return;
  const ids = [...new Set(scans.map((scan) => scan.sceneId))];
  const currentRows = await db
    .select({
      sceneId: treeNodes.id,
      version: treeNodes.version,
      updatedAt: treeNodes.updatedAt,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
        inArray(treeNodes.id, ids),
      ),
    );
  const currentById = new Map(currentRows.map((row) => [row.sceneId, row]));
  const currentScans = scans.filter((scan) => {
    const current = currentById.get(scan.sceneId);
    return (
      current?.version === scan.version && current.updatedAt === scan.updatedAt
    );
  });
  if (currentScans.length === 0) return;

  const fingerprint = await matcherHash(entries);
  await serializeStateUpdate(projectId, async () => {
    const previous = await loadState(projectId);
    const state: BodyMentionIndexState =
      previous?.matcherHash === fingerprint
        ? previous
        : { format: 1, matcherHash: fingerprint, scenes: {} };
    for (const scan of currentScans) {
      state.scenes[scan.sceneId] = {
        version: scan.version,
        updatedAt: scan.updatedAt,
      };
    }
    await saveState(projectId, state);
  });
}

/** Fail closed unless every current scene and matcher pattern is indexed. */
export async function isBodyMentionIndexReady(
  projectId: string,
  entries: readonly CodexMatchTarget[],
): Promise<boolean> {
  if (entries.length === 0) return true;
  const [state, fingerprint, scenes] = await Promise.all([
    loadState(projectId),
    matcherHash(entries),
    db
      .select({
        sceneId: treeNodes.id,
        version: treeNodes.version,
        updatedAt: treeNodes.updatedAt,
      })
      .from(treeNodes)
      .where(
        and(
          eq(treeNodes.projectId, projectId),
          eq(treeNodes.nodeType, "scene"),
        ),
      ),
  ]);
  if (scenes.length === 0) return true;
  if (!state || state.matcherHash !== fingerprint) return false;
  return scenes.every((scene) => {
    const indexed = state.scenes[scene.sceneId];
    return (
      indexed?.version === scene.version &&
      indexed.updatedAt === scene.updatedAt
    );
  });
}
