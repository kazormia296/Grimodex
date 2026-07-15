import { useCallback, useEffect, useMemo, useState } from "react";
import { parseEditorSeed, type EditorSeedV1 } from "@grimodex/scan-contract";
import {
  createIndexedDbWorkspaceStore,
  createMemoryWorkspaceStore,
  type BrowserWorkspaceStore,
} from "../../../../src/lib/browser-db/indexedDbStore";
import { createBrowserWorkspaceLifecycle } from "../../../../src/lib/browser-db/workspaceLifecycle";

const fallbackStore = createMemoryWorkspaceStore();

function createStore(): BrowserWorkspaceStore {
  try {
    return createIndexedDbWorkspaceStore();
  } catch {
    return fallbackStore;
  }
}

function decodeSeed(bytes: Uint8Array): EditorSeedV1 {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    seed?: unknown;
  };
  const result = parseEditorSeed(parsed.seed);
  if (!result.ok) throw new Error("workspace snapshot seed is invalid");
  return result.value;
}

export function BrowserWorkspaceLauncher({
  onOpenSeed,
}: {
  onOpenSeed: (seed: EditorSeedV1, workspaceId: string) => void;
}) {
  const lifecycle = useMemo(
    () => createBrowserWorkspaceLifecycle(createStore()),
    [],
  );
  const [workspaces, setWorkspaces] = useState<
    Awaited<ReturnType<typeof lifecycle.list>>
  >([]);
  const [message, setMessage] = useState<string>();

  const refresh = useCallback(async () => {
    setWorkspaces(await lifecycle.list());
  }, [lifecycle]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (workspaces.length === 0) return null;
  return (
    <section
      className="scan-workspace-launcher"
      aria-label="Saved browser workspaces"
    >
      <div className="scan-workspace-launcher__header">
        <strong>保存済みワークスペース</strong>
        {message && <span className="scan-muted">{message}</span>}
      </div>
      <ul>
        {workspaces.map((workspace) => (
          <li key={workspace.workspaceId}>
            <button
              type="button"
              onClick={() => {
                void lifecycle
                  .open(workspace.workspaceId, decodeSeed)
                  .then((result) => {
                    if (result.status === "opened") {
                      onOpenSeed(result.value, result.workspaceId);
                      setMessage(undefined);
                    } else {
                      setMessage(
                        result.status === "corrupt"
                          ? "破損したスナップショットです"
                          : "ワークスペースが見つかりません",
                      );
                    }
                  });
              }}
            >
              {workspace.workspaceId}
            </button>
            <small>{new Date(workspace.updatedAt).toLocaleString()}</small>
            <button
              type="button"
              aria-label={`${workspace.workspaceId} rename`}
              onClick={() => {
                const next = window.prompt(
                  "新しいワークスペース名",
                  workspace.workspaceId,
                );
                if (!next) return;
                void lifecycle
                  .rename(workspace.workspaceId, next)
                  .then(refresh)
                  .catch(() => setMessage("名前を変更できませんでした"));
              }}
            >
              名前変更
            </button>
            <button
              type="button"
              aria-label={`${workspace.workspaceId} delete`}
              onClick={() => {
                if (!window.confirm("このワークスペースを削除しますか？"))
                  return;
                void lifecycle
                  .remove(workspace.workspaceId)
                  .then(refresh)
                  .catch(() => setMessage("削除できませんでした"));
              }}
            >
              削除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
