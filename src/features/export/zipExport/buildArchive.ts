import { strToU8, zipSync } from "fflate";
import { db } from "@/db/client";
import {
  treeNodes,
  chatSessions,
  foreshadows,
  foreshadowSetups,
  foreshadowCodexLinks,
} from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getProject } from "@/features/project/api";
import { listCodexEntries } from "@/features/codex/api";
import { listSnippets } from "@/features/snippets/api";
import { listBoards } from "@/features/map/mapApi";
import {
  listMessages,
  listSummaries,
  listPinnedCodexEntries,
  listPinnedSnippetEntries,
} from "@/features/chat/chatApi";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildManifest } from "./manifest";
import { buildScenePathIndex, sceneSlugById } from "./scenePathIndex";
import { serializeSceneContent } from "./sceneSerializer";
import { serializeCodexEntries } from "./codexSerializer";
import {
  serializeForeshadows,
  buildCodexNameMap,
} from "./foreshadowSerializer";
import { serializeChatSession } from "./chatSerializer";
import { serializeSnippets } from "./snippetSerializer";
import { serializeMapBoard, assignBoardSlugs } from "./mapSerializer";
import { slugifyTitle } from "./slug";
import type { ZipExportSettings, ArchiveFileEntry } from "./types";
import type { ForeshadowSetupRow } from "@/features/foreshadow/types";

const GRIMODEX_VERSION = "0.4.2";

export interface BuildArchiveProgress {
  phase: string;
  current: number;
  total: number;
}

export interface BuildArchiveInput {
  projectId: string;
  settings: ZipExportSettings;
  onProgress?: (progress: BuildArchiveProgress) => void;
}

function toTreeNodeData(row: typeof treeNodes.$inferSelect): TreeNodeData {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    nodeType: row.nodeType as TreeNodeData["nodeType"],
    title: row.title,
    synopsis: row.synopsis,
    intent: row.intent ?? null,
    sortOrder: row.sortOrder,
    status: row.status,
    storyTimeOrder: row.storyTimeOrder,
    storyTimeLabel: row.storyTimeLabel,
    povCharacterId: row.povCharacterId,
    locationId: row.locationId,
    charCount: row.charCount,
    sourceUri: row.sourceUri,
    sourceMtime: row.sourceMtime,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadContentMap(
  projectId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), isNull(treeNodes.archivedAt)),
    );

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.id] = row.content;
  }

  const live = useSceneContentStore.getState().liveContent;
  for (const [id, content] of Object.entries(live)) {
    if (content) map[id] = JSON.stringify(content);
  }

  return map;
}

function addFile(
  files: ArchiveFileEntry[],
  path: string,
  content: string | Uint8Array,
) {
  files.push({
    path,
    content: typeof content === "string" ? strToU8(content) : content,
  });
}

