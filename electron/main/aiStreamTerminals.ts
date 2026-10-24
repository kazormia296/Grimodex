/**
 * Typed terminals of the AI streams in flight when a profile activation
 * reaches stage 2 (NIR-1 DA-2; K3/2 "activation の途中の AI 処理" 1, D-10 (a);
 * DR-DA2-18 in `docs/plans/nir1-lane-decisions/da2-decisions.md`).
 *
 * From stage 2 the profile gate drops every `*:stream-*` and `codex-app:`
 * event, so a stream the renderer is still listening to would otherwise
 * never end. The router records each stream it forwarded (after admission)
 * per sender, and at stage 2 this module sends each one, once, the existing
 * terminal shape with a closed code and no plaintext. The renderer's own
 * terminal handling (one `transportTerminal` mark per stream) ends the UI and
 * writes the audit terminal; a later settle of the invoke is ignored by the
 * same mark, so nothing is written twice. Main writes no audit.
 */
import { PROFILE_ACTIVATION_STOPPED_MESSAGE } from "./profileEgress.js";

/** The commands whose events end with one of the terminals below. */
const STREAM_ERROR_CHANNEL_BY_COMMAND = {
  send_chat_message_stream: "chat:stream-error",
  send_inline_ai_stream: "inline-ai:stream-error",
  send_cli_chat_stream: "cli:stream-error",
} as const;

export const CODEX_TURN_COMMAND = "codex_app_start_turn";
const CODEX_EVENT_CHANNEL = "codex-app:event";
/** Codex turns run on after their start result; keep the newest ones only. */
export const MAX_TRACKED_CODEX_TURNS = 64;

export type AiStreamTerminalChannel =
  | (typeof STREAM_ERROR_CHANNEL_BY_COMMAND)[keyof typeof STREAM_ERROR_CHANNEL_BY_COMMAND]
  | typeof CODEX_EVENT_CHANNEL;

export type AiStreamTerminalPayload =
  | { readonly streamId: string; readonly message: string }
  | {
      readonly projectId: string;
      readonly sessionId: string;
      readonly grimodexTurnId: string;
      readonly event: {
        readonly type: "turn-error";
        readonly message: string;
        readonly code: "D2A_EGRESS_DENIED";
        readonly retryable: false;
      };
    };

export type AiStreamTerminalSend = (
  webContentsId: number,
  channel: AiStreamTerminalChannel,
  payload: AiStreamTerminalPayload,
) => void;

export interface AiStreamTerminalTracker {
  /**
   * Records a stream forwarded for `senderId`. Returns the release to call
   * when the invoke settles, or null when the command is not a tracked
   * stream (or its ids are missing).
   */
  track(
    senderId: number,
    command: string,
    args: Record<string, unknown>,
  ): (() => void) | null;
  /** Stage 2: one terminal to every recorded stream, then forgets them. */
  terminateAll(): number;
}

interface TrackedStream {
  readonly senderId: number;
  readonly channel: AiStreamTerminalChannel;
  readonly payload: AiStreamTerminalPayload;
}

function idString(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
    ? value
    : null;
}

export function createAiStreamTerminalTracker(options: {
  readonly send: AiStreamTerminalSend;
}): AiStreamTerminalTracker {
  const streams = new Set<TrackedStream>();
  const codexTurns: TrackedStream[] = [];

  return {
    track(senderId, command, args) {
      if (Object.hasOwn(STREAM_ERROR_CHANNEL_BY_COMMAND, command)) {
        const streamId = idString(args.streamId);
        if (streamId === null) return null;
        const entry: TrackedStream = {
          senderId,
          channel:
            STREAM_ERROR_CHANNEL_BY_COMMAND[
              command as keyof typeof STREAM_ERROR_CHANNEL_BY_COMMAND
            ],
          payload: { streamId, message: PROFILE_ACTIVATION_STOPPED_MESSAGE },
        };
        streams.add(entry);
        return () => {
          streams.delete(entry);
        };
      }
      if (command === CODEX_TURN_COMMAND) {
        const projectId = idString(args.projectId);
        const sessionId = idString(args.sessionId);
        const grimodexTurnId = idString(args.grimodexTurnId);
        if (
          projectId === null ||
          sessionId === null ||
          grimodexTurnId === null
        ) {
          return null;
        }
        codexTurns.push({
          senderId,
          channel: CODEX_EVENT_CHANNEL,
          payload: {
            projectId,
            sessionId,
            grimodexTurnId,
            event: {
              type: "turn-error",
              message: PROFILE_ACTIVATION_STOPPED_MESSAGE,
              code: "D2A_EGRESS_DENIED",
              retryable: false,
            },
          },
        });
        if (codexTurns.length > MAX_TRACKED_CODEX_TURNS) codexTurns.shift();
        // The turn outlives its start result; it stays recorded. A terminal
        // for a turn that already ended is ignored by the renderer.
        return () => undefined;
      }
      return null;
    },

    terminateAll() {
      const targets = [...streams, ...codexTurns];
      streams.clear();
      codexTurns.length = 0;
      for (const target of targets) {
        try {
          options.send(target.senderId, target.channel, target.payload);
        } catch (error) {
          console.warn(
            `[ai-stream-terminals] terminal could not be sent: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return targets.length;
    },
  };
}
