import { describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  PRODUCT_JOURNEY_AI_ENV,
  PRODUCT_JOURNEY_AI_VERSION,
  PRODUCT_JOURNEY_AUTHORITY_EARLY,
  PRODUCT_JOURNEY_AUTHORITY_LATE,
  shouldUseProductJourneyAi,
  wrapBackendForProductJourneyAi,
} from "./productJourneyAi.js";

function backendStub() {
  const events = vi.fn();
  const dbExecute = vi.fn(function (this: { identity: string }) {
    return Promise.resolve(this.identity);
  });
  const backend = {
    identity: "native-backend",
    dbExecute,
    onEvent: vi.fn((sink: (...args: unknown[]) => unknown) => {
      events.mockImplementation(sink);
    }),
  } as unknown as NapiBackendLike & { identity: string };
  return { backend, dbExecute, events };
}

describe("product journey AI backend", () => {
  it("is limited to an exact non-packaged runner environment", () => {
    expect(
      shouldUseProductJourneyAi({
        isPackaged: false,
        env: { [PRODUCT_JOURNEY_AI_ENV]: PRODUCT_JOURNEY_AI_VERSION },
      }),
    ).toBe(true);
    expect(
      shouldUseProductJourneyAi({
        isPackaged: true,
        env: { [PRODUCT_JOURNEY_AI_ENV]: PRODUCT_JOURNEY_AI_VERSION },
      }),
    ).toBe(false);
    expect(
      shouldUseProductJourneyAi({
        isPackaged: false,
        env: { [PRODUCT_JOURNEY_AI_ENV]: "1" },
      }),
    ).toBe(false);
  });

  it("keeps native methods bound while replacing the provider stream", async () => {
    vi.useFakeTimers();
    try {
      const { backend, dbExecute } = backendStub();
      const wrapped = wrapBackendForProductJourneyAi(backend, true);
      expect(wrapped).not.toBeNull();
      expect(await wrapped!.dbExecute("", [], "all")).toBe("native-backend");
      expect(dbExecute).toHaveBeenCalledOnce();

      const received: Array<{ channel: string; payload: unknown }> = [];
      wrapped!.onEvent((channel, payload) => {
        received.push({
          channel: String(channel),
          payload: JSON.parse(String(payload)),
        });
      });
      const stream = wrapped!.sendChatMessageStream(
        { messages: [{ role: "user", content: "authority" }] },
        {},
        "",
      );
      await vi.advanceTimersByTimeAsync(0);
      wrapped!.abortChatStream();
      await vi.runAllTimersAsync();
      await stream;

      expect(received).toEqual([
        {
          channel: "chat:stream-chunk",
          payload: {
            delta: PRODUCT_JOURNEY_AUTHORITY_EARLY,
            block_type: "text",
          },
        },
        {
          channel: "chat:stream-chunk",
          payload: {
            delta: PRODUCT_JOURNEY_AUTHORITY_LATE,
            block_type: "text",
          },
        },
        {
          channel: "chat:stream-done",
          payload: {
            stop_reason: "stopped",
            input_tokens: 1,
            output_tokens: 4,
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the native backend unchanged when disabled", () => {
    const { backend } = backendStub();
    expect(wrapBackendForProductJourneyAi(backend, false)).toBe(backend);
    expect(wrapBackendForProductJourneyAi(null, true)).toBeNull();
  });
});
