import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { CodexContentEditor } from "@/features/codex/components/CodexContentEditor";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { EventRow } from "./api";
import {
  createEditorInstanceId,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import type { LoadedEditorBinding } from "@/features/editor/document/types";
import {
  announcePersistedBinding,
  registerPersistedBindingHandler,
  unregisterPersistedBindingHandler,
} from "@/features/editor/editorSaveRegistry";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import { ExternalEditConflictBanner } from "@/features/editor/ExternalEditConflictBanner";
import { getEventVersion } from "./version";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getEvent } from "./api";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { toast } from "sonner";

interface ChronicleDetailFieldProps {
  event: EventRow;
  /** 詳細を patch 保存する（ChroniclePanel.handlePatch 経由の tracked-write）。 */
  onPatchDetail: (
    detail: string,
    baseVersion: number,
  ) => Promise<{ version: number }>;
  /** Seed the owning Event aggregate queue before paused peer drafts resume. */
  onResolveExternalVersion?: (version: number) => void;
}

/**
 * 出来事インスペクタの「詳細」欄。Codex 説明欄と同じ TipTap ミニエディタ
 * （Codex ハイライト・ProseMirror JSON 保存）を再利用する。右上「エディタで開く」
 * で本文用 EditorPane タブに展開できる。
 *
 * `content` prop は初期値のみで、以後の反映は CodexContentEditor 内の live-sync
 * （sceneContentStore）が担う。親は `key={event.id}` で出来事切替時に remount し、
 * 初期 content を更新すること。
 */
