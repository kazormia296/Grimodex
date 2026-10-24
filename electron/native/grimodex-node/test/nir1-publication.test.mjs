// NIR-1 DA-1 ST4 (K3/2 `nir1-publication` と Scope の Native の検査): 6 つの NIR
// command と Scope の 3 command が、restricted の profile では Main が発行して
// 登録した caller identity でだけ開始でき、unrestricted は現行どおり検査なしで
// 通ることを、実 Backend の N-API で固定する。identity は末尾の任意引数（Main の
// non-enumerable な sidecar の wire）で、typed request の形は変えない。
//
// 返却時の再認可と begin が作った operation の解放は、Rust の unit test
// （profile_egress.rs の `restricted_publication_recheck_rejects_every_revocation`）と
// Main の ipc 試験が固定する。実 Chronicle index と embedding を要する begin の
// 成功経路は、ここでは扱わない。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { placeRestrictedProfile } from "./profile-activation-helper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const DENIED = /D2A_EGRESS_DENIED/;
const NOT_DENIED = (error) => {
  assert.doesNotMatch(String(error?.message ?? error), DENIED);
  return true;
};

function workspaceRequest(workspace, extra = {}) {
  return { expectedWorkspacePath: workspace, ...extra };
}

/** One call per publication entry. `identity` is the wire string or undefined. */
function entries(backend, workspace) {
  const withIdentity = (args, identity) =>
    identity === undefined ? args : [...args, identity];
  return {
    related_scenes_begin: (identity) =>
      backend.relatedScenesBegin(
        ...withIdentity(
          [
            {
              ownerKey: "owner-1",
              expectedWorkspacePath: workspace,
              projectId: "no-project",
              currentSceneId: "no-scene",
              query: "query",
            },
          ],
          identity,
        ),
      ),
    related_scenes_continue: (identity) =>
      backend.relatedScenesContinue(
        ...withIdentity(["owner-1", "ticket-1"], identity),
      ),
    related_scenes_graph_continue: (identity) =>
      backend.relatedScenesGraphContinue(
        ...withIdentity(
          ["owner-1", { operationTicket: "ticket-1", rawSceneIds: [] }],
          identity,
        ),
      ),
    nir1_evidence_qualify: (identity) =>
      backend.nir1EvidenceQualify(
        ...withIdentity(["owner-1", "navigation-1"], identity),
      ),
    nir1_entity_relation_revision_read: (identity) =>
      backend.nir1EntityRelationRevisionRead(
        ...withIdentity(
          [
            workspaceRequest(workspace, {
              projectId: "no-project",
              revisionId: "no-revision",
            }),
          ],
          identity,
        ),
      ),
    nir1_entity_relation_revision_read_current: (identity) =>
      backend.nir1EntityRelationRevisionReadCurrent(
        ...withIdentity(
          [
            workspaceRequest(workspace, {
              projectId: "no-project",
              runId: "no-run",
            }),
          ],
          identity,
        ),
      ),
    nir1_entity_relation_revision_restore: (identity) =>
      backend.nir1EntityRelationRevisionRestore(
        ...withIdentity(
          [
            workspaceRequest(workspace, {
              projectId: "no-project",
              entityId: "no-entity",
            }),
          ],
          identity,
        ),
      ),
    narrative_scene_scope_read: (identity) =>
      backend.narrativeSceneScopeRead(
        ...withIdentity(
          [
            workspaceRequest(workspace, {
              projectId: "no-project",
              sceneId: "no-scene",
            }),
          ],
          identity,
        ),
      ),
    narrative_scene_scope_update: (identity) =>
      backend.narrativeSceneScopeUpdate(
        ...withIdentity(
          [
            workspaceRequest(workspace, {
              payload: { projectId: "no-project" },
            }),
          ],
          identity,
        ),
      ),
    narrative_scene_scope_registry_update: (identity) =>
      backend.narrativeSceneScopeRegistryUpdate(
        ...withIdentity(
          [
            workspaceRequest(workspace, {
              payload: { projectId: "no-project" },
            }),
          ],
          identity,
        ),
      ),
  };
}

