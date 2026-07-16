import { useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { parseEditorSeed, type EditorSeedV1 } from "@grimodex/scan-contract";
import { BrowserWorkspaceError } from "../../../../src/lib/browser-db/indexedDbStore";
import { createPersistenceController } from "../../../../src/lib/browser-db/persistenceController";
import {
  buildScanImportPlan,
  rebuildScanImportPlan,
  type ScanImportPlan,
} from "../../../../src/features/import/scan/scanImportPlan";
import {
  createBrowserScanWorkspace,
  type BrowserScanWorkspace,
} from "./browserWorkspace";
import {
  createBrowserWorkspaceStore,
  saveWorkspaceCopy,
} from "./browserWorkspaceStore";

interface BrowserScanWorkspaceSnapshot {
  schemaVersion: "grimodex-browser-scan-workspace/2";
  sourceFingerprint: string;
  seed: EditorSeedV1;
  importPlan: ScanImportPlan;
  databaseBase64: string;
  sceneEditors: Record<string, JSONContent>;
  activeSceneId: string | null;
}

function initialEditorJson(seed: EditorSeedV1): JSONContent {
  return {
    type: "doc",
    content: seed.source.paragraphs.map((paragraph) => ({
      type: "paragraph",
      content: paragraph.text
        ? [{ type: "text", text: paragraph.text }]
        : undefined,
    })),
  };
}

function isEditorJson(value: unknown): value is JSONContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "doc" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeWorkspace(
  bytes: Uint8Array,
  seed: EditorSeedV1,
): {
  plan: ScanImportPlan;
  databaseBytes: Uint8Array;
  sceneEditors: Record<string, JSONContent>;
  activeSceneId: string | null;
} | null {
  try {
    const value = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as Partial<BrowserScanWorkspaceSnapshot>;
    const parsedSeed = parseEditorSeed(value.seed);
    if (
      !parsedSeed.ok ||
      parsedSeed.value.source.fingerprint !== seed.source.fingerprint ||
      value.sourceFingerprint !== seed.source.fingerprint ||
      value.schemaVersion !== "grimodex-browser-scan-workspace/2" ||
      typeof value.databaseBase64 !== "string" ||
      typeof value.sceneEditors !== "object" ||
      value.sceneEditors === null
    ) {
      return null;
    }
    const plan = rebuildScanImportPlan(parsedSeed.value, value.importPlan);
    const sceneEditors = Object.fromEntries(
      Object.entries(value.sceneEditors).filter(([, editorJson]) =>
        isEditorJson(editorJson),
      ),
    ) as Record<string, JSONContent>;
    return {
      plan,
      databaseBytes: decodeBytes(value.databaseBase64),
      sceneEditors,
      activeSceneId:
        typeof value.activeSceneId === "string" ? value.activeSceneId : null,
    };
  } catch {
    return null;
  }
}

type EditorPane = "editor" | "codex" | "relations" | "phases" | "timeline";

export function BrowserScanEditor({
  seed,
  workspaceId,
  onBack,
}: {
  seed: EditorSeedV1;
  workspaceId?: string;
  onBack: () => void;
}) {
  const initialPlan = useMemo(() => buildScanImportPlan(seed), [seed]);
  const [plan, setPlan] = useState(initialPlan);
  const [pane, setPane] = useState<EditorPane>("editor");
  const [workspace, setWorkspace] = useState<BrowserScanWorkspace | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [persistenceState, setPersistenceState] = useState<
    "restoring" | "ready" | "conflict" | "error"
  >("restoring");
  const [characterCount, setCharacterCount] = useState(0);
  const [conflictSaveBusy, setConflictSaveBusy] = useState(false);
  const [conflictSaveError, setConflictSaveError] = useState<string>();
  const [volatileStorage, setVolatileStorage] = useState(false);
  const readyRef = useRef(false);
  const workspaceRef = useRef<BrowserScanWorkspace | null>(null);
  const planRef = useRef(initialPlan);
  const activeSceneRef = useRef<string | null>(null);
  const editorJsonRef = useRef<JSONContent>(initialEditorJson(seed));
  const editorDocumentsRef = useRef<Record<string, JSONContent>>({});
  const persistenceRef = useRef<ReturnType<
    typeof createPersistenceController
  > | null>(null);

  const store = useMemo(() => createBrowserWorkspaceStore(), []);
  const persistence = useMemo(() => {
    return createPersistenceController({
      store,
      workspaceId: workspaceId ?? `scan:${seed.source.fingerprint}`,
      schemaVersion: 2,
      exportDatabase: async () => {
        const currentWorkspace = workspaceRef.current;
        if (!currentWorkspace)
          throw new Error("browser workspace is not ready");
        const snapshot: BrowserScanWorkspaceSnapshot = {
          schemaVersion: "grimodex-browser-scan-workspace/2",
          sourceFingerprint: seed.source.fingerprint,
          seed,
          importPlan: planRef.current,
          databaseBase64: encodeBytes(currentWorkspace.exportDatabase()),
          sceneEditors: editorDocumentsRef.current,
          activeSceneId: activeSceneRef.current,
        };
        return new TextEncoder().encode(JSON.stringify(snapshot));
      },
      onError: (cause) =>
        setPersistenceState(
          cause instanceof BrowserWorkspaceError && cause.code === "stale-write"
            ? "conflict"
            : "error",
        ),
    });
  }, [seed, store, workspaceId]);
  persistenceRef.current = persistence;

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialEditorJson(seed),
    immediatelyRender: false,
    onUpdate: ({ editor: nextEditor }) => {
      const sceneId = activeSceneRef.current;
      const nextJson = nextEditor.getJSON();
      editorJsonRef.current = nextJson;
      setCharacterCount(Array.from(nextEditor.getText()).length);
      if (sceneId) {
        editorDocumentsRef.current[sceneId] = nextJson;
        workspaceRef.current?.updateSceneContent(sceneId, nextJson);
      }
      if (readyRef.current) persistenceRef.current?.markDirty();
    },
  });

  useEffect(() => {
    activeSceneRef.current = activeSceneId;
  }, [activeSceneId]);

  useEffect(() => {
    if (!editor || !workspace || !activeSceneId) return;
    const scene = workspace.scenes.find((item) => item.id === activeSceneId);
    if (!scene) return;
    const nextJson = editorDocumentsRef.current[scene.id] ?? scene.content;
    editor.commands.setContent(nextJson, { emitUpdate: false });
    editorJsonRef.current = nextJson;
    setCharacterCount(Array.from(editor.getText()).length);
  }, [activeSceneId, editor, workspace]);

  useEffect(() => {
    editor?.setEditable(persistenceState === "ready" && activeSceneId !== null);
  }, [activeSceneId, editor, persistenceState]);

  useEffect(() => {
    if (
      !volatileStorage &&
      !(
        workspace &&
        (persistenceState === "error" || persistenceState === "conflict")
      )
    )
      return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [persistenceState, volatileStorage, workspace]);

  useEffect(() => {
    let cancelled = false;
    let ownedWorkspace: BrowserScanWorkspace | undefined;
    const detach = persistence.attachLifecycle();
    void (async () => {
      const storedSnapshot = await persistence.restore();
      setVolatileStorage(store.getDurability() === "memory");
      let nextWorkspace: BrowserScanWorkspace;
      let nextPlan = initialPlan;
      let nextDocuments: Record<string, JSONContent>;
      let nextSceneId: string | null;
      let restoredSnapshot = false;
      const decoded = storedSnapshot
        ? decodeWorkspace(storedSnapshot.bytes, seed)
        : null;
      if (storedSnapshot) {
        if (!decoded) throw new Error("stored browser workspace is invalid");
        nextPlan = decoded.plan;
        nextWorkspace = await createBrowserScanWorkspace(
          decoded.plan,
          decoded.databaseBytes,
        );
        nextDocuments = decoded.sceneEditors;
        nextSceneId = decoded.activeSceneId;
        restoredSnapshot = true;
      } else {
        nextWorkspace = await createBrowserScanWorkspace(initialPlan);
        nextDocuments = Object.fromEntries(
          nextWorkspace.scenes.map((scene) => [scene.id, scene.content]),
        );
        nextSceneId = nextWorkspace.scenes[0]?.id ?? null;
      }
      ownedWorkspace = nextWorkspace;
      if (cancelled) {
        nextWorkspace.db.close();
        ownedWorkspace = undefined;
        return;
      }
      const validSceneId = nextWorkspace.scenes.some(
        (scene) => scene.id === nextSceneId,
      )
        ? nextSceneId
        : (nextWorkspace.scenes[0]?.id ?? null);
      editorDocumentsRef.current = nextDocuments;
      planRef.current = nextPlan;
      workspaceRef.current = nextWorkspace;
      activeSceneRef.current = validSceneId;
      setWorkspace(nextWorkspace);
      setPlan(nextPlan);
      setActiveSceneId(validSceneId);
      readyRef.current = true;
      setPersistenceState("ready");
      if (!restoredSnapshot) persistence.markDirty();
    })().catch(() => {
      if (cancelled) return;
      readyRef.current = true;
      setPersistenceState("error");
    });
    return () => {
      cancelled = true;
      detach();
      const workspaceToClose = ownedWorkspace;
      ownedWorkspace = undefined;
      void persistence
        .flush()
        .catch(() => undefined)
        .finally(() => workspaceToClose?.db.close());
    };
  }, [initialPlan, persistence, seed, store]);

  if (!workspace) {
    if (persistenceState === "error") {
      return (
        <main
          className="scan-browser-workspace"
          data-testid="scan-editor-workspace-error"
        >
          <p className="scan-error">
            Browser workspace
            を復元できませんでした。保存領域を確認して再度開いてください。
          </p>
          <button type="button" className="scan-secondary" onClick={onBack}>
            レポートへ戻る
          </button>
        </main>
      );
    }
    return (
      <main
        className="scan-browser-workspace"
        data-testid="scan-editor-workspace"
      >
        <p className="scan-muted">Browser workspace を復元しています…</p>
      </main>
    );
  }

  const folders = plan.nodes.filter((node) => node.kind === "folder");
  const sceneByParent = new Map<string | null, typeof workspace.scenes>();
  for (const scene of workspace.scenes) {
    const group = sceneByParent.get(scene.parentId) ?? [];
    group.push(scene);
    sceneByParent.set(scene.parentId, group);
  }
  const selectScene = (sceneId: string) => {
    if (activeSceneRef.current && editor) {
      const currentJson = editor.getJSON();
      editorDocumentsRef.current[activeSceneRef.current] = currentJson;
      workspace.updateSceneContent(activeSceneRef.current, currentJson);
    }
    activeSceneRef.current = sceneId;
    setActiveSceneId(sceneId);
    if (readyRef.current) persistence.markDirty();
  };
  const activeScene = workspace.scenes.find(
    (scene) => scene.id === activeSceneId,
  );
  const saveConflictCopy = async () => {
    if (conflictSaveBusy) return;
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace) return;
    const currentId = workspaceId ?? `scan:${seed.source.fingerprint}`;
    const nextId = window.prompt(
      "競合中の編集を保存する新しいワークスペース名",
      `${currentId}-copy-${Date.now()}`,
    );
    if (!nextId?.trim()) return;
    setConflictSaveBusy(true);
    setConflictSaveError(undefined);
    try {
      const snapshot: BrowserScanWorkspaceSnapshot = {
        schemaVersion: "grimodex-browser-scan-workspace/2",
        sourceFingerprint: seed.source.fingerprint,
        seed,
        importPlan: plan,
        databaseBase64: encodeBytes(currentWorkspace.exportDatabase()),
        sceneEditors: editorDocumentsRef.current,
        activeSceneId: activeSceneRef.current,
      };
      await saveWorkspaceCopy(store, {
        workspaceId: nextId.trim(),
        schemaVersion: 2,
        updatedAt: new Date().toISOString(),
        bytes: new TextEncoder().encode(JSON.stringify(snapshot)),
      });
      onBack();
    } catch (cause) {
      setConflictSaveError(
        cause instanceof BrowserWorkspaceError && cause.code === "stale-write"
          ? "同じ名前のワークスペースが既にあります。"
          : "競合中の編集を保存できませんでした。",
      );
    } finally {
      setConflictSaveBusy(false);
    }
  };
  const persistenceRisk =
    volatileStorage ||
    (workspace !== null &&
      (persistenceState === "error" || persistenceState === "conflict"));
  const handleBack = () => {
    if (
      persistenceRisk &&
      !window.confirm(
        "保存されていない編集が失われる可能性があります。レポートへ戻りますか？",
      )
    )
      return;
    onBack();
  };

  return (
    <main
      className="scan-browser-workspace"
      data-testid="scan-editor-workspace"
    >
      <header className="scan-report__header">
        <div>
          <p className="scan-eyebrow">Grimodex Scan · Browser workspace</p>
          <h1>{seed.source.title}</h1>
          <p className="scan-muted">
            SQL.js workspace · ImportPlan {plan.schemaVersion} ·{" "}
            {characterCount.toLocaleString()}文字 · 保存状態: {persistenceState}
          </p>
          {volatileStorage && (
            <p className="scan-error" role="alert">
              永続ストレージを利用できないため、このタブを閉じると編集内容が失われます。
            </p>
          )}
          {persistenceState === "error" && (
            <p className="scan-error" role="alert">
              自動保存に失敗したため編集を停止しました。タブを閉じず、内容を退避してください。
            </p>
          )}
          {!activeSceneId && (
            <p className="scan-error" role="alert">
              編集可能なシーンがないため、本文編集は無効です。
            </p>
          )}
        </div>
        <button type="button" className="scan-secondary" onClick={handleBack}>
          レポートへ戻る
        </button>
      </header>

      <nav className="scan-workspace-tabs" aria-label="Browser workspace panes">
        {(
          [
            ["editor", "本文"],
            ["codex", `Codex (${workspace.codexEntries.length})`],
            ["relations", `Relations (${workspace.relations.length})`],
            ["phases", `Phases (${workspace.phases.length})`],
            ["timeline", `Timeline (${workspace.events.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={pane === id ? "is-active" : undefined}
            aria-current={pane === id ? "page" : undefined}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {persistenceState === "conflict" && (
        <section className="scan-card" role="alert">
          <strong>別のタブで新しい保存内容が作成されました。</strong>
          <p className="scan-muted">
            上書きを防ぐため、このタブでの編集を停止しました。最新の保存内容を読み直してください。
          </p>
          <button
            type="button"
            className="scan-secondary"
            onClick={() => window.location.reload()}
          >
            最新の保存内容を読み直す
          </button>
          <button
            type="button"
            className="scan-secondary"
            disabled={conflictSaveBusy}
            onClick={() => void saveConflictCopy()}
          >
            {conflictSaveBusy ? "コピーを保存中…" : "この編集を別名で保存"}
          </button>
          {conflictSaveError && (
            <p className="scan-error">{conflictSaveError}</p>
          )}
        </section>
      )}

      <div className="scan-browser-workspace__grid">
        <aside className="scan-card scan-browser-workspace__outline">
          <h2>Scenes</h2>
          <ol>
            {folders.map((folder) => (
              <li key={folder.id}>
                <strong>{folder.title}</strong>
                <ul>
                  {(sceneByParent.get(folder.id) ?? []).map((scene) => (
                    <li key={scene.id}>
                      <button
                        type="button"
                        className={
                          scene.id === activeSceneId ? "is-active" : undefined
                        }
                        onClick={() => selectScene(scene.id)}
                      >
                        {scene.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {plan.warnings.length > 0 && (
            <p className="scan-muted">
              {plan.warnings.length}件の import warning
            </p>
          )}
        </aside>

        {pane === "editor" && (
          <section className="scan-card scan-browser-workspace__editor">
            <h2>{activeScene?.title ?? "本文エディタ"}</h2>
            <EditorContent editor={editor} />
          </section>
        )}

        {pane === "codex" && (
          <section className="scan-card scan-browser-workspace__editor">
            <h2>Codex</h2>
            <div className="scan-browser-workspace__records">
              {workspace.codexEntries.map((entry) => (
                <article key={entry.id}>
                  <strong>{entry.name}</strong>
                  <span>{entry.type}</span>
                  {entry.summary && <p>{entry.summary}</p>}
                </article>
              ))}
            </div>
          </section>
        )}

        {pane === "relations" && (
          <section className="scan-card scan-browser-workspace__editor">
            <h2>Relations</h2>
            <ul className="scan-browser-workspace__records">
              {workspace.relations.map((relation) => (
                <li key={relation.id}>
                  {relation.fromCodexId} → {relation.toCodexId} ·{" "}
                  {relation.type}
                </li>
              ))}
            </ul>
          </section>
        )}

        {pane === "phases" && (
          <section className="scan-card scan-browser-workspace__editor">
            <h2>Phases</h2>
            <ul className="scan-browser-workspace__records">
              {workspace.phases.map((phase) => (
                <li key={phase.id}>
                  <strong>{phase.title}</strong>
                  <p>
                    {phase.entityIds.length} entity · {phase.anchors.length}{" "}
                    evidence
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {pane === "timeline" && (
          <section className="scan-card scan-browser-workspace__editor">
            <h2>Timeline</h2>
            <ol className="scan-browser-workspace__records">
              {workspace.events.map((event) => (
                <li key={event.id}>
                  <strong>{event.title}</strong>
                  {event.summary && <p>{event.summary}</p>}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}
