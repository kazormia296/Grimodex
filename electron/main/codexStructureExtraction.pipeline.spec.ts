// Codex 構造抽出（`startCodexStructureExtraction`）を、実 router と実 Native addon の
// 上で 保存 → 再読込（restore）→ 承認 → 取り込み まで通す（DR-CSX-1）。
//
// 以前は TS が codex-catalog の revisionToken を version vector の digest で作り、
// Native（`source_revision.rs` の `resolve_codex_catalog`）が DB の内容の digest で
// 照合していたため、保存が必ず `NEX_READ_SET_STALE` で失敗していた。単体の試験は
// Native を mock していたので、この食い違いは実 Native の上でしか見えない。
//
// renderer の API 関数は `window.grimodex.invoke` を Main の `grim:invoke` handler に
// つないだ shim の上で動く（`d2bRendererWriters.pipeline.spec.ts` と同じ形）。
// 実 addon が要るので `vitest.electron-native.config.ts` だけが拾う。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: vi.fn(),
  },
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: () => false,
  hasPanelWindow: () => false,
  openPanelWindow: () => undefined,
}));
// 主 window の 1 枚だけ（分離した panel window は無い）として snapshot の flush を通す。
vi.mock(
  "@/features/layout/multiwindow/panelWindow",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isPanelWindow: () => false,
    getPanelWindowHandle: async () => null,
  }),
);
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: vi.fn(() => "t-session"),
  recordChangeEvent: vi.fn(),
}));

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];