const COMMANDS = [
  "related_scenes_begin",
  "related_scenes_continue",
  "related_scenes_graph_continue",
  "nir1_evidence_qualify",
  "nir1_entity_relation_revision_read",
  "nir1_entity_relation_revision_read_current",
  "nir1_entity_relation_revision_restore",
  "narrative_scene_scope_read",
  "narrative_scene_scope_update",
  "narrative_scene_scope_registry_update",
];

async function restrictedRig(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-nir-pub-${label}-`));
  // DA-2 (D-7): a restricted state file, not an activation (K3/2 "公開" (b)).
  placeRestrictedProfile(join(root, "app-data"));
  const backend = new Backend(join(root, "app-data"));
  const status = JSON.parse(await backend.initializeProfileEgress());
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const identity = {
    profileId: status.profileId,
    callerId: "main-caller",
    callerEpoch: status.callerEpoch,
    senderId: 42,
    workspaceId: workspace,
    sessionId: "main-session",
  };
  await backend.registerProfileEgressCaller(JSON.stringify(identity));
  return {
    root,
    backend,
    status,
    workspace,
    identity,
    wire: JSON.stringify(identity),
    call: entries(backend, workspace),
    async close() {
      const wire = await backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("restricted: a missing identity is refused by every publication entry", async () => {
  const rig = await restrictedRig("missing");
  try {
    for (const command of COMMANDS) {
      await assert.rejects(rig.call[command](undefined), DENIED, command);
    }
  } finally {
    await rig.close();
  }
});

test("restricted: malformed, unregistered, stale and forged identities are refused", async () => {
  const rig = await restrictedRig("forged");
  try {
    const unregistered = JSON.stringify({ ...rig.identity, senderId: 43 });
    const stale = JSON.stringify({
      ...rig.identity,
      callerEpoch: rig.identity.callerEpoch + 1,
    });
    const otherWorkspace = JSON.stringify({
      ...rig.identity,
      workspaceId: join(rig.root, "workspace-other"),
    });
    const forgedSession = JSON.stringify({
      ...rig.identity,
      sessionId: "renderer-forged",
    });
    const noWorkspace = JSON.stringify({ ...rig.identity, workspaceId: null });
    for (const [label, wire] of [
      ["malformed", "{not json"],
      ["unregistered sender", unregistered],
      ["stale epoch", stale],
      ["other workspace", otherWorkspace],
      ["forged session", forgedSession],
      ["no workspace", noWorkspace],
    ]) {
      for (const command of COMMANDS) {
        await assert.rejects(
          rig.call[command](wire),
          DENIED,
          `${command} (${label})`,
        );
      }
    }
  } finally {
    await rig.close();
  }
});

test("restricted: the registered identity of the active workspace is admitted", async () => {
  const rig = await restrictedRig("admitted");
  try {
    // The request itself is for a project that does not exist, so each entry
    // answers with its own domain result or failure. What matters is that none
    // of them is a D2a refusal, and that no refusal carries an owner or ticket.
    for (const command of COMMANDS) {
      await rig.call[command](rig.wire).then(() => undefined, NOT_DENIED);
    }
    // Entries with no workspace precondition resolve with the domain answer.
    assert.equal(
      JSON.parse(await rig.call.related_scenes_continue(rig.wire)).reason,
      "cancelled",
    );
    assert.equal(
      JSON.parse(await rig.call.related_scenes_graph_continue(rig.wire)).reason,
      "cancelled",
    );
    // The settle shape is the same command; an unknown ticket is cancelled.
    assert.equal(
      JSON.parse(
        await rig.backend.relatedScenesGraphContinue(
          "owner-1",
          { operationTicket: "ticket-1", settle: "unused" },
          rig.wire,
        ),
      ).reason,
      "cancelled",
    );
    assert.equal(
      JSON.parse(await rig.call.nir1_evidence_qualify(rig.wire)).reason,
      "cancelled",
    );
  } finally {
    await rig.close();
  }
});

test("restricted: a refusal names no owner, ticket or identity", async () => {
  const rig = await restrictedRig("leak");
  try {
    for (const command of [
      "related_scenes_begin",
      "related_scenes_continue",
      "related_scenes_graph_continue",
      "nir1_evidence_qualify",
    ]) {
      await assert.rejects(rig.call[command](undefined), (error) => {
        const message = String(error.message);
        assert.match(message, DENIED);
        for (const secret of [
          "owner-1",
          "ticket-1",
          "navigation-1",
          "no-project",
          "main-caller",
          "main-session",
        ]) {
          assert.ok(!message.includes(secret), `${command} leaks ${secret}`);
        }
        return true;
      });
    }
  } finally {
    await rig.close();
  }
});

test("restricted: a workspace switch revokes the identity before the next call", async () => {
  const rig = await restrictedRig("switch");
  try {
    await rig.call
      .nir1_entity_relation_revision_read(rig.wire)
      .then(() => undefined, NOT_DENIED);
    // Opening another workspace invalidates every process-local registration
    // and moves the pinned workspace, so the old tuple is refused.
    await rig.backend.openWorkspace(join(rig.root, "workspace-next"));
    for (const command of COMMANDS) {
      await assert.rejects(
        entries(rig.backend, join(rig.root, "workspace-next"))[command](
          rig.wire,
        ),
        DENIED,
        command,
      );
    }
  } finally {
    await rig.close();
  }
});

test("unrestricted: every publication entry runs unchecked, with or without an identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "grimodex-nir-pub-unrestricted-"));
  const backend = new Backend(join(root, "app-data"));
  try {
    await backend.initializeProfileEgress();
    const workspace = join(root, "workspace");
    await backend.openWorkspace(workspace);
    const call = entries(backend, workspace);
    const identity = JSON.stringify({
      profileId: "any",
      callerId: "any",
      callerEpoch: 1,
      senderId: 1,
      workspaceId: null,
      sessionId: "any",
    });
    for (const command of COMMANDS) {
      for (const wire of [undefined, identity]) {
        await call[command](wire).then(() => undefined, NOT_DENIED);
      }
    }
    // A malformed identity is refused whatever the profile mode.
    await assert.rejects(call.nir1_evidence_qualify("{not json"), DENIED);
  } finally {
    const wire = await backend.shutdownWorkspaceLifecycle();
    assert.equal(JSON.parse(wire).status, "closed");
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph continue: a malformed request is a request error, never a D2a refusal or a Graph state", async () => {
  const rig = await restrictedRig("graph-shape");
  try {
    const bad = [
      {},
      { operationTicket: "ticket-1" },
      { operationTicket: "ticket-1", rawSceneIds: [], settle: "used" },
      { operationTicket: "ticket-1", settle: "later" },
      { operationTicket: "ticket-1", rawSceneIds: [], extra: true },
      { operationTicket: "ticket-1", rawSceneIds: ["a", "a"] },
      {
        operationTicket: "ticket-1",
        rawSceneIds: Array.from({ length: 9 }, (_, index) => `s${index}`),
      },
    ];
    for (const request of bad) {
      await assert.rejects(
        rig.backend.relatedScenesGraphContinue("owner-1", request, rig.wire),
        (error) => {
          NOT_DENIED(error);
          assert.match(String(error.message), /RELATED_SCENES_UNAVAILABLE/);
          return true;
        },
        JSON.stringify(request),
      );
    }
  } finally {
    await rig.close();
  }
});

test("the Graph stays closed in a normal start: the direct query entry refuses, and a graph continue answers cancelled without a workspace read", async () => {
  const rig = await restrictedRig("graph-closed");
  try {
    await assert.rejects(
      rig.backend.nir1GraphQuery({
        expectedWorkspacePath: rig.workspace,
        projectId: "no-project",
        querySceneId: "no-scene",
        seedEntityId: "no-entity",
      }),
      /NIR1_GRAPH_NOT_ACTIVATED/,
    );
    for (const request of [
      { operationTicket: "ticket-1", rawSceneIds: [] },
      { operationTicket: "ticket-1", settle: "cancelled" },
    ]) {
      assert.equal(
        JSON.parse(
          await rig.backend.relatedScenesGraphContinue(
            "owner-1",
            request,
            rig.wire,
          ),
        ).reason,
        "cancelled",
      );
    }
  } finally {
    await rig.close();
  }
});
