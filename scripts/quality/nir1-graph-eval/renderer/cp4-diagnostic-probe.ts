/**
 * CP-4 S5-B harness page entries of the diagnostics (DR-CP4-O-1 (4)(5)).
 *
 * SP-P4: the sparse Scenes of the product's Related Scenes query for a Scene
 * (the query `fetchNir1RelatedPastScenes` builds from the saved body; the
 * begin's dense hits come from the timing shim's begin row).
 *
 * K24-G01-N2〜N4: the body writes of the negatives, through the product's
 * own writers only — the body save writer (`saveSceneContent`), the manual
 * version writer the editor's save uses (`createRevision`), and the Scene
 * body version restore of the history dialog (`restoreSceneRevisionNative`
 * with the payload the dialog builds). No project snapshot restore, no SQL.
 */
import {
  getNode,
  loadSceneContent,
  saveSceneContent,
} from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  buildSemanticRecallQuery,
  fetchSparseSceneIds,
} from "@/features/chat/semanticRecall";
import { buildSparseQuery } from "@/features/related-scenes/seedTerms";
import {
  createRevision,
  getRevision,
  listRevisions,
} from "@/features/revision/api";
import { restoreSceneRevisionNative } from "@/features/revision/revisionRestoreNative";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";
import { useTreeStore } from "@/features/tree/treeStore";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(work: () => Promise<T>) {
  try {
    return { ok: true as const, value: await work() };
  } catch (error) {
    return { ok: false as const, error: describe(error) };
  }
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** SP-P4: the sparse Scenes of the product's query for this Scene. */
async function sparseSceneIds(input: { projectId: string; sceneId: string }) {
  const body = prosemirrorToText((await loadSceneContent(input.sceneId)) ?? "");
  const query = buildSemanticRecallQuery({ userMessage: "", sceneBody: body });
  return fetchSparseSceneIds({
    projectId: input.projectId,
    query: buildSparseQuery(query, body),
  });
}

/** The saved body (ProseMirror JSON), its digest and the row's version. */
async function bodyState(sceneId: string) {
  const content = await loadSceneContent(sceneId);
  const node = await getNode(sceneId);
  return {
    content,
    sha256: await digest(content ?? ""),
    version: node?.version ?? null,
  };
}

/** The body with `suffix` appended to its last text node (N4's draft). */
function appendToLastText(content: string, suffix: string): string {
  const doc = JSON.parse(content) as { content?: unknown[] };
  const stack: unknown[] = [doc];
  let last: { text?: string } | null = null;
  while (stack.length > 0) {
    const node = stack.shift() as {
      type?: string;
      text?: string;
      content?: unknown[];
    };
    if (node?.type === "text" && typeof node.text === "string") last = node;
    if (Array.isArray(node?.content)) stack.push(...node.content);
  }
  if (!last) throw new Error("the body has no text node");
  last.text = `${last.text}${suffix}`;
  return JSON.stringify(doc);
}

/** N2: the same body saved again through the product's body save writer. */
async function resaveBody(input: { projectId: string; sceneId: string }) {
  const before = await bodyState(input.sceneId);
  if (typeof before.content !== "string") throw new Error("no saved body");
  await saveSceneContent(input.sceneId, {
    content: before.content,
    projectId: input.projectId,
  });
  const after = await bodyState(input.sceneId);
  return {
    before: { sha256: before.sha256, version: before.version },
    after: { sha256: after.sha256, version: after.version },
  };
}

/** A manual body version of `content` (the editor's save writer). */
async function versionOf(input: {
  projectId: string;
  sceneId: string;
  content: string;
}) {
  const created = await createRevision({
    scope: { projectId: input.projectId, isCurrent: () => true },
    entityType: "scene",
    entityId: input.sceneId,
    content: input.content,
    snapshotType: "manual",
  });
  if (created) return { revisionId: created.id, created: true };
  // The writer keeps no copy of a body equal to the latest version.
  const [latest] = await listRevisions("scene", input.sceneId, 1);
  const row = latest ? await getRevision(latest.id) : undefined;
  if (!row || row.content !== input.content)
    throw new Error("no body version holds these bytes");
  return { revisionId: row.id, created: false };
}

/**
 * N3 before the declaration: a body version with the declared bytes (made
 * from the saved body, or the latest one when it already holds them).
 */
async function sameBytesVersion(input: { projectId: string; sceneId: string }) {
  const state = await bodyState(input.sceneId);
  if (typeof state.content !== "string") throw new Error("no saved body");
  const version = await versionOf({ ...input, content: state.content });
  return { ...version, sha256: state.sha256 };
}

/**
 * N4 before the declaration: the body with `suffix` saved and kept as a
 * version, then the original body saved again (the declared bytes stay the
 * fixture's).
 */
async function draftThenOriginal(input: {
  projectId: string;
  sceneId: string;
  suffix: string;
}) {
  const original = await bodyState(input.sceneId);
  if (typeof original.content !== "string") throw new Error("no saved body");
  const draft = appendToLastText(original.content, input.suffix);
  await saveSceneContent(input.sceneId, {
    content: draft,
    projectId: input.projectId,
  });
  const version = await versionOf({ ...input, content: draft });
  await saveSceneContent(input.sceneId, {
    content: original.content,
    projectId: input.projectId,
  });
  const after = await bodyState(input.sceneId);
  return {
    ...version,
    draftSha256: await digest(draft),
    originalSha256: original.sha256,
    afterSha256: after.sha256,
  };
}

/**
 * N3／N4 after the declaration: the Scene body version restore, with the
 * payload the history dialog builds (the persisted head, its version, the
 * version's bytes).
 */
async function restoreVersion(input: {
  projectId: string;
  sceneId: string;
  revisionId: string;
}) {
  const node = await getNode(input.sceneId);
  const revision = await getRevision(input.revisionId);
  if (
    !node ||
    node.projectId !== input.projectId ||
    typeof node.content !== "string" ||
    !revision ||
    revision.entityId !== input.sceneId
  )
    throw new Error("the restore's Scene or version is unavailable");
  const result = await restoreSceneRevisionNative({
    requestId: crypto.randomUUID(),
    sessionId: getRecorderSessionId(),
    projectId: node.projectId,
    entityType: "scene",
    entityId: input.sceneId,
    revisionId: input.revisionId,
    content: revision.content,
    currentContent: node.content,
    expectedVersion: node.version,
    charCount: countSceneBodyCharsFromJson(revision.content),
    placedBeatPreview: (() => {
      const preview = extractPlacedBeatPreviewFromString(revision.content);
      return preview === "[]" ? null : preview;
    })(),
  });
  await useTreeStore.getState().reloadTreeOrThrow(node.projectId);
  const after = await bodyState(input.sceneId);
  return {
    revisionId: result.revisionId,
    version: result.version,
    replayed: result.replayed,
    afterSha256: after.sha256,
    restoredSha256: await digest(revision.content),
  };
}

export const diagnosticProbe = {
  sparseSceneIds: (input: Parameters<typeof sparseSceneIds>[0]) =>
    guarded(() => sparseSceneIds(input)),
  bodyState: (input: { sceneId: string }) =>
    guarded(async () => {
      const state = await bodyState(input.sceneId);
      return { sha256: state.sha256, version: state.version };
    }),
  resaveBody: (input: Parameters<typeof resaveBody>[0]) =>
    guarded(() => resaveBody(input)),
  sameBytesVersion: (input: Parameters<typeof sameBytesVersion>[0]) =>
    guarded(() => sameBytesVersion(input)),
  draftThenOriginal: (input: Parameters<typeof draftThenOriginal>[0]) =>
    guarded(() => draftThenOriginal(input)),
  restoreVersion: (input: Parameters<typeof restoreVersion>[0]) =>
    guarded(() => restoreVersion(input)),
};
