import type { WebContents } from "electron";

import { MASTRA_AGENT_TURN_PROGRESS_EVENT } from "../shared/ipcContract.js";
import {
  parseMastraAgentTurnProgressPayload,
  type MastraAgentTurnProgressEvent,
} from "../shared/mastraAgentTurnWire.js";
import { sendMainEventToWindow } from "./events.js";

/** Bind progress delivery to the renderer that started this turn. */
export function createMastraAgentTurnProgressSender(
  sender: Pick<WebContents, "id">,
  turnId: string,
): { send(event: MastraAgentTurnProgressEvent): void } {
  const webContentsId = sender.id;
  let sequence = 0;

  return {
    send(event) {
      const parsed = parseMastraAgentTurnProgressPayload({
        turnId,
        sequence: sequence + 1,
        event,
      });
      if (!parsed.ok) return;
      sequence = parsed.value.sequence;
      try {
        sendMainEventToWindow(
          webContentsId,
          MASTRA_AGENT_TURN_PROGRESS_EVENT,
          parsed.value,
        );
      } catch {
        // The turn owner handles cancellation; a vanished renderer only drops progress.
      }
    },
  };
}