/** Build the full project archive as zip bytes. */
export async function buildArchive(
  input: BuildArchiveInput,
): Promise<Uint8Array> {
  const { projectId, settings, onProgress } = input;
  const files: ArchiveFileEntry[] = [];

  const report = (phase: string, current: number, total: number) => {
    onProgress?.({ phase, current, total });
  };

  report("loading", 0, 1);

  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");

  const nodeRows = await db
    .select()
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), isNull(treeNodes.archivedAt)),
    );
  const nodes = nodeRows.map(toTreeNodeData);
  const contentMap = await loadContentMap(projectId);
  const { chapters, scenePathById } = buildScenePathIndex(nodes);

  const allScenes = chapters.flatMap((c) => c.scenes);
  report("scenes", 0, allScenes.length);

  for (let i = 0; i < allScenes.length; i++) {
    const scene = allScenes[i];
    const pathInfo = scenePathById.get(scene.id);
    if (!pathInfo) continue;

    const { markdown, marks } = serializeSceneContent(
      contentMap[scene.id],
      settings,
    );
    addFile(files, pathInfo.relativePath, markdown);

    if (marks && marks.marks.length > 0) {
      const marksPath = pathInfo.relativePath.replace(/\.md$/, ".marks.json");
      addFile(files, marksPath, JSON.stringify(marks, null, 2));
    }
    report("scenes", i + 1, allScenes.length);
  }

  report("codex", 0, 1);
  const codex = await listCodexEntries(projectId);
  for (const entry of serializeCodexEntries(codex, settings)) {
    addFile(files, entry.path, entry.content);
  }

  report("foreshadows", 0, 1);
  const foreshadowRows = await db
    .select()
    .from(foreshadows)
    .where(
      and(
        eq(foreshadows.projectId, projectId),
        eq(foreshadows.abandoned, false),
      ),
    );

  if (foreshadowRows.length > 0) {
    const ids = foreshadowRows.map((f) => f.id);

    const allSetups: ForeshadowSetupRow[] = [];
    for (const fid of ids) {
      const rows = await db
        .select()
        .from(foreshadowSetups)
        .where(eq(foreshadowSetups.foreshadowId, fid));
      allSetups.push(...(rows as ForeshadowSetupRow[]));
    }

    const allLinks = [];
    for (const fid of ids) {
      const rows = await db
        .select()
        .from(foreshadowCodexLinks)
        .where(eq(foreshadowCodexLinks.foreshadowId, fid));
      allLinks.push(...rows);
    }

    const codexNameMap = buildCodexNameMap(codex);
    const setupsByForeshadow = new Map<string, ForeshadowSetupRow[]>();
    for (const s of allSetups) {
      const list = setupsByForeshadow.get(s.foreshadowId) ?? [];
      list.push(s);
      setupsByForeshadow.set(s.foreshadowId, list);
    }

    const codexLinks = new Map<string, string[]>();
    for (const link of allLinks) {
      const list = codexLinks.get(link.foreshadowId) ?? [];
      const name = codexNameMap.get(link.codexEntryId);
      if (name) list.push(name);
      codexLinks.set(link.foreshadowId, list);
    }

    for (const file of serializeForeshadows(
      foreshadowRows as import("@/features/foreshadow/types").ForeshadowRow[],
      setupsByForeshadow,
      codexLinks,
      scenePathById,
    )) {
      addFile(files, file.path, file.content);
    }
  }

  if (settings.includeSnippets) {
    report("snippets", 0, 1);
    const snippetRows = await listSnippets(projectId);
    for (const file of serializeSnippets(snippetRows, settings)) {
      addFile(files, file.path, file.content);
    }
  }

  if (settings.includeChats) {
    const sessionRows = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.projectId, projectId));
    report("chats", 0, sessionRows.length);

    for (let i = 0; i < sessionRows.length; i++) {
      const sessionRow = sessionRows[i];
      const session = {
        id: sessionRow.id,
        projectId: sessionRow.projectId,
        nodeId: sessionRow.nodeId,
        codexAnchorId: sessionRow.codexAnchorId,
        title: sessionRow.title,
        titleManual: sessionRow.titleManual,
        model: sessionRow.model,
        createdAt: sessionRow.createdAt,
        updatedAt: sessionRow.updatedAt,
      };

      const [messages, summaries, pinnedCodex, pinnedSnippets] =
        await Promise.all([
          listMessages(session.id),
          listSummaries(session.id),
          listPinnedCodexEntries(session.id),
          listPinnedSnippetEntries(session.id),
        ]);

      const exported = serializeChatSession(
        session,
        messages,
        summaries,
        pinnedCodex,
        pinnedSnippets,
      );

      const dir =
        session.nodeId != null
          ? `chats/${sceneSlugById(scenePathById, session.nodeId) ?? session.nodeId}`
          : session.codexAnchorId != null
            ? `chats/_codex/${session.codexAnchorId}`
            : "chats/_orphan";
      addFile(
        files,
        `${dir}/${session.id}.json`,
        JSON.stringify(exported, null, 2),
      );
      report("chats", i + 1, sessionRows.length);
    }
  }

  if (settings.includeMaps) {
    const boards = await listBoards(projectId);
    report("maps", 0, boards.length);

    // assignBoardSlugs shares one `used` Set across boards so two boards with
    // identical titles get distinct directories (e.g. "Plot" + "Plot-2"),
    // preventing the second from overwriting the first in `zipInput`.
    const boardSlugs = assignBoardSlugs(boards);
    for (let i = 0; i < boardSlugs.length; i++) {
      const { board, slug } = boardSlugs[i];
      const mapFiles = await serializeMapBoard({
        board,
        treeNodes: nodes,
        codexEntries: codex,
        snippets: settings.includeSnippets ? await listSnippets(projectId) : [],
      });
      const base = `maps/${slug}`;
      addFile(files, `${base}/board.json`, mapFiles.json);
      addFile(files, `${base}/board.svg`, mapFiles.svg);
      if (mapFiles.png) {
        const buf = new Uint8Array(await mapFiles.png.arrayBuffer());
        addFile(files, `${base}/board.png`, buf);
      }
      report("maps", i + 1, boards.length);
    }
  }

  const manifest = buildManifest(project, settings, GRIMODEX_VERSION);
  addFile(files, "manifest.json", JSON.stringify(manifest, null, 2));

  const zipInput: Record<string, Uint8Array> = {};
  for (const f of files) {
    zipInput[f.path] = f.content;
  }

  return zipSync(zipInput);
}

export function defaultZipFilename(projectTitle: string): string {
  const slug = slugifyTitle(projectTitle);
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${slug}_${stamp}.zip`;
}
