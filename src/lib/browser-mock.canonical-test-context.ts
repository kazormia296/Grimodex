import type { PersistentBrowserMock } from "./browser-mock";

const CANONICAL_COMMANDS = new Set([
  "tree_node_create",
  "tree_node_delete",
  "tree_node_patch",
  "agent_codex_create",
  "agent_codex_update",
  "agent_codex_delete",
  "codex_create",
  "codex_update",
  "codex_delete",
  "agent_codex_mutate",
  "codex_mutate",
  "foreshadow_create",
  "foreshadow_update",
  "foreshadow_delete",
  "foreshadow_update_setup",
  "foreshadow_setup_create_ai",
  "foreshadow_resolve_orphan",
  "foreshadow_link_codex",
  "foreshadow_unlink_codex",
  "foreshadow_set_setup_strength",
  "foreshadow_save_anchors_for_scene",
  "plot_thread_create",
  "plot_thread_update",
  "plot_thread_delete",
  "plot_thread_link_create",
  "plot_thread_link_update",
  "plot_thread_link_delete",
  "plot_thread_branch_create",
  "plot_thread_branch_update",
  "plot_thread_branch_delete",
  "plot_thread_move_marker_bundle",
  "plot_thread_restore_snapshot",
  "plot_thread_delete_snapshot",
]);

const PLOT_UPDATE_COMMANDS = new Set([
  "plot_thread_update",
  "plot_thread_link_update",
  "plot_thread_branch_update",
]);

const PLOT_DELETE_COMMANDS = new Set([
  "plot_thread_delete",
  "plot_thread_link_delete",
  "plot_thread_branch_delete",
]);

const PLOT_COMMANDS = new Set(
  [...CANONICAL_COMMANDS].filter((command) => command.startsWith("plot_")),
);

const FORESHADOW_PATCH_COMMANDS = new Set([
  "foreshadow_update",
  "foreshadow_update_setup",
]);

const FORESHADOW_FLAT_COMMANDS = new Set(["foreshadow_setup_create_ai"]);

const FORESHADOW_CHILD_PAYLOAD_COMMANDS = new Set([
  "foreshadow_resolve_orphan",
  "foreshadow_link_codex",
  "foreshadow_unlink_codex",
  "foreshadow_set_setup_strength",
  "foreshadow_save_anchors_for_scene",
]);

/**
 * Upgrade legacy direct BrowserMock fixtures to the production canonical-write
 * contract. Product callers do not use this helper; their typed APIs already
 * supply the same identity fields.
 */
export function withCanonicalWriterTestContext(
  mock: PersistentBrowserMock,
): PersistentBrowserMock {
  const invoke = mock.invoke.bind(mock);
  mock.invoke = <T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    if (!CANONICAL_COMMANDS.has(command)) return invoke<T>(command, args);
    const payloadSource =
      FORESHADOW_PATCH_COMMANDS.has(command) ||
      PLOT_UPDATE_COMMANDS.has(command)
        ? args.patch
        : FORESHADOW_FLAT_COMMANDS.has(command)
          ? args
          : FORESHADOW_CHILD_PAYLOAD_COMMANDS.has(command)
            ? (args.payload ?? args)
            : PLOT_DELETE_COMMANDS.has(command)
              ? (args.payload ?? args)
              : args.payload;
    const payload =
      payloadSource &&
      typeof payloadSource === "object" &&
      !Array.isArray(payloadSource)
        ? (payloadSource as Record<string, unknown>)
        : command === "foreshadow_delete" || PLOT_DELETE_COMMANDS.has(command)
          ? args
          : {};
    const requestId =
      typeof payload.requestId === "string" && payload.requestId.length > 0
        ? payload.requestId
        : (command === "agent_codex_create" ||
              command === "codex_create" ||
              command === "foreshadow_create" ||
              command === "plot_thread_create" ||
              command === "plot_thread_link_create" ||
              command === "plot_thread_branch_create") &&
            typeof payload.entryId === "string" &&
            payload.entryId.length > 0
          ? payload.entryId
          : (command === "foreshadow_create" ||
                command === "plot_thread_create" ||
                command === "plot_thread_link_create" ||
                command === "plot_thread_branch_create") &&
              typeof payload.id === "string" &&
              payload.id.length > 0
            ? payload.id
            : crypto.randomUUID();
    const canonicalPayload = {
      requestId,
      projectId:
        typeof payload.projectId === "string" && payload.projectId.length > 0
          ? payload.projectId
          : "default-project",
      sessionId:
        typeof payload.sessionId === "string" && payload.sessionId.length > 0
          ? payload.sessionId
          : "browser-canonical-test-session",
      eventUid:
        typeof payload.eventUid === "string" && payload.eventUid.length > 0
          ? payload.eventUid
          : requestId,
      origin:
        typeof payload.origin === "string"
          ? payload.origin
          : command === "plot_thread_restore_snapshot"
            ? "restore"
            : command.startsWith("foreshadow_") ||
                PLOT_COMMANDS.has(command) ||
                payload.surface === "manual"
              ? "human"
              : "ai-apply",
      originalTransactionId:
        payload.originalTransactionId === undefined
          ? null
          : payload.originalTransactionId,
      ...(command.startsWith("foreshadow_")
        ? {}
        : {
            undoJournalId:
              payload.undoJournalId === undefined
                ? null
                : payload.undoJournalId,
          }),
      ...payload,
    };
    if (
      FORESHADOW_PATCH_COMMANDS.has(command) ||
      PLOT_UPDATE_COMMANDS.has(command)
    ) {
      return invoke<T>(command, { ...args, patch: canonicalPayload });
    }
    if (FORESHADOW_FLAT_COMMANDS.has(command)) {
      return invoke<T>(command, canonicalPayload);
    }
    if (FORESHADOW_CHILD_PAYLOAD_COMMANDS.has(command)) {
      return invoke<T>(command, { payload: canonicalPayload });
    }
    if (PLOT_DELETE_COMMANDS.has(command)) {
      return invoke<T>(command, { payload: canonicalPayload });
    }
    return invoke<T>(command, { ...args, payload: canonicalPayload });
  };
  return mock;
}
