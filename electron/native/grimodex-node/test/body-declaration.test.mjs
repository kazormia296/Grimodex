// CB-2 / S2 (K2/4 `graph-target-scene-body-disclosure`, `scope-storage-authority`):
// Native の本文宣言の 2 つの入口、Main 専用の grant（MG-1）と gate を、実 Backend の
// N-API で固定する。
//
// 固定するもの: gate は既定で閉じ、閉じている間は preview・宣言・取消が DB を読む前に
// typed に拒否される／grant は 1 件・一回限り・sender と window に束縛／宣言は v1 の列を
// 変えない／取消は grant を要さない／restricted は登録済み caller を要し unrestricted は
// 要さない／再起動の後も宣言は残り gate は閉じる。
// 60 秒の期限、観測者の revoke の個別の edge、COMMIT 不明は Rust の unit test
// （main_grant_tests.rs、grimodex-db の writer の試験）が固定する。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { placeRestrictedProfile } from "./profile-activation-helper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const PROJECT = "default-project";
const SCENE = "scene-1";
const TITLE = "Chapter One";
const SENDER = 7;
const WINDOW = 11;
const GATE_CLOSED = "NEX_BODY_DECLARATION_REFUSED:gate-closed";
const VALUES = {
  story: "independent",
  auto: "independent",
  phase: "independent",
  reveal: "non-secret",
  pov: "independent",
};

let sequence = 0;
const unique = (label) => `${label}-${(sequence += 1)}`;

const tiptapDoc = (text) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

const exact = (ref) => ({ kind: "exact", ref });
const ANY = { kind: "any" };

async function seedScene(backend, text) {
  const requestId = unique("scene-create");
  await backend.treeNodeCreate({
    requestId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "human",
    authorityRoute: "human-direct",
    caller: "manual-wrapper",
    controls: [
      "runtime-policy",
      "actor-context",
      "typed-writer",
      "occ",
      "change-event",
      "change-feed",
    ],
    provenance: null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
    id: SCENE,
    projectId: PROJECT,
    parentId: null,
    nodeType: "scene",
    title: TITLE,
    sortOrder: "a0",
    content: tiptapDoc(text),
  });
}

