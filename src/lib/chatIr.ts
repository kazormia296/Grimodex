/**
 * The renderer's one call of the chat IR route (S1-B, DR-CHATIR-S1-32).
 *
 * `selectChatAgentIr` never throws for a failure of the call: it answers with an
 * outcome that says who answered. A status that Native returned
 * (`origin: "native"`) and a status that only this wrapper makes
 * (`origin: "renderer"`) are kept apart, because a name such as
 * `no-current-scene` exists on both sides and means a different thing.
 *
 * Nothing here is reached while `CHAT_AGENT_IR_ENABLED` is `false`: no product
 * source imports this module statically. The executor, in PR-B2, loads it with
 * `await import("@/lib/chatIr")` inside the constant's branch.
 *
 * The query, the summaries, the quotes and the candidate event IDs are never logged, and the message of
 * an error is never returned: the caller gets a status name only.
 */
import {
  CHAT_AGENT_IR_QUERY_UTF16_MAX,
  isChronicleEventIdList,
  parseChatAgentIrResponse,
  type ChatAgentIrItem,
  type ChatAgentIrRequest,
  type ChatAgentIrStatus,
} from "@/../electron/shared/chatAgentIrWire";
import {
  invoke,
  isD2aEgressDenied,
  isIpcLifecycleCancellation,
} from "@/lib/tauri";

/** A status that only the renderer makes. */
export type ChatIrRendererStatus =
  /** The constant is `false`; nothing is called (year table only). */
  | "disabled"
  /** The entry is a sub-agent; reached by tests only, it is structural. */
  | "sub-agent"
  /** No current Scene (not Native's status of the same name). */
  | "no-current-scene"
  /** Empty, only white space, or over 500 UTF-16 code units. */
  | "query-invalid"
  /** The workspace path (or the project) is missing. */
  | "no-workspace"
  /** The cumulative limit of the turn is spent. */
  | "turn-limit"
  /** Not even one IR item fits the cap. */
  | "cap-exceeded"
  /** The route is closed (Main's or Native's gate). */
  | "gate-closed"
  /** Restricted profile refused the command. */
  | "egress-denied"
  /** A lifecycle cancellation or a workspace switch. */
  | "ipc-cancelled"
  /** The caller timeout (20 s) ended the wait. */
  | "caller-timeout"
  /** Any other failure of the IPC. */
  | "ipc-error"
  /** The answer is not an answer of this route. */
  | "invalid-response";

export type ChatIrOutcome =
  | {
      readonly kind: "answered";
      readonly origin: "native";
      readonly status: ChatAgentIrStatus;
      readonly success: boolean;
      readonly items: readonly ChatAgentIrItem[];
      /** revisionId -> eventId, for the revisions of `items` (a subset). */
      readonly eventIds: Readonly<Record<string, string>>;
      /**
       * A subset of the candidates sent (checked here), on a success; `null`
       * when Native did not judge (any other status).
       */
      readonly excludedEventIds: readonly string[] | null;
    }
  | {
      readonly kind: "not-answered";
      readonly origin: "renderer";
      readonly status: ChatIrRendererStatus;
    };

const COMMAND = "chat_agent_ir_select";
const GATE_CLOSED_MARKER = "CHAT_IR_GATE_CLOSED";

function notAnswered(status: ChatIrRendererStatus): ChatIrOutcome {
  return { kind: "not-answered", origin: "renderer", status };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The checks Main makes (`IPC_INVALID_REQUEST`) are made here first, so that a
 * bad input is a status and not an error of Main. The order is the order of the
 * statuses in the design. A missing `projectId` has no status of its own; it
 * is reported as `no-workspace` (provisional, DR-CHATIR-S1-32).
 */
function preflight(request: ChatAgentIrRequest): ChatIrRendererStatus | null {
  if (!isNonEmpty(request.currentSceneId)) return "no-current-scene";
  if (
    typeof request.query !== "string" ||
    request.query.trim().length === 0 ||
    request.query.length > CHAT_AGENT_IR_QUERY_UTF16_MAX
  ) {
    return "query-invalid";
  }
  if (
    !isNonEmpty(request.expectedWorkspacePath) ||
    !isNonEmpty(request.projectId)
  ) {
    return "no-workspace";
  }
  // The bounds Main and Native check too. A bad list is a programming error of
  // the caller: it ends here as an `ipc-error`, without an IPC call.
  if (!isChronicleEventIdList(request.chronicleEventIds)) return "ipc-error";
  return null;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Maps a failure of `invoke` to a status. `code` is read first. The gate's
 * message is the one text check, kept as `includes` because the prefix Native's
 * error gets on its way here is not confirmed (DR-CHATIR-S1-32); the other
 * markers of the legacy error text are never read here.
 */
function failureStatus(error: unknown): ChatIrRendererStatus {
  const code = codeOf(error);
  if (code === "IPC_TIMEOUT") return "caller-timeout";
  if (messageOf(error).includes(GATE_CLOSED_MARKER)) return "gate-closed";
  if (isD2aEgressDenied(error)) return "egress-denied";
  if (
    isIpcLifecycleCancellation(error) ||
    code === "WORKSPACE_SWITCHING" ||
    code === "NO_WORKSPACE_OPEN"
  ) {
    return "ipc-cancelled";
  }
  return "ipc-error";
}

export async function selectChatAgentIr(
  args: ChatAgentIrRequest,
): Promise<ChatIrOutcome> {
  const refused = preflight(args);
  if (refused !== null) return notAnswered(refused);

  // One copy, taken before the call: the send and the subset check below both
  // use it, so the caller's array is not read again after the `await`.
  const chronicleEventIds = [...args.chronicleEventIds];
  let raw: unknown;
  try {
    // Exactly the five keys of the request; Native has no `limit`.
    raw = await invoke<unknown>(COMMAND, {
      query: args.query,
      projectId: args.projectId,
      expectedWorkspacePath: args.expectedWorkspacePath,
      currentSceneId: args.currentSceneId,
      chronicleEventIds: chronicleEventIds,
    });
  } catch (error) {
    try {
      return notAnswered(failureStatus(error));
    } catch {
      // An error object whose own getters throw is still an `ipc-error`.
      return notAnswered("ipc-error");
    }
  }

  const answer = parseChatAgentIrResponse(raw);
  if (answer === null) return notAnswered("invalid-response");
  // What Native excludes can only be a part of what was sent. An ID that was
  // not a candidate is a drift (or a hostile answer): the caller must not drop
  // an event it never asked about.
  if (answer.excludedEventIds !== null) {
    const sent = new Set(chronicleEventIds);
    if (!answer.excludedEventIds.every((id) => sent.has(id))) {
      return notAnswered("invalid-response");
    }
  }
  return {
    kind: "answered",
    origin: "native",
    status: answer.status,
    success: answer.success,
    items: answer.items,
    eventIds: answer.eventIds,
    excludedEventIds: answer.excludedEventIds,
  };
}