afterAll(async () => {
  delete (globalThis as Record<string, unknown>).window;
  for (const backend of backends) {
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Route = (cmd: string, args?: Record<string, unknown>) => Promise<Envelope>;

async function startMain(appData: string): Promise<Route> {
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");
  const gate = await createProfileEgressGate(backend as NapiBackendLike);
  registerEventBus(backend as NapiBackendLike, undefined, gate);
  registerIpcRouter(
    backend as NapiBackendLike,
    {} as never,
    undefined,
    undefined,
    { active: false } as never,
    gate,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const event = {
    sender: { id: 7, isDestroyed: () => false, once: () => undefined },
  };
  return (cmd, args) => handler(event, cmd, args ?? {});
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RendererModule = Record<string, any>;
/** 非 literal の specifier：`tsc -p electron/tsconfig.json` に renderer の木を型検査させない。 */
function renderer(specifier: string): Promise<RendererModule> {
  return import(/* @vite-ignore */ specifier) as Promise<RendererModule>;
}

function installRendererBridge(route: Route): void {
  (globalThis as Record<string, unknown>).window = {
    grimodex: {
      invoke: (cmd: string, args?: Record<string, unknown>) => route(cmd, args),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

describe("Codex 構造抽出：実 Native で 保存 → 再読込 → 承認 → 取り込み", () => {
  it("AI なしの抽出の提案の組を保存し、restore・承認・取り込みまで通る", async () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "grimodex-codex-structure-"),
    );
    roots.push(root);
    const appData = path.join(realpathSync(root), "app-data");
    mkdirSync(appData, { recursive: true });
    const route = await startMain(appData);

    const seeded = ok<{ path: string; projectId: string }>(
      await route("seed_sample_workspace", {
        language: "ja",
        aiPolicy: '{"preset":"full"}',
      }),
    );
    ok(await route("open_workspace", { path: seeded.path }));
    const projectId = seeded.projectId;
    const rows = async <T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> =>
      ok<{ rows: T[] }>(
        await route("db_execute", { sql, params, method: "all" }),
      ).rows;

    installRendererBridge(route);
    const { setCurrentWorkspaceIdentity } = await renderer(
      "@/runtime/workspaceIdentity",
    );
    const { setCurrentRuntimeProjectId } = await renderer(
      "@/runtime/projectIdentity",
    );
    const { publishCurrentProjectId } = await renderer(
      "@/application/project/currentProjectAuthority",
    );
    const { getCurrentProjectId, useProjectStore } = await renderer(
      "@/features/project/projectStore",
    );
    const workspace = { path: seeded.path, openRevision: 1 };
    setCurrentWorkspaceIdentity(workspace);
    publishCurrentProjectId(projectId);
    setCurrentRuntimeProjectId(projectId);
    useProjectStore.setState({ currentProjectId: projectId });

    const { captureMutationAuthority } = await renderer(
      "@/features/concurrency/mutationAuthority",
    );
    const { listCodexEntries, createCodexEntry } = await renderer(
      "@/features/codex/api",
    );
    const { listCodexTypes } = await renderer("@/features/codex/typeApi");
    const { listCodexRelations } = await renderer(
      "@/features/codex/codexRelationApi",
    );
    const { buildExistingRelationCatalog } = await renderer(
      "@/features/codex/extraction/existingRelationMatcher",
    );
    const api = await renderer("@/features/codex/codexStructureExtractionApi");
    const {
      useCodexStructureExtractionStore,
      isSafeForCodexEntityBulkApprove: isBulkSafe,
    } = await renderer("@/features/codex/codexStructureExtractionStore");

    // 場面を直下に持つ folder を 1 つ選ぶ（sample の構成に依存しない）。
    const nodes = await rows<{
      id: string;
      parentId: string | null;
      nodeType: string;
      sortOrder: string;
    }>(
      `SELECT id, parent_id AS parentId, node_type AS nodeType, sort_order AS sortOrder
         FROM tree_nodes
        WHERE project_id = ? AND archived_at IS NULL`,
      [projectId],
    );
    const scenesByFolder = new Map<string, string[]>();
    for (const node of [...nodes].sort((a, b) =>
      a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0,
    )) {
      if (node.nodeType !== "scene" || !node.parentId) continue;
      const list = scenesByFolder.get(node.parentId) ?? [];
      list.push(node.id);
      scenesByFolder.set(node.parentId, list);
    }
    const [folderId, sceneIds] = [...scenesByFolder.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )[0]!;
    expect(sceneIds.length).toBeGreaterThan(0);

    const readCatalogRequest = async () => {
      const entries = await listCodexEntries(projectId);
      const catalogs = api.buildCodexStructureCatalogs({
        entries: entries.map(
          (entry: {
            id: string;
            name: string;
            aliases: string | null;
            type: string;
            version: number;
          }) => ({
            id: entry.id,
            name: entry.name,
            aliases: entry.aliases,
            type: entry.type,
            version: entry.version,
          }),
        ),
        projectTypes: await listCodexTypes(projectId),
      });
      const existingRelations = buildExistingRelationCatalog(
        (await listCodexRelations(projectId)).map(
          (row: Record<string, unknown>) => ({
            id: row.id,
            fromCodexId: row.fromCodexId,
            toCodexId: row.toCodexId,
            relationType: row.relationType,
            directionality:
              row.directionality === "symmetric" ? "symmetric" : "directed",
            label: row.label,
            inverseLabel: row.inverseLabel,
            semanticKey: row.semanticKey,
            version: row.version,
          }),
        ),
      );
      return {
        entries,
        existingEntries: catalogs.existingCatalog,
        typeCatalog: catalogs.typeCatalog,
        existingRelations,
      };
    };

    const startExtraction = (
      catalog: Awaited<ReturnType<typeof readCatalogRequest>>,
    ) =>
      api.startCodexStructureExtraction({
        projectId,
        folderId,
        sceneIds,
        authority: captureMutationAuthority(projectId, getCurrentProjectId),
        workspacePath: workspace.path,
        openRevision: workspace.openRevision,
        useAi: false,
        existingEntries: catalog.existingEntries,
        typeCatalog: catalog.typeCatalog,
        existingRelations: catalog.existingRelations,
      });

    // --- 材料の catalog を読んだ後に Codex が変わったら、保存の前に止まる ---
    const staleCatalog = await readCatalogRequest();
    await createCodexEntry({
      id: "csx-added-after-material",
      projectId,
      type: "character",
      name: "材料の後に足した項目",
    });
    await expect(startExtraction(staleCatalog)).rejects.toThrow(
      /NEX_READ_SET_STALE: Codex catalog changed after the extraction material was read \(entry\+csx-added-after-material\)/,
    );

    // --- 保存（実 Native へ Run・ProposalSet を書く）---
    const catalog = await readCatalogRequest();
    const live = await startExtraction(catalog);
    expect(live.proposalSetId).toBeTruthy();
    expect(live.proposals.length).toBeGreaterThan(0);
    const savedSets = await rows<{ id: string; proposals: number }>(
      `SELECT ps.id AS id, COUNT(p.id) AS proposals
         FROM narrative_proposal_sets ps
         LEFT JOIN narrative_proposals p ON p.proposal_set_id = ps.id
        WHERE ps.id = ?
        GROUP BY ps.id`,
      [live.proposalSetId],
    );
    expect(savedSets).toHaveLength(1);
    expect(savedSets[0]!.proposals).toBeGreaterThan(0);
    type Safety = Record<string, boolean>;
    const liveSafety = new Map<string, Safety>(
      live.proposals.map((proposal: { proposalId: string; safety: Safety }) => [
        proposal.proposalId,
        proposal.safety,
      ]),
    );

    // --- 再読込（store を空にして DB から restore する）---
    useCodexStructureExtractionStore.getState().clearProjection();
    const restored = await api.restoreCodexStructureExtractionReview({
      projectId,
      workspacePath: workspace.path,
      openRevision: workspace.openRevision,
      folderId,
    });
    expect(restored).not.toBeNull();
    expect(restored.runId).toBe(live.runId);
    expect(restored.proposalSetId).toBe(live.proposalSetId);
    expect(
      restored.proposals
        .map((p: { proposalId: string }) => p.proposalId)
        .sort(),
    ).toEqual(
      live.proposals.map((p: { proposalId: string }) => p.proposalId).sort(),
    );
    useCodexStructureExtractionStore.getState().setProjection(restored);

    // 一括承認の可否：live と restore で比べる。restore（`rebuildEntityFromNative`）は
    // explicitProperName を常に true にし、hasRelationDeps を渡さない（noRelationDeps
    // も常に true）。旗ごとの差と、一括承認の判定の差を数える。
    const flagDiffs: { flag: string; live: boolean; restored: boolean }[] = [];
    let bulkSafeLive = 0;
    let bulkSafeRestored = 0;
    const bulkSafeDiff: string[] = [];
    for (const proposal of restored.proposals as {
      proposalId: string;
      safety: Safety;
    }[]) {
      const before = liveSafety.get(proposal.proposalId)!;
      for (const flag of Object.keys(before)) {
        if (before[flag] !== proposal.safety[flag]) {
          flagDiffs.push({
            flag,
            live: before[flag]!,
            restored: proposal.safety[flag]!,
          });
        }
      }
      const safeLive = isBulkSafe(before) as boolean;
      const safeRestored = isBulkSafe(proposal.safety) as boolean;
      if (safeLive) bulkSafeLive += 1;
      if (safeRestored) bulkSafeRestored += 1;
      if (safeLive !== safeRestored) bulkSafeDiff.push(proposal.proposalId);
    }
    // AI なしの prepass の seed はすべて固有名で、Entity の提案に依存は無いので揃う。
    expect(flagDiffs).toEqual([]);
    expect(bulkSafeDiff).toEqual([]);
    expect(bulkSafeLive).toBeGreaterThan(0);
    expect(bulkSafeRestored).toBe(bulkSafeLive);

    // --- 承認（applicable な Entity を 1 件）---
    const target = restored.proposals.find(
      (proposal: { applicability: string; status: string }) =>
        proposal.applicability === "applicable" &&
        proposal.status === "unreviewed",
    );
    expect(target).toBeTruthy();
    await api.decideCodexStructureProposal({
      proposalId: target.proposalId,
      status: "approved",
      kind: "entity",
    });
    const decisions = await rows<{ decision: string }>(
      `SELECT decision FROM narrative_proposal_decisions WHERE proposal_id = ?`,
      [target.proposalId],
    );
    expect(decisions.map((row) => row.decision)).toContain("approved");

    // --- 取り込み（作者が manual-apply を選んだ状態。既定は review-only）---
    const policy = ok<Record<string, unknown> & { version: number }>(
      await route("narrative_runtime_policy_get", {}),
    );
    ok(
      await route("narrative_runtime_policy_set", {
        payload: {
          expectedVersion: policy.version,
          runtimeMode: "manual-apply",
          maintenanceEnabled: policy.maintenanceEnabled,
          genericImportEnabled: policy.genericImportEnabled,
          backgroundAiEnabled: policy.backgroundAiEnabled,
        },
      }),
    );
    const entriesBefore = (await listCodexEntries(projectId)).length;
    const applied = await api.applyCodexStructureExtractionReview({
      projectId,
      entries: (await listCodexEntries(projectId)).map(
        (entry: {
          id: string;
          version: number;
          aliases: string | null;
          type: string;
        }) => ({
          id: entry.id,
          version: entry.version,
          aliases: entry.aliases,
          type: entry.type,
        }),
      ),
    });
    const after = await listCodexEntries(projectId);
    const binding = target.proposal.payload.binding as { kind: string };
    if (binding.kind === "create-new") {
      expect(after.length).toBe(entriesBefore + 1);
      expect(
        after.some(
          (entry: { name: string }) => entry.name === target.displayTitle,
        ),
      ).toBe(true);
    }
    const commits = await rows<{ status: string }>(
      `SELECT c.status AS status
         FROM narrative_apply_commits c
        WHERE c.proposal_set_id = ?`,
      [live.proposalSetId],
    );
    expect(applied).toBe(1);
    expect(commits.map((row) => row.status)).toEqual(["applied"]);

    // --- 記録：固有名でない seed では、live と restore で一括承認の判定が分かれる ---
    // live は seed.form（proper-name か）で explicitProperName を決めるが、restore は
    // 常に true にする。直すかは別に判断する（DR-CSX-1 の「残すこと」）。直したら
    // この期待を「揃う」に反転する。
    const source = (
      live.proposals as {
        proposalId: string;
        displayTitle: string;
        safety: Safety;
        evidence: { method: string; blocked: boolean }[];
        proposal: {
          payload: { typeResolution: { status: string; typeRef?: string } };
        };
      }[]
    ).find(
      (proposal) =>
        proposal.proposalId !== target.proposalId &&
        isBulkSafe(proposal.safety) &&
        proposal.evidence.some((row) => row.method === "exact" && !row.blocked),
    )!;
    expect(source).toBeTruthy();
    const aliasCatalog = await readCatalogRequest();
    const aliasLive = await api.startCodexStructureExtraction({
      projectId,
      folderId,
      sceneIds,
      authority: captureMutationAuthority(projectId, getCurrentProjectId),
      workspacePath: workspace.path,
      openRevision: workspace.openRevision,
      useAi: false,
      existingEntries: aliasCatalog.existingEntries,
      typeCatalog: aliasCatalog.typeCatalog,
      existingRelations: aliasCatalog.existingRelations,
      heuristicSeeds: [
        {
          surface: source.displayTitle,
          form: "alias",
          coarseClass: "unknown",
          typeRef: source.proposal.payload.typeResolution.typeRef,
          evidence: source.evidence,
        },
      ],
    });
    const aliasLiveProposal = aliasLive.proposals[0];
    expect(aliasLiveProposal.safety.explicitProperName).toBe(false);
    expect(isBulkSafe(aliasLiveProposal.safety)).toBe(false);
    useCodexStructureExtractionStore.getState().clearProjection();
    const aliasRestored = await api.restoreCodexStructureExtractionReview({
      projectId,
      workspacePath: workspace.path,
      openRevision: workspace.openRevision,
      folderId,
    });
    expect(aliasRestored.runId).toBe(aliasLive.runId);
    const aliasRestoredProposal = aliasRestored.proposals.find(
      (proposal: { proposalId: string }) =>
        proposal.proposalId === aliasLiveProposal.proposalId,
    );
    expect(aliasRestoredProposal.safety.explicitProperName).toBe(true);
    expect(isBulkSafe(aliasRestoredProposal.safety)).toBe(true);
  });
});