/** An unrestricted Backend over a workspace whose Scene has an explicit A1. */
async function rig(label, { openGate = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-body-declaration-${label}-`));
  const appData = join(root, "app-data");
  const workspace = join(root, "workspace");
  let backend = new Backend(appData);
  await backend.openWorkspace(workspace);
  await seedScene(backend, "Mira opened the door.");

  const self = {
    root,
    appData,
    workspace,
    get backend() {
      return backend;
    },
    scopeRequest: (extra = {}) => ({
      expectedWorkspacePath: workspace,
      projectId: PROJECT,
      sceneId: SCENE,
      ...extra,
    }),
    async scope() {
      return JSON.parse(
        await backend.narrativeSceneScopeRead(self.scopeRequest()),
      );
    },
    async rows(sql, params = []) {
      return JSON.parse(await backend.dbExecute(sql, params, "all")).rows;
    },
    async columns() {
      const [row] = await self.rows(
        `SELECT body_declaration_json AS json, body_declaration_token AS token,
                version, source_token AS sourceToken, updated_at AS updatedAt,
                compatibility_marker AS marker
           FROM narrative_scene_scope_bindings
          WHERE project_id = ?1 AND scene_id = ?2`,
        [PROJECT, SCENE],
      );
      return row;
    },
    async counts() {
      const [{ idempotency }] = await self.rows(
        "SELECT count(*) AS idempotency FROM idempotency_requests WHERE domain LIKE 'scene_body_declaration_%'",
      );
      const [{ events }] = await self.rows(
        "SELECT count(*) AS events FROM narrative_change_events",
      );
      return { idempotency, events };
    },
    /** A typed Scene patch (a raw UPDATE of tree_nodes is a protected writer). */
    async patchScene(patch) {
      const [{ version }] = await self.rows(
        "SELECT version FROM tree_nodes WHERE id = ?1",
        [SCENE],
      );
      const requestId = unique("scene-patch");
      await backend.treeNodePatch({
        requestId,
        sessionId: `${requestId}:session`,
        eventUid: `${requestId}:event`,
        origin: "human",
        authorityRoute: "human-direct",
        caller: "manual-wrapper",
        controls: [
          "runtime-policy",
          "actor-context",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
        provenance: null,
        writesAuthorityProtectedField: false,
        originalTransactionId: null,
        undoJournalId: null,
        projectId: PROJECT,
        nodeId: SCENE,
        patch,
        baseVersion: version,
        bumpVersion: true,
        updatedAt: new Date().toISOString(),
      });
    },
    declareRequest(extra = {}) {
      return async () => {
        const read = await self.scope();
        const [row] = await self.rows(
          "SELECT body_declaration_token AS token FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
          [PROJECT, SCENE],
        );
        return {
          expectedWorkspacePath: workspace,
          payload: {
            projectId: PROJECT,
            sceneId: SCENE,
            requestId: unique("declare"),
            expected: {
              scopeVersion: read.binding.version,
              scopeToken: read.binding.sourceToken,
              declarationToken: row?.token ?? null,
            },
            values: VALUES,
            ...extra,
          },
        };
      };
    },
    revokeRequest: (declarationToken, requestId = unique("revoke")) => ({
      expectedWorkspacePath: workspace,
      payload: {
        projectId: PROJECT,
        sceneId: SCENE,
        requestId,
        declarationToken,
      },
    }),
    async preview(request, sender = SENDER, window = WINDOW) {
      return JSON.parse(
        await backend.mainGrantPreview(
          "body-declaration",
          JSON.stringify(request),
          sender,
          window,
        ),
      );
    },
    async issue(previewId, sender = SENDER, window = WINDOW) {
      return JSON.parse(await backend.mainGrantIssue(previewId, sender, window))
        .grantId;
    },
    sidecar: (grantId, sender = SENDER, window = WINDOW) =>
      JSON.stringify({ grantId, senderId: sender, windowId: window }),
    declare: (request, grantId, sender, window) =>
      backend.narrativeSceneBodyDeclarationDeclare(
        request,
        undefined,
        grantId === undefined ? undefined : self.sidecar(grantId, sender, window),
      ),
    revoke: (request) =>
      backend.narrativeSceneBodyDeclarationRevoke(request, undefined),
    stateRequest: () => ({
      expectedWorkspacePath: workspace,
      payload: { projectId: PROJECT, sceneId: SCENE },
    }),
    state: (request) =>
      backend.narrativeSceneBodyDeclarationState(request, undefined),
    /** preview + issue, returning what Main would hold. */
    async confirm(request) {
      const preview = await self.preview(request);
      const grantId = await self.issue(preview.previewId);
      return { preview, grantId };
    },
    /** Replace the Backend, as a restart does. */
    async restart() {
      const wire = await backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed");
      backend = new Backend(appData);
      await backend.openWorkspace(workspace);
    },
    async close() {
      const wire = await backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed");
      rmSync(root, { recursive: true, force: true });
    },
  };

  // The Scene's A1: a registry that knows the refs, then an explicit binding.
  const first = await self.scope();
  await backend.narrativeSceneScopeRegistryUpdate({
    expectedWorkspacePath: workspace,
    payload: {
      projectId: PROJECT,
      requestId: unique("registry"),
      sessionId: "fixture-session",
      eventUid: unique("registry-event"),
      baseVersion: first.registryRevision,
      updatedAt: "2026-10-18T00:00:00.000Z",
      registry: {
        registryVersion: first.registry.registryVersion,
        timelineRefs: ["tl"],
        worldlineRefs: ["wl"],
        narrativeLayerRefs: ["ly"],
      },
    },
  });
  const second = await self.scope();
  await backend.narrativeSceneScopeUpdate({
    expectedWorkspacePath: workspace,
    payload: {
      projectId: PROJECT,
      sceneId: SCENE,
      requestId: unique("a1"),
      sessionId: "fixture-session",
      eventUid: unique("a1-event"),
      baseVersion: second.binding.version,
      updatedAt: "2026-10-18T00:00:01.000Z",
      scope: {
        schemaVersion: 1,
        compatibilityMarker: "explicit",
        queryIdentity: {
          timeline: exact("tl"),
          worldline: exact("wl"),
          narrativeLayer: exact("ly"),
        },
        materialConstraint: {
          timeline: ANY,
          worldline: ANY,
          narrativeLayer: ANY,
        },
        knowledgeHolder: { kind: "reader" },
        audience: { kind: "reader" },
      },
    },
  });
  if (openGate) {
    backend.mainOpenPrePublicationGate("scene-body-declaration");
  }
  return self;
}

const refusedWith = (code) =>
  new RegExp(`^Error: NEX_BODY_DECLARATION_REFUSED:${code}$`);

test("the gate is closed by default: preview, declare and revoke refuse before reading anything (D9)", async () => {
  const r = await rig("closed", { openGate: false });
  try {
    const request = await r.declareRequest()();
    const before = await r.counts();
    const columnsBefore = await r.columns();
    await assert.rejects(r.preview(request), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    await assert.rejects(r.declare(request, "any-grant"), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    await assert.rejects(r.declare(request, undefined), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    await assert.rejects(r.revoke(r.revokeRequest("token")), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    // Nothing was written or stored.
    assert.deepEqual(await r.counts(), before);
    assert.deepEqual(await r.columns(), columnsBefore);
    assert.equal(columnsBefore.json, null);
    assert.equal(columnsBefore.token, null);
    // The gate's call refuses an unknown kind and leaves the gate closed.
    for (const kind of ["", "all", "local-send", "Scene-Body-Declaration"]) {
      assert.throws(
        () => r.backend.mainOpenPrePublicationGate(kind),
        /^Error: MAIN_GATE_KIND$/,
      );
    }
    await assert.rejects(r.preview(request), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    // One call opens it for this process.
    r.backend.mainOpenPrePublicationGate("scene-body-declaration");
    const preview = await r.preview(request);
    assert.equal(typeof preview.previewId, "string");
  } finally {
    await r.close();
  }
});

test("a declaration end to end: preview, issue, declare; the v1 columns do not change; revoke needs no grant", async () => {
  const r = await rig("end-to-end");
  try {
    const before = await r.columns();
    assert.equal(before.marker, "explicit");
    const request = await r.declareRequest()();
    const preview = await r.preview(request);
    assert.deepEqual(Object.keys(preview).sort(), [
      "display",
      "expiresInMs",
      "previewId",
    ]);
    assert.equal(preview.expiresInMs, 60000);
    assert.match(preview.previewId, /^[0-9a-f]{64}$/);
    // The dialog text comes from Native: it names the title Native read.
    assert.ok(preview.display.includes(TITLE));
    assert.ok(!preview.display.includes(preview.previewId));
    // The preview wrote nothing.
    assert.equal((await r.columns()).json, null);

    const grantId = await r.issue(preview.previewId);
    assert.match(grantId, /^[0-9a-f]{64}$/);
    assert.notEqual(grantId, preview.previewId);

    const response = await r.declare(request, grantId);
    assert.equal(response, JSON.stringify({ outcome: "declared" }));

    const after = await r.columns();
    assert.notEqual(after.json, null);
    assert.notEqual(after.token, null);
    const declaration = JSON.parse(after.json);
    // Neither the body nor the title is stored; the declaration ID and time
    // are Native's, not the request's.
    assert.ok(!after.json.includes("Mira opened"));
    assert.ok(!after.json.includes(TITLE));
    assert.ok(!after.json.includes(request.payload.requestId));
    assert.equal(typeof declaration.declarationId, "string");
    // The v1 columns are byte-identical.
    for (const key of ["version", "sourceToken", "updatedAt", "marker"]) {
      assert.equal(after[key], before[key], key);
    }

    // The same request again: the Scene now has a declaration, so a new
    // preview is refused (the screen must read the new state first).
    await assert.rejects(r.preview(request), refusedWith("state-changed"));

    // Revoke: no grant. A wrong token changes nothing.
    const wrong = await r.revoke(r.revokeRequest("not-the-token"));
    assert.equal(wrong, JSON.stringify({ outcome: "declaration-changed" }));
    assert.equal((await r.columns()).token, after.token);
    const revoked = await r.revoke(r.revokeRequest(after.token));
    assert.equal(revoked, JSON.stringify({ outcome: "revoked" }));
    const cleared = await r.columns();
    assert.equal(cleared.json, null);
    assert.equal(cleared.token, null);
    for (const key of ["version", "sourceToken", "updatedAt", "marker"]) {
      assert.equal(cleared[key], before[key], key);
    }
    // Nothing to revoke any more: nothing is written.
    const counts = await r.counts();
    const none = await r.revoke(r.revokeRequest(after.token));
    assert.equal(none, JSON.stringify({ outcome: "no-declaration" }));
    assert.deepEqual(await r.counts(), counts);

    // Declaring again gives a new declaration ID and token (ABA).
    const again = await r.declareRequest()();
    const second = await r.confirm(again);
    await r.declare(again, second.grantId);
    const redeclared = await r.columns();
    assert.notEqual(redeclared.token, after.token);
  } finally {
    await r.close();
  }
});

test("a grant is single use, and a failed write does not give it back (D2)", async () => {
  const r = await rig("single-use");
  try {
    const request = await r.declareRequest()();
    const { grantId } = await r.confirm(request);
    // The Scene changes between the confirmation and the write.
    const read = await r.scope();
    await r.backend.narrativeSceneScopeUpdate({
      expectedWorkspacePath: r.workspace,
      payload: {
        projectId: PROJECT,
        sceneId: SCENE,
        requestId: unique("a1-change"),
        sessionId: "fixture-session",
        eventUid: unique("a1-change-event"),
        baseVersion: read.binding.version,
        updatedAt: "2026-10-18T00:00:02.000Z",
        scope: {
          schemaVersion: 1,
          compatibilityMarker: "explicit",
          queryIdentity: {
            timeline: exact("tl"),
            worldline: exact("wl"),
            narrativeLayer: exact("ly"),
          },
          materialConstraint: { timeline: ANY, worldline: ANY, narrativeLayer: ANY },
          knowledgeHolder: { kind: "reader" },
          audience: { kind: "reader" },
        },
      },
    });
    await assert.rejects(r.declare(request, grantId), refusedWith("state-changed"));
    assert.equal((await r.columns()).json, null);
    // The grant was spent by the refused write.
    await assert.rejects(
      r.declare(await r.declareRequest()(), grantId),
      /^Error: MAIN_GRANT_CONSUMED$/,
    );
    // And a successful one cannot be replayed either.
    const next = await r.declareRequest()();
    const confirmed = await r.confirm(next);
    await r.declare(next, confirmed.grantId);
    await assert.rejects(
      r.declare(next, confirmed.grantId),
      /^Error: MAIN_GRANT_CONSUMED$/,
    );
    // No grant at all, a malformed one, and one that was never issued.
    await assert.rejects(r.declare(next, undefined), /^Error: MAIN_GRANT_REQUIRED$/);
    await assert.rejects(r.declare(next, "unknown-grant"), /^Error: MAIN_GRANT_NOT_FOUND$/);
  } finally {
    await r.close();
  }
});

test("a grant binds the sender and the window, and only one is held at a time (D3, D5)", async () => {
  const r = await rig("binding");
  try {
    const request = await r.declareRequest()();
    const preview = await r.preview(request);
    // A second preview while one is held: not waited for.
    await assert.rejects(r.preview(request, 8, 12), /^Error: MAIN_GRANT_BUSY$/);
    await assert.rejects(
      r.issue(preview.previewId, SENDER + 1, WINDOW),
      /^Error: MAIN_GRANT_MISMATCH$/,
    );
    await assert.rejects(
      r.issue(preview.previewId, SENDER, WINDOW + 1),
      /^Error: MAIN_GRANT_MISMATCH$/,
    );
    const grantId = await r.issue(preview.previewId);
    // The same preview cannot be issued twice.
    await assert.rejects(r.issue(preview.previewId), /^Error: MAIN_GRANT_STATE$/);
    for (const [sender, window] of [
      [SENDER + 1, WINDOW],
      [SENDER, WINDOW + 1],
    ]) {
      await assert.rejects(
        r.declare(request, grantId, sender, window),
        /^Error: MAIN_GRANT_MISMATCH$/,
      );
    }
    // A mismatched caller did not spend it.
    assert.equal(await r.declare(request, grantId), '{"outcome":"declared"}');
  } finally {
    await r.close();
  }
});

test("revoke by id and by sender frees the slot; an unknown id is not an error", async () => {
  const r = await rig("revoke");
  try {
    const request = await r.declareRequest()();
    r.backend.mainGrantRevoke("unknown");
    r.backend.mainGrantRevokeSender(99);
    const first = await r.preview(request);
    r.backend.mainGrantRevokeSender(SENDER + 1);
    await assert.rejects(r.preview(request), /^Error: MAIN_GRANT_BUSY$/);
    r.backend.mainGrantRevoke(first.previewId);
    await assert.rejects(r.issue(first.previewId), /^Error: MAIN_GRANT_REVOKED$/);

    const second = await r.confirm(request);
    r.backend.mainGrantRevokeSender(SENDER);
    await assert.rejects(
      r.declare(request, second.grantId),
      /^Error: MAIN_GRANT_REVOKED$/,
    );
    // Revoking by the grant ID works too.
    const third = await r.confirm(request);
    r.backend.mainGrantRevoke(third.grantId);
    await assert.rejects(
      r.declare(request, third.grantId),
      /^Error: MAIN_GRANT_REVOKED$/,
    );
    assert.equal((await r.columns()).json, null);
  } finally {
    await r.close();
  }
});

test("issue reads the Scene again: a change since the preview revokes the grant (D4)", async () => {
  const r = await rig("reread");
  try {
    const request = await r.declareRequest()();
    const preview = await r.preview(request);
    // The body changes after the preview.
    await r.patchScene({ content: tiptapDoc("Another sentence.") });
    await assert.rejects(
      r.issue(preview.previewId),
      /^Error: MAIN_GRANT_STATE_CHANGED$/,
    );
    await assert.rejects(
      r.issue(preview.previewId),
      /^Error: MAIN_GRANT_REVOKED$/,
    );
    // The slot is free again, and a new confirmation of the new body works.
    const fresh = await r.confirm(request);
    assert.equal(await r.declare(request, fresh.grantId), '{"outcome":"declared"}');

    // A body change after the grant was issued is refused by the writer, and
    // the grant is spent.
    const [{ token }] = await r.rows(
      "SELECT body_declaration_token AS token FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
      [PROJECT, SCENE],
    );
    await r.revoke(r.revokeRequest(token));
    const again = await r.declareRequest()();
    const held = await r.confirm(again);
    await r.patchScene({ content: tiptapDoc("A third sentence.") });
    await assert.rejects(r.declare(again, held.grantId), refusedWith("state-changed"));
    assert.equal((await r.columns()).json, null);
  } finally {
    await r.close();
  }
});

test("a lifecycle transition revokes a pending grant (D6)", async () => {
  const r = await rig("lifecycle");
  try {
    const request = await r.declareRequest()();
    const preview = await r.preview(request);
    await r.backend.openWorkspace(r.workspace);
    await assert.rejects(
      r.issue(preview.previewId),
      /^Error: MAIN_GRANT_REVOKED$/,
    );
    const held = await r.confirm(await r.declareRequest()());
    await r.backend.openWorkspace(r.workspace);
    await assert.rejects(
      r.declare(await r.declareRequest()(), held.grantId),
      /^Error: MAIN_GRANT_REVOKED$/,
    );
    assert.equal((await r.columns()).json, null);
    // After the transition a new confirmation works again.
    const next = await r.declareRequest()();
    const fresh = await r.confirm(next);
    assert.equal(await r.declare(next, fresh.grantId), '{"outcome":"declared"}');
  } finally {
    await r.close();
  }
});

test("a request cannot carry a grant, a declaration ID, a time or a digest (F2, F10)", async () => {
  const r = await rig("closed-payload");
  try {
    const base = await r.declareRequest()();
    for (const [key, value] of [
      ["grant", { grantId: "g", senderId: 1, windowId: 2 }],
      ["senderId", 1],
      ["windowId", 2],
      ["previewId", "p"],
      ["declarationId", "d"],
      ["declaredAt", "2026-10-18T00:00:00Z"],
      ["digest", "sha256:x"],
    ]) {
      const top = { ...base, [key]: value };
      const inner = { ...base, payload: { ...base.payload, [key]: value } };
      for (const payload of [top, inner]) {
        await assert.rejects(r.declare(payload, "g"), /unknown field/, key);
        await assert.rejects(r.preview(payload), /not a body declaration request|unknown field/, key);
      }
    }
    // The A1 save does not take a declaration either.
    const read = await r.scope();
    await assert.rejects(
      r.backend.narrativeSceneScopeUpdate({
        expectedWorkspacePath: r.workspace,
        payload: {
          projectId: PROJECT,
          sceneId: SCENE,
          requestId: unique("a1-declaration"),
          sessionId: "fixture-session",
          eventUid: unique("a1-declaration-event"),
          baseVersion: read.binding.version,
          updatedAt: "2026-10-18T00:00:03.000Z",
          scope: { ...read.binding, values: VALUES },
          bodyDeclaration: VALUES,
        },
      }),
      /unknown field|invalid/,
    );
    assert.equal((await r.columns()).json, null);
    // A value outside the G-01 subset, and a missing axis, do not parse.
    for (const values of [
      { ...VALUES, reveal: "secret" },
      { ...VALUES, story: "dependent" },
      { story: "independent" },
    ]) {
      await assert.rejects(
        r.declare({ ...base, payload: { ...base.payload, values } }, "g"),
        /invalid payload/,
      );
    }
  } finally {
    await r.close();
  }
});

test("a declaration survives a restart, and the gate is closed again after it (E2, E1)", async () => {
  const r = await rig("restart");
  try {
    const request = await r.declareRequest()();
    const { grantId } = await r.confirm(request);
    await r.declare(request, grantId);
    const declared = await r.columns();
    assert.notEqual(declared.json, null);
    // The first process ends (its shutdown is proven), and a new process
    // opens the same app data and workspace.
    const wire = await r.backend.shutdownWorkspaceLifecycle();
    assert.equal(JSON.parse(wire).status, "closed");
    const request2 = JSON.stringify(request);
    const revoke2 = JSON.stringify(r.revokeRequest(declared.token));
    const script = `
      import { createRequire } from "node:module";
      const { Backend } = createRequire(import.meta.url)(${JSON.stringify(
        join(here, "..", "grimodex-node.node"),
      )});
      const backend = new Backend(${JSON.stringify(r.appData)});
      await backend.openWorkspace(${JSON.stringify(r.workspace)});
      const rows = JSON.parse(
        await backend.dbExecute(
          "SELECT body_declaration_json AS json, body_declaration_token AS token, version, source_token AS sourceToken, updated_at AS updatedAt, compatibility_marker AS marker FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
          [${JSON.stringify(PROJECT)}, ${JSON.stringify(SCENE)}],
          "all",
        ),
      ).rows;
      const outcome = async (run) => {
        try {
          return { ok: await run() };
        } catch (error) {
          return { error: error.message };
        }
      };
      const result = {
        rows,
        preview: await outcome(() =>
          backend.mainGrantPreview("body-declaration", ${JSON.stringify(request2)}, 1, 2),
        ),
        declare: await outcome(() =>
          backend.narrativeSceneBodyDeclarationDeclare(
            JSON.parse(${JSON.stringify(request2)}),
            undefined,
            JSON.stringify({ grantId: "g", senderId: 1, windowId: 2 }),
          ),
        ),
        revoke: await outcome(() =>
          backend.narrativeSceneBodyDeclarationRevoke(JSON.parse(${JSON.stringify(revoke2)}), undefined),
        ),
        issue: await outcome(() => backend.mainGrantIssue("any-preview", 1, 2)),
      };
      console.log("RESULT " + JSON.stringify(result));
      process.exit(0);
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 60000 },
    );
    const line = output.split("\n").find((text) => text.startsWith("RESULT "));
    assert.ok(line, output);
    const result = JSON.parse(line.slice("RESULT ".length));
    // The declaration survived, byte for byte.
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], declared);
    // The new process starts with every gate closed and no grant.
    assert.deepEqual(result.preview, { error: GATE_CLOSED });
    assert.deepEqual(result.declare, { error: GATE_CLOSED });
    assert.deepEqual(result.revoke, { error: GATE_CLOSED });
    assert.deepEqual(result.issue, { error: "MAIN_GRANT_NOT_FOUND" });
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("responses and errors name no id, title, body or digest (E7)", async () => {
  const r = await rig("leaks");
  try {
    const request = await r.declareRequest()();
    const { preview, grantId } = await r.confirm(request);
    const declared = await r.declare(request, grantId);
    const declaration = (await r.columns()).json;
    const secrets = [
      SCENE,
      TITLE,
      "Mira opened",
      preview.previewId,
      grantId,
      request.payload.requestId,
      JSON.parse(declaration).declarationId,
    ];
    const revoked = await r.revoke(r.revokeRequest((await r.columns()).token));
    const messages = [declared, revoked];
    for (const attempt of [
      () => r.declare(request, grantId),
      () => r.declare(request, "unknown-grant"),
      () => r.issue("unknown-preview"),
      () => r.revoke(r.revokeRequest("t")),
    ]) {
      try {
        const value = await attempt();
        messages.push(String(value));
      } catch (error) {
        messages.push(String(error.message));
      }
    }
    for (const message of messages) {
      for (const secret of secrets) {
        assert.ok(!message.includes(secret), `${message} contains ${secret}`);
      }
      assert.ok(!message.includes("sha256:"), message);
    }
  } finally {
    await r.close();
  }
});

