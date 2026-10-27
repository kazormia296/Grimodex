/**
 * CP-4 S1c-1 smoke page (DR-CP4-S1C1-7). Built only by the harness renderer
 * build (with the product `index.html`, so the availability alias is checked
 * on the full product graph) and served by the loopback static server. It
 * creates one synthetic empty workspace/project/Scene through the product's
 * renderer API and sends one seeded `related_scenes_begin`, so the evaluation
 * Native's owner spawns the C-query worker (V-10). No G-case fixture is read.
 */
import { invoke } from "@/lib/tauri";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { setCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { createProject } from "@/features/project/api";
import { listNodes } from "@/features/tree/api";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import {
  beginRelatedScenes,
  releaseRelatedScenes,
} from "@/features/related-scenes/nir1RelatedScenesApi";

const BODY = "The synthetic keeper counted three ships before the fog came in.";

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "non-error";
}

async function prepare(input: {
  workspacePath: string;
  projectId: string;
  sceneId: string;
}) {
  await invoke("open_workspace", { path: input.workspacePath });
  setCurrentWorkspaceIdentity({ path: input.workspacePath, openRevision: 1 });
  publishCurrentProjectId(input.projectId);
  setCurrentRuntimeProjectId(input.projectId);
  await createProject({
    id: input.projectId,
    title: "CP-4 synthetic smoke",
    language: "en",
  });
  await invoke("tree_node_create", {
    payload: {
      ...createCanonicalWriteContext("human"),
      id: input.sceneId,
      projectId: input.projectId,
      parentId: null,
      nodeType: "scene",
      title: "Synthetic scene",
      sortOrder: "a0",
      content: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: BODY }] },
        ],
      }),
      canonicalPayload: {
        parentId: null,
        sortOrder: "a0",
        title: "Synthetic scene",
      },
    },
  });
  const nodes = await listNodes(input.projectId);
  return { nodeCount: nodes.length };
}

async function begin(input: {
  workspacePath: string;
  projectId: string;
  sceneId: string;
  seed: string;
}) {
  const startedAt = performance.now();
  try {
    const response = await beginRelatedScenes({
      expectedWorkspacePath: input.workspacePath,
      projectId: input.projectId,
      currentSceneId: input.sceneId,
      query: BODY,
      graphSeedEntityId: input.seed,
    });
    const ticket =
      response.ir.status === "pending" ? response.ir.operationTicket : null;
    return {
      ok: true,
      elapsedMs: performance.now() - startedAt,
      status: response.status,
      denseHits: response.denseHits.length,
      ir: response.ir.status === "pending" ? "pending" : response.ir.reason,
      graph: response.graph ?? null,
      ticket,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: performance.now() - startedAt,
      error: describe(error),
    };
  }
}

async function release(ticket: string) {
  try {
    await releaseRelatedScenes(ticket);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

(window as unknown as { cp4Smoke: unknown }).cp4Smoke = {
  ready: true,
  prepare,
  begin,
  release,
};