export function ChronicleDetailField({
  event,
  onPatchDetail,
  onResolveExternalVersion,
}: ChronicleDetailFieldProps) {
  const { t } = useTranslation();
  // CodexContentEditor は labelable な form control でないため htmlFor では結べない。
  // role=group + aria-labelledby でラベル「詳細」をエディタ領域全体に関連付ける。
  const labelId = useId();
  // 最新のシリアライズ済み content を保持し、autosave が stale を書かないようにする。
  const contentRef = useRef(event.detail ?? "");
  const loadedVersionRef = useRef(event.version);
  const detailDirtyRef = useRef(false);
  const editGenerationRef = useRef(0);
  const editorInstanceIdRef = useRef(createEditorInstanceId("event-mini"));
  const [reloadToken, setReloadToken] = useState(0);
  const documentKey = useMemo<DocumentKey>(
    () => ({ kind: "chronicle-event", id: event.id }),
    [event.id],
  );
  const documentStateKey = externalDocumentStateKey(documentKey);
  const externalReloadNonce = useExternalWriteStore(
    (state) => state.reloadNonce[documentStateKey] ?? 0,
  );
  const hasExternalConflict = useExternalWriteStore((state) =>
    state.conflicts.some(
      (conflict) =>
        externalDocumentStateKey(conflict.documentKey ?? conflict.sceneId) ===
        documentStateKey,
    ),
  );
  const seenExternalReloadRef = useRef(externalReloadNonce);

  const applyPersistedReload = useCallback(
    (version: number, detail: string | null) => {
      loadedVersionRef.current = version;
      contentRef.current = detail ?? "";
      detailDirtyRef.current = false;
      setReloadToken((token) => token + 1);
      useEditorSessionStore
        .getState()
        .setDocumentDirty(documentKey, false, editorInstanceIdRef.current);
      useExternalWriteStore.getState().shiftConflict(documentKey);
    },
    [documentKey],
  );

  const markDirty = useCallback(() => {
    editGenerationRef.current += 1;
    detailDirtyRef.current = true;
    useEditorSessionStore
      .getState()
      .setDocumentDirty(documentKey, true, editorInstanceIdRef.current);
  }, [documentKey]);

  useEffect(() => {
    const instanceId = editorInstanceIdRef.current;
    const handlePeerSave = (binding: LoadedEditorBinding) => {
      if (binding.kind === "chronicle-event" && binding.id === event.id) {
        loadedVersionRef.current = Math.max(
          loadedVersionRef.current,
          binding.loadedVersion,
        );
      }
    };
    registerPersistedBindingHandler(documentKey, instanceId, handlePeerSave);
    return () => {
      unregisterPersistedBindingHandler(
        documentKey,
        instanceId,
        handlePeerSave,
      );
      useEditorSessionStore
        .getState()
        .setDocumentDirty(documentKey, false, instanceId);
    };
  }, [documentKey, event.id]);

  useEffect(() => {
    if (seenExternalReloadRef.current === externalReloadNonce) return;
    seenExternalReloadRef.current = externalReloadNonce;
    let cancelled = false;
    void getEvent(getCurrentProjectId(), event.id)
      .then((latest) => {
        if (!latest) {
          if (!cancelled) {
            detailDirtyRef.current = false;
            useEditorSessionStore
              .getState()
              .setDocumentDirty(
                documentKey,
                false,
                editorInstanceIdRef.current,
              );
            useExternalWriteStore.getState().shiftConflict(documentKey);
          }
          return;
        }
        if (!cancelled) applyPersistedReload(latest.version, latest.detail);
      })
      .catch((error) => {
        if (cancelled) return;
        debugLog.warn(
          "ChronicleDetail",
          "persisted reload failed",
          errorDetail(error),
        );
        toast.error(
          t("autoSave.failed", {
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [applyPersistedReload, documentKey, event.id, externalReloadNonce, t]);

  const save = useCallback(async () => {
    const saveGeneration = editGenerationRef.current;
    const result = await onPatchDetail(
      contentRef.current,
      loadedVersionRef.current,
    );
    loadedVersionRef.current = result.version;
    announcePersistedBinding(documentKey, editorInstanceIdRef.current, {
      kind: "chronicle-event",
      id: event.id,
      loadedVersion: result.version,
    });
    if (editGenerationRef.current === saveGeneration) {
      detailDirtyRef.current = false;
      useEditorSessionStore
        .getState()
        .setDocumentDirty(documentKey, false, editorInstanceIdRef.current);
    }
  }, [documentKey, event.id, onPatchDetail]);

  const { schedule, cancel, pause, resume, flush } = useAutoSave(save, 2000);

  useEffect(() => {
    if (hasExternalConflict) pause();
    else resume();
  }, [hasExternalConflict, pause, resume]);

  const handleKeepMine = useCallback(async () => {
    const latestVersion = await getEventVersion(
      getCurrentProjectId(),
      event.id,
    );
    if (latestVersion === null) {
      throw new Error(`Event '${event.id}' no longer exists`);
    }
    loadedVersionRef.current = latestVersion;
    onResolveExternalVersion?.(latestVersion);
    if (!detailDirtyRef.current) return;
    resume();
    schedule();
    await flush();
  }, [event.id, flush, onResolveExternalVersion, resume, schedule]);

  const handleReload = useCallback(() => {
    cancel();
  }, [cancel]);

  const handleContentChange = useCallback(
    (content: string) => {
      contentRef.current = content;
      markDirty();
      schedule();
    },
    [markDirty, schedule],
  );

  // EditorPane タブ側の編集を contentRef に反映（次回 autosave での巻き戻し防止）。
  const handleExternalSync = useCallback((content: string) => {
    contentRef.current = content;
  }, []);

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5"
    >
      <ExternalEditConflictBanner
        nodeId={event.id}
        documentKey={documentKey}
        editorInstanceId={editorInstanceIdRef.current}
        onKeepMine={handleKeepMine}
        onReload={handleReload}
      />
      <div className="flex items-center justify-between">
        <span id={labelId} className="text-xs font-medium text-foreground">
          {t("chronicle.detail.label", "詳細")}
        </span>
        <button
          type="button"
          onClick={() =>
            openEditorDocument(
              {
                target: {
                  kind: "chronicle-event",
                  documentId: event.id,
                  label: event.title,
                },
                mode: "pinned",
                revealEditor: true,
                focusEditor: false,
                syncSceneContext: false,
              },
              defaultEditorNavigationPorts,
            )
          }
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          title={t("chronicle.detail.openInEditor", "エディタで開く")}
        >
          <ExternalLink className="h-3 w-3" />
          {t("chronicle.detail.openInEditor", "エディタで開く")}
        </button>
      </div>
      <CodexContentEditor
        key={`${event.id}-${reloadToken}`}
        content={contentRef.current}
        onContentChange={handleContentChange}
        entryId={event.id}
        entryKind="chronicle_event"
        onExternalSync={handleExternalSync}
      />
    </div>
  );
}