// D10: the entries admit by the profile's mode. A restricted profile needs the
// registered caller of the active workspace; an unrestricted one needs none.
async function restrictedRig(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-body-declaration-${label}-`));
  // DA-2 (D-7): a restricted state file, not an activation (K3/2 "公開" (b)).
  placeRestrictedProfile(join(root, "app-data"));
  const backend = new Backend(join(root, "app-data"));
  const status = JSON.parse(await backend.initializeProfileEgress());
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const identity = (overrides = {}) => ({
    profileId: status.profileId,
    callerId: "main-caller",
    callerEpoch: status.callerEpoch,
    senderId: 42,
    workspaceId: workspace,
    sessionId: "main-session",
    ...overrides,
  });
  backend.mainOpenPrePublicationGate("scene-body-declaration");
  return {
    backend,
    workspace,
    identity,
    async register() {
      const wire = JSON.stringify(identity());
      await backend.registerProfileEgressCaller(wire);
      return wire;
    },
    async close() {
      const wire = await backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a restricted profile admits only the registered caller of the active workspace (D10)", async () => {
  const rr = await restrictedRig("restricted");
  try {
    const declarePayload = {
      expectedWorkspacePath: rr.workspace,
      payload: {
        projectId: PROJECT,
        sceneId: SCENE,
        requestId: "r1",
        expected: { scopeVersion: 1, scopeToken: "t", declarationToken: null },
        values: VALUES,
      },
    };
    const revokePayload = {
      expectedWorkspacePath: rr.workspace,
      payload: {
        projectId: PROJECT,
        sceneId: SCENE,
        requestId: "r2",
        declarationToken: "t",
      },
    };
    const sidecar = JSON.stringify({ grantId: "g", senderId: 1, windowId: 2 });
    const denied = /D2A_EGRESS_DENIED/;
    // No identity, an unregistered one, and one for another workspace.
    const wire = JSON.stringify(rr.identity());
    const other = JSON.stringify(rr.identity({ workspaceId: "/elsewhere" }));
    for (const identity of [undefined, wire, other]) {
      await assert.rejects(
        rr.backend.narrativeSceneBodyDeclarationDeclare(declarePayload, identity, sidecar),
        denied,
      );
      await assert.rejects(
        rr.backend.narrativeSceneBodyDeclarationRevoke(revokePayload, identity),
        denied,
      );
      await assert.rejects(
        rr.backend.mainGrantPreview(
          "body-declaration",
          JSON.stringify(declarePayload),
          1,
          2,
          identity,
        ),
        denied,
      );
    }
    const registered = await rr.register();
    // The registered caller passes admission (and then meets the Scene,
    // which this workspace does not have).
    await assert.rejects(
      rr.backend.narrativeSceneBodyDeclarationDeclare(declarePayload, registered, sidecar),
      (error) => {
        assert.doesNotMatch(error.message, denied);
        return true;
      },
    );
    await assert.rejects(
      rr.backend.narrativeSceneBodyDeclarationDeclare(declarePayload, other, sidecar),
      denied,
    );
    const revoked = await rr.backend
      .narrativeSceneBodyDeclarationRevoke(revokePayload, registered)
      .then(
        (value) => value,
        (error) => error.message,
      );
    assert.doesNotMatch(String(revoked), denied);
  } finally {
    await rr.close();
  }
});

test("an unrestricted profile needs no caller, only the workspace (D10)", async () => {
  const r = await rig("unrestricted");
  try {
    const request = await r.declareRequest()();
    // No identity anywhere: the call goes through.
    const { grantId } = await r.confirm(request);
    assert.equal(await r.declare(request, grantId), '{"outcome":"declared"}');
    // The workspace the request names must be the active one.
    const stray = await r.declareRequest()();
    stray.expectedWorkspacePath = join(r.root, "another-workspace");
    const preview = r.backend.mainGrantPreview(
      "body-declaration",
      JSON.stringify(stray),
      SENDER,
      WINDOW,
    );
    await assert.rejects(preview);
    const [{ token }] = await r.rows(
      "SELECT body_declaration_token AS token FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
      [PROJECT, SCENE],
    );
    assert.notEqual(token, null);
    const strayRevoke = r.revokeRequest(token);
    strayRevoke.expectedWorkspacePath = join(r.root, "another-workspace");
    await assert.rejects(r.revoke(strayRevoke));
    assert.notEqual((await r.columns()).token, null);
  } finally {
    await r.close();
  }
});

// CB-3: the read-only state of the Scene's declaration (DR-CB3-1).
const STATE_KEYS = ["declarationToken", "occ", "state"];

test("the state read is closed with the gate and Main-only to open (G-2)", async () => {
  const r = await rig("state-closed", { openGate: false });
  try {
    const request = r.stateRequest();
    const before = await r.counts();
    const columnsBefore = await r.columns();
    // Closed: it refuses before the payload or the workspace is looked at.
    await assert.rejects(r.state(request), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    await assert.rejects(r.state({ bad: 1 }), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    // A renderer cannot open it: there is no such call on the commands it
    // reaches, and an unknown kind leaves it closed.
    for (const kind of ["", "all", "local-send", "Scene-Body-Declaration"]) {
      assert.throws(
        () => r.backend.mainOpenPrePublicationGate(kind),
        /^Error: MAIN_GATE_KIND$/,
      );
    }
    await assert.rejects(r.state(request), (error) => {
      assert.equal(error.message, GATE_CLOSED);
      return true;
    });
    assert.deepEqual(await r.counts(), before);
    assert.deepEqual(await r.columns(), columnsBefore);
    // Main opens it for this process.
    r.backend.mainOpenPrePublicationGate("scene-body-declaration");
    const answer = JSON.parse(await r.state(request));
    assert.deepEqual(Object.keys(answer).sort(), STATE_KEYS);
    assert.deepEqual(answer.state, { kind: "none", blocker: null });
  } finally {
    await r.close();
  }
});

test("the state follows a declaration through a body change, a revoke and a re-declaration (N-13)", async () => {
  const r = await rig("state-flow");
  try {
    const columnsBefore = await r.columns();
    const none = JSON.parse(await r.state(r.stateRequest()));
    assert.deepEqual(Object.keys(none).sort(), STATE_KEYS);
    assert.deepEqual(none.state, { kind: "none", blocker: null });
    assert.equal(none.declarationToken, null);
    const read = await r.scope();
    assert.deepEqual(none.occ, {
      scopeVersion: read.binding.version,
      scopeToken: read.binding.sourceToken,
    });
    // A read writes nothing.
    assert.deepEqual(await r.columns(), columnsBefore);

    const request = await r.declareRequest()();
    const { grantId } = await r.confirm(request);
    await r.declare(request, grantId);
    const declaredWire = await r.state(r.stateRequest());
    const declared = JSON.parse(declaredWire);
    assert.deepEqual(declared.state, {
      kind: "declared",
      effective: true,
      expiredBy: [],
      blocker: null,
    });
    const stored = await r.columns();
    assert.equal(declared.declarationToken, stored.token);
    // The answer names no body, title, digest, Scene or declaration ID, and
    // no time.
    const declaration = JSON.parse(stored.json);
    for (const secret of [
      TITLE,
      "Mira opened",
      SCENE,
      PROJECT,
      request.payload.requestId,
      declaration.declarationId,
      declaration.declaredAt,
      grantId,
    ]) {
      assert.ok(secret, "the secret is a non-empty string");
      assert.ok(!declaredWire.includes(secret), `${declaredWire} has ${secret}`);
    }
    // The OCC tokens are the only digests-looking values: nothing else is.
    const withoutTokens = declaredWire
      .replace(declared.occ.scopeToken, "")
      .replace(declared.declarationToken, "");
    assert.ok(!withoutTokens.includes("sha256:"), withoutTokens);

    // The body changes: still declared, no longer effective, with its group.
    await r.patchScene({ content: tiptapDoc("Another sentence.") });
    const expired = JSON.parse(await r.state(r.stateRequest()));
    assert.deepEqual(expired.state, {
      kind: "declared",
      effective: false,
      expiredBy: ["content"],
      blocker: null,
    });
    assert.equal(expired.declarationToken, stored.token);

    // The token the state returned is the one a revoke takes.
    const revoked = await r.revoke(r.revokeRequest(expired.declarationToken));
    assert.equal(revoked, JSON.stringify({ outcome: "revoked" }));
    const after = JSON.parse(await r.state(r.stateRequest()));
    assert.deepEqual(after.state, { kind: "none", blocker: null });
    assert.equal(after.declarationToken, null);

    // And the OCC it returned is the one a declare takes.
    const again = r.declareRequest();
    const second = await again();
    second.payload.expected = {
      scopeVersion: after.occ.scopeVersion,
      scopeToken: after.occ.scopeToken,
      declarationToken: after.declarationToken,
    };
    const held = await r.confirm(second);
    assert.equal(await r.declare(second, held.grantId), '{"outcome":"declared"}');
    const last = JSON.parse(await r.state(r.stateRequest()));
    assert.equal(last.state.effective, true);
  } finally {
    await r.close();
  }
});

test("the state payload is closed and a wrong workspace is one closed code (N-11)", async () => {
  const r = await rig("state-payload");
  try {
    for (const [key, value] of [
      ["grant", { grantId: "g" }],
      ["requestId", "r"],
      ["declarationToken", "t"],
      ["declarationId", "d"],
      ["digest", "sha256:x"],
    ]) {
      const top = r.stateRequest();
      top[key] = value;
      await assert.rejects(r.state(top), /unknown field/);
      const inner = r.stateRequest();
      inner.payload[key] = value;
      await assert.rejects(r.state(inner), /unknown field/);
    }
    for (const path of [join(r.root, "another-workspace"), join(r.root, "missing"), ""]) {
      const stray = r.stateRequest();
      stray.expectedWorkspacePath = path;
      await assert.rejects(r.state(stray), (error) => {
        assert.equal(
          error.message,
          "NEX_BODY_DECLARATION_REFUSED:workspace-mismatch",
        );
        return true;
      });
    }
  } finally {
    await r.close();
  }
});

test("a restricted profile admits the state read only for the registered caller (N-10)", async () => {
  const rr = await restrictedRig("state-restricted");
  try {
    const payload = {
      expectedWorkspacePath: rr.workspace,
      payload: { projectId: PROJECT, sceneId: SCENE },
    };
    const denied = /D2A_EGRESS_DENIED/;
    const wire = JSON.stringify(rr.identity());
    const other = JSON.stringify(rr.identity({ workspaceId: "/elsewhere" }));
    for (const identity of [undefined, wire, other]) {
      await assert.rejects(
        rr.backend.narrativeSceneBodyDeclarationState(payload, identity),
        denied,
      );
    }
    const registered = await rr.register();
    // Admitted: the Scene this workspace does not have is a closed answer,
    // not a denial.
    const answer = JSON.parse(
      await rr.backend.narrativeSceneBodyDeclarationState(payload, registered),
    );
    assert.equal(answer.state.blocker, "scene-not-found");
    await assert.rejects(
      rr.backend.narrativeSceneBodyDeclarationState(payload, other),
      denied,
    );
  } finally {
    await rr.close();
  }
});
