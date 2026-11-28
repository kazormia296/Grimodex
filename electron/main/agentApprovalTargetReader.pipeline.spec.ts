import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { generateNKeysBetween } from "../shared/readDomain/features/tree/fractionalIndex.js";
import {
  createAgentApprovalExchange,
  type AgentApprovalExchangeDependencies,
  type AgentApprovalRequest,
  type AgentApprovalRunHandle,
} from "./agentApprovalExchange.js";
import {
  AGENT_APPROVAL_PROTECTED_TOOLS,
  type AgentApprovalExpected,
} from "./agentApprovalProtectedTools.js";
import { FakeAgentRunApprovalPort } from "./agentRunApprovalPort.fake.js";
import type {
  AgentRunLedgerEntry,
  AgentRunState,
} from "./agentRunRecorderPort.js";
import { createAgentApprovalTargetReader } from "./agentApprovalTargetReader.js";
import { createMainReadDb } from "./mastraRead/db.js";

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

interface NativeBackendInstance extends NapiBackendLike {
  aiTreePlanApply(payload: unknown): Promise<string>;
  shutdownWorkspaceLifecycle(): Promise<string>;
}

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];

afterAll(async () => {
  for (const backend of backends) {
    expect(JSON.parse(await backend.shutdownWorkspaceLifecycle()).status).toBe(
      "closed",
    );
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

function agentWriteContext(
  projectId: string,
  requestId: string,
  origin: "ai-apply" | "human" = "ai-apply",
) {
  const interactive = origin === "ai-apply";
  return {
    requestId,
    projectId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin,
    authorityRoute: interactive ? "interactive-agent-command" : "human-direct",
    caller: interactive ? "chat-tool-executor" : "manual-wrapper",
    controls: interactive
      ? [
          "knowledge-write-policy",
          "stable-request-id",
          "agent-provenance",
          "field-authority",
          "typed-writer",
          "occ",
          "undo-journal",
          "change-event",
          "change-feed",
        ]
      : [
          "runtime-policy",
          "actor-context",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
    provenance: interactive
      ? {
          requestId,
          traceId: `${requestId}:trace`,
          executionId: `${requestId}:execution`,
          mainOwnedProvenanceId: `${requestId}:main-provenance`,
        }
      : null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
  };
}

function writerResult<T>(wire: string): T {
  return JSON.parse(wire) as T;
}

function withoutExpectedKind(expected: AgentApprovalExpected) {
  const nativeExpected = Object.assign({}, expected) as Record<string, unknown>;
  delete nativeExpected.kind;
  return nativeExpected;
}

async function expectVersionConflict(
  attempt: Promise<unknown>,
  snapshot: () => Promise<unknown>,
  before: unknown,
): Promise<void> {
  await expect(attempt).rejects.toThrow(/version conflict/i);
  expect(await snapshot()).toEqual(before);
}

async function startWorkspace(): Promise<{
  backend: NativeBackendInstance;
  projectId: string;
  readDb: ReturnType<typeof createMainReadDb>;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-agent-target-"));
  roots.push(root);
  const appData = path.join(realpathSync(root), "app-data");
  mkdirSync(appData, { recursive: true });
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");
  const gate = await createProfileEgressGate(backend as NapiBackendLike);
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
  const route = (cmd: string, args: Record<string, unknown> = {}) =>
    handler(event, cmd, args);
  const seeded = ok<{ path: string; projectId: string }>(
    await route("seed_sample_workspace", {
      language: "ja",
      aiPolicy:
        '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}',
    }),
  );
  ok(await route("open_workspace", { path: seeded.path }));
  const identity = gate.issueCallerIdentity(7);
  const dbExecute = vi.fn((...args: Parameters<NapiBackendLike["dbExecute"]>) =>
    backend.dbExecute(...args),
  );
  const readDb = createMainReadDb({
    backend: { dbExecute },
    identity,
  });
  return { backend, projectId: seeded.projectId, readDb };
}

describe("agent approval target reader through the real Native addon", () => {
  it("matches Native rows and writers, then reaches pending in the real exchange", async () => {
    const ws = await startWorkspace();
    const { backend, projectId, readDb } = ws;
    const readRows = async (sql: string, params: unknown[] = []) =>
      (await readDb(sql, params, "all")).rows;
    const readTarget = createAgentApprovalTargetReader({ readDb });
    let requestNumber = 0;
    const requestId = (name: string) =>
      `agent-tool:approval-target-${name}-${++requestNumber}`;

    const sceneId = `approval-target-scene-${projectId}`;
    const parentRows = await readRows(
      "SELECT id FROM tree_nodes WHERE project_id = ? AND node_type = 'folder' ORDER BY id LIMIT 1",
      [projectId],
    );
    const parentId = parentRows[0]?.[0];
    if (typeof parentId !== "string")
      throw new Error("sample workspace has no folder for the scene fixture");
    const siblingRows = await readRows(
      "SELECT sort_order FROM tree_nodes WHERE project_id = ? AND parent_id = ? ORDER BY sort_order",
      [projectId, parentId],
    );
    const lastSiblingSortOrder =
      siblingRows[siblingRows.length - 1]?.[0] ?? null;
    if (
      lastSiblingSortOrder !== null &&
      typeof lastSiblingSortOrder !== "string"
    )
      throw new Error("sample folder has an invalid sibling order");
    const sceneSortOrder = generateNKeysBetween(
      lastSiblingSortOrder,
      null,
      1,
    )[0];
    if (!sceneSortOrder) throw new Error("could not place the scene fixture");
    const sceneTitle = "Approval target scene";
    const sceneTempId = `tmp:${sceneId}`;
    await backend.aiTreePlanApply({
      ...agentWriteContext(projectId, requestId("scene")),
      surface: "in-app-agent",
      kind: "scaffold",
      updatedAt: new Date().toISOString(),
      model: "test-model",
      traceId: requestId("scene-trace"),
      creates: [
        {
          tempId: sceneTempId,
          id: sceneId,
          parentId,
          nodeType: "scene",
          title: sceneTitle,
          sortOrder: sceneSortOrder,
          synopsis: null,
        },
      ],
      updates: [],
      ops: [
        {
          op: "create",
          tempId: sceneTempId,
          parentRef: parentId,
          nodeType: "scene",
          title: sceneTitle,
          synopsis: null,
          pos: {},
        },
      ],
      redo: false,
      originalTransactionId: null,
      undoJournalId: null,
    });
    const codexEntry = writerResult<{ entityId: string }>(
      await backend.agentCodexCreate({
        ...agentWriteContext(projectId, requestId("codex")),
        entryId: `approval-target-codex-${projectId}`,
        typeSlug: "character",
        name: "Approval target character",
        summary: "target reader fixture",
        content: "{}",
        authorshipSpans: [],
      }),
    );
    const foreshadow = writerResult<{ entityId: string }>(
      await backend.agentForeshadowCreate({
        ...agentWriteContext(projectId, requestId("foreshadow")),
        foreshadowId: `approval-target-foreshadow-${projectId}`,
        title: "Approval target foreshadow",
        intent: null,
        notes: null,
        loadBearing: "critical",
        secret: false,
      }),
    );
    await backend.agentSnippetCreate({
      ...agentWriteContext(projectId, requestId("snippet")),
      snippetId: `approval-target-snippet-${projectId}`,
      title: "Approval target snippet",
      content: "{}",
      authorshipSpans: [],
    });
    const cause = writerResult<{ entityId: string; version: number }>(
      await backend.agentEventCreate({
        ...agentWriteContext(projectId, requestId("event-cause")),
        eventId: `approval-target-event-cause-${projectId}`,
        startTime: 0,
        title: "Approval target cause",
      }),
    );
    const effect = writerResult<{ entityId: string; version: number }>(
      await backend.agentEventCreate({
        ...agentWriteContext(projectId, requestId("event-effect")),
        eventId: `approval-target-event-effect-${projectId}`,
        startTime: 1,
        title: "Approval target effect",
      }),
    );
    const foreshadowTarget = await readTarget({
      projectId,
      toolName: "update_foreshadow",
      modelInput: { id: foreshadow.entityId },
    });
    const foreshadowVersion = foreshadowTarget?.baseVersions?.find(
      ({ id }) => id === foreshadow.entityId,
    )?.version;
    if (foreshadowVersion === undefined)
      throw new Error("foreshadow version not found");

    const modelInputs: Record<string, Record<string, unknown>> = {
      create_codex_entry: { type: "character", name: "New character" },
      update_codex_entry: { id: codexEntry.entityId, name: "Changed" },
      create_foreshadow: { title: "New foreshadow" },
      update_foreshadow: {
        id: foreshadow.entityId,
        baseVersion: foreshadowVersion,
      },
      create_snippet: { title: "New snippet" },
      create_event: { title: "New event" },
      update_event: { eventId: cause.entityId, title: "Changed event" },
      delete_event: { eventId: effect.entityId },
      stamp_scene_event: { sceneId, eventId: cause.entityId },
      unstamp_scene_event: { sceneId, eventId: cause.entityId },
      set_event_participants: {
        eventId: cause.entityId,
        codexEntryIds: [codexEntry.entityId],
      },
      add_event_relation: {
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
      },
      remove_event_relation: {
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
      },
      apply_ai_tree_plan: {
        ops: [{ op: "rename", nodeId: sceneId, title: "Plan rename" }],
      },
    };
    expect(Object.keys(modelInputs).sort()).toEqual(
      [...AGENT_APPROVAL_PROTECTED_TOOLS].sort(),
    );

    for (const toolName of AGENT_APPROVAL_PROTECTED_TOOLS) {
      const modelInput = modelInputs[toolName]!;
      const observedTarget = await readTarget({
        projectId,
        toolName,
        modelInput,
      });
      expect(observedTarget, toolName).not.toBeNull();
      if (!observedTarget) throw new Error(`missing target for ${toolName}`);

      const observed = {
        basis: observedTarget.basis,
        baseVersions: observedTarget.baseVersions,
        expected: observedTarget.expected,
      };
      const runId = `run-${toolName}`;
      const callId = `call-${toolName}`;
      const interactionId = `interaction-${toolName}`;
      const port = new FakeAgentRunApprovalPort();
      let version = port.createRunningRun(runId).version;
      const run: AgentApprovalRunHandle = {
        runId,
        async transact<T extends AgentRunState>(
          op: (version: number) => Promise<T>,
        ): Promise<T> {
          const state = await op(version);
          version = state.version;
          return state;
        },
      };
      const controller = new AbortController();
      const request: AgentApprovalRequest = {
        senderId: 11,
        projectId,
        executionId: `execution-${toolName}`,
        chatMessageId: `message-${toolName}`,
        toolCallId: callId,
        toolName,
        model: "test-model",
        modelInput,
        observed,
        run,
        signal: controller.signal,
      };
      const entry: AgentRunLedgerEntry = {
        toolCallId: callId,
        name: toolName,
        canonicalArgs: modelInput,
        argsDigest: "digest",
        executionId: request.executionId,
        chatMessageId: request.chatMessageId,
        mainOwnedProvenanceId: "",
        model: "test-model",
        capabilityState: "not_issued",
        executionState: "pending",
      };
      await port.appendToolCalls(runId, [entry]);
      let pendingSeen = false;
      const dependencies: AgentApprovalExchangeDependencies<{
        readonly mainOwnedProvenanceId: string;
      }> = {
        port,
        isPolicyAllowed: () => true,
        inputDigest: () => "digest",
        readTarget,
        prepareCapability: () => null,
        onPending: () => {
          pendingSeen = true;
        },
        setTimer: () => () => undefined,
        newId: () => interactionId,
      };
      const exchange = createAgentApprovalExchange(dependencies);
      const completion = exchange.request(request);
      await vi.waitFor(() => expect(pendingSeen, toolName).toBe(true), {
        timeout: 30_000,
      });
      expect(port.readInteraction(interactionId)?.status).toBe("pending");
      expect(
        port.readToolCall(runId, {
          executionId: request.executionId,
          toolCallId: callId,
        }),
      ).toMatchObject({
        capabilityState: "awaiting_approval",
        executionState: "pending",
      });
      controller.abort();
      await expect(completion).resolves.toMatchObject({ kind: "aborted" });
    }

    const sceneLinkRows = (eventId: string) =>
      readRows(
        "SELECT incarnation_token FROM scene_events WHERE scene_id = ? AND event_id = ?",
        [sceneId, eventId],
      );
    const relationRows = () =>
      readRows(
        "SELECT cause_event_id, effect_event_id FROM event_relations WHERE cause_event_id = ? AND effect_event_id = ?",
        [cause.entityId, effect.entityId],
      );
    const bumpEventVersion = async (
      eventId: string,
      baseVersion: number,
      title: string,
    ) =>
      writerResult<{ version: number }>(
        await backend.agentEventUpdate({
          ...agentWriteContext(projectId, requestId("event-version")),
          eventId,
          baseVersion,
          title,
        }),
      );

    const staleStamp = await readTarget({
      projectId,
      toolName: "stamp_scene_event",
      modelInput: { sceneId, eventId: cause.entityId },
    });
    expect(staleStamp?.expected?.kind).toBe("scene_event_link");
    if (
      !staleStamp?.expected ||
      staleStamp.expected.kind !== "scene_event_link"
    )
      throw new Error("missing scene event expectation for stamp");
    const staleStampExpected = withoutExpectedKind(staleStamp.expected);
    expect(staleStampExpected).not.toHaveProperty("kind");
    const beforeStamp = await sceneLinkRows(cause.entityId);
    await bumpEventVersion(
      cause.entityId,
      staleStamp.expected.eventVersion,
      "Changed before stale stamp",
    );
    await expectVersionConflict(
      backend.agentSceneEventLink({
        ...agentWriteContext(projectId, requestId("stamp-stale")),
        sceneId,
        eventId: cause.entityId,
        expected: staleStampExpected,
      }),
      () => sceneLinkRows(cause.entityId),
      beforeStamp,
    );
    const stamp = await readTarget({
      projectId,
      toolName: "stamp_scene_event",
      modelInput: { sceneId, eventId: cause.entityId },
    });
    if (!stamp?.expected || stamp.expected.kind !== "scene_event_link")
      throw new Error("missing scene event expectation for stamp");
    await backend.agentSceneEventLink({
      ...agentWriteContext(projectId, requestId("stamp")),
      sceneId,
      eventId: cause.entityId,
      expected: withoutExpectedKind(stamp.expected),
    });
    const linkedRows = await sceneLinkRows(cause.entityId);
    expect(linkedRows).toHaveLength(1);
    expect(typeof linkedRows[0]?.[0]).toBe("string");

    const staleUnstamp = await readTarget({
      projectId,
      toolName: "unstamp_scene_event",
      modelInput: { sceneId, eventId: cause.entityId },
    });
    if (
      !staleUnstamp?.expected ||
      staleUnstamp.expected.kind !== "scene_event_link"
    )
      throw new Error("missing scene event expectation for unstamp");
    const staleUnstampExpected = withoutExpectedKind(staleUnstamp.expected);
    const beforeUnstamp = await sceneLinkRows(cause.entityId);
    await bumpEventVersion(
      cause.entityId,
      staleUnstamp.expected.eventVersion,
      "Changed before stale unstamp",
    );
    await expectVersionConflict(
      backend.agentSceneEventUnlink({
        ...agentWriteContext(projectId, requestId("unstamp-stale")),
        sceneId,
        eventId: cause.entityId,
        expected: staleUnstampExpected,
      }),
      () => sceneLinkRows(cause.entityId),
      beforeUnstamp,
    );
    const unstamp = await readTarget({
      projectId,
      toolName: "unstamp_scene_event",
      modelInput: { sceneId, eventId: cause.entityId },
    });
    if (!unstamp?.expected || unstamp.expected.kind !== "scene_event_link")
      throw new Error("missing scene event expectation for unstamp");
    await backend.agentSceneEventUnlink({
      ...agentWriteContext(projectId, requestId("unstamp")),
      sceneId,
      eventId: cause.entityId,
      expected: withoutExpectedKind(unstamp.expected),
    });
    expect(await sceneLinkRows(cause.entityId)).toEqual([]);

    const staleAdd = await readTarget({
      projectId,
      toolName: "add_event_relation",
      modelInput: {
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
      },
    });
    if (!staleAdd?.expected || staleAdd.expected.kind !== "event_relation")
      throw new Error("missing event relation expectation for add");
    const staleAddExpected = withoutExpectedKind(staleAdd.expected);
    const beforeAdd = await relationRows();
    await bumpEventVersion(
      cause.entityId,
      staleAdd.expected.causeVersion,
      "Changed before stale relation add",
    );
    await expectVersionConflict(
      backend.agentEventRelationAdd({
        ...agentWriteContext(projectId, requestId("relation-add-stale")),
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
        expected: staleAddExpected,
      }),
      relationRows,
      beforeAdd,
    );
    const add = await readTarget({
      projectId,
      toolName: "add_event_relation",
      modelInput: {
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
      },
    });
    if (!add?.expected || add.expected.kind !== "event_relation")
      throw new Error("missing event relation expectation for add");
    await backend.agentEventRelationAdd({
      ...agentWriteContext(projectId, requestId("relation-add")),
      causeEventId: cause.entityId,
      effectEventId: effect.entityId,
      expected: withoutExpectedKind(add.expected),
    });
    expect(await relationRows()).toEqual([[cause.entityId, effect.entityId]]);

    const staleRemove = await readTarget({
      projectId,
      toolName: "remove_event_relation",
      modelInput: {
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
      },
    });
    if (
      !staleRemove?.expected ||
      staleRemove.expected.kind !== "event_relation"
    )
      throw new Error("missing event relation expectation for remove");
    const staleRemoveExpected = withoutExpectedKind(staleRemove.expected);
    const beforeRemove = await relationRows();
    await bumpEventVersion(
      effect.entityId,
      staleRemove.expected.effectVersion,
      "Changed before stale relation remove",
    );
    await expectVersionConflict(
      backend.agentEventRelationRemove({
        ...agentWriteContext(projectId, requestId("relation-remove-stale")),
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
        expected: staleRemoveExpected,
      }),
      relationRows,
      beforeRemove,
    );
    const remove = await readTarget({
      projectId,
      toolName: "remove_event_relation",
      modelInput: {
        causeEventId: cause.entityId,
        effectEventId: effect.entityId,
      },
    });
    if (!remove?.expected || remove.expected.kind !== "event_relation")
      throw new Error("missing event relation expectation for remove");
    await backend.agentEventRelationRemove({
      ...agentWriteContext(projectId, requestId("relation-remove")),
      causeEventId: cause.entityId,
      effectEventId: effect.entityId,
      expected: withoutExpectedKind(remove.expected),
    });
    expect(await relationRows()).toEqual([]);

    const eventModelInput = {
      eventId: cause.entityId,
      title: "Approved event rename",
    };
    const eventTarget = await readTarget({
      projectId,
      toolName: "update_event",
      modelInput: eventModelInput,
    });
    expect(eventTarget).not.toBeNull();
    if (!eventTarget?.baseVersions)
      throw new Error("missing event base version");
    const eventVersion = eventTarget.baseVersions.find(
      ({ id }) => id === cause.entityId,
    )?.version;
    if (eventVersion === undefined) throw new Error("event version not found");
    const eventRows = () =>
      readRows(
        "SELECT title, version FROM events WHERE project_id = ? AND id = ?",
        [projectId, cause.entityId],
      );
    const updatedEvent = writerResult<{ version: number }>(
      await backend.agentEventUpdate({
        ...agentWriteContext(projectId, requestId("event-update")),
        eventId: cause.entityId,
        baseVersion: eventVersion,
        title: eventModelInput.title,
      }),
    );
    expect(updatedEvent.version).toBe(eventVersion + 1);
    const afterEventUpdate = await eventRows();
    await expectVersionConflict(
      backend.agentEventUpdate({
        ...agentWriteContext(projectId, requestId("event-update-stale")),
        eventId: cause.entityId,
        baseVersion: eventVersion,
        title: "Stale event rename",
      }),
      eventRows,
      afterEventUpdate,
    );

    const rename = {
      op: "rename",
      nodeId: sceneId,
      title: "Approved tree rename",
    };
    const treeModelInput = { ops: [rename] };
    const treeTarget = await readTarget({
      projectId,
      toolName: "apply_ai_tree_plan",
      modelInput: treeModelInput,
    });
    expect(treeTarget).not.toBeNull();
    if (!treeTarget?.baseVersions)
      throw new Error("missing tree base versions");
    const treeVersion = treeTarget.baseVersions.find(
      ({ id }) => id === sceneId,
    )?.version;
    if (treeVersion === undefined) throw new Error("tree version not found");
    const treeRows = () =>
      readRows(
        "SELECT title, version FROM tree_nodes WHERE project_id = ? AND id = ?",
        [projectId, sceneId],
      );
    const applyTreeRename = (baseVersion: number, id: string) =>
      backend.aiTreePlanApply({
        ...agentWriteContext(projectId, id),
        surface: "in-app-agent",
        kind: "reorganize",
        updatedAt: new Date().toISOString(),
        model: "test-model",
        traceId: id,
        creates: [],
        updates: [
          {
            id: sceneId,
            baseVersion,
            placement: null,
            title: rename.title,
          },
        ],
        ops: [rename],
        redo: false,
        originalTransactionId: null,
        undoJournalId: null,
      });
    await applyTreeRename(treeVersion, requestId("tree-rename"));
    const afterTreeRename = await treeRows();
    expect(afterTreeRename[0]?.[0]).toBe(rename.title);
    expect(afterTreeRename[0]?.[1]).toBe(treeVersion + 1);
    await expect(
      applyTreeRename(treeVersion, requestId("tree-rename-stale")),
    ).rejects.toThrow(/AI_TREE_PLAN_VERSION_MISMATCH/);
    expect(await treeRows()).toEqual(afterTreeRename);
  });
});
